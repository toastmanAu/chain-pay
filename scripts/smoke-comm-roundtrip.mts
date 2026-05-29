#!/usr/bin/env -S npx tsx
/**
 * Phase 2.7a smoke: two-install comm roundtrip on CKB testnet.
 *
 * Run from the WORKSPACE ROOT (chain-pay/.worktrees/phase-2-7a):
 *
 *   ROLE A (operator/sender):
 *     COMM_ROLE=A \
 *     COMM_IDENTITY_DIR=/tmp/chainpay-smoke-a \
 *     SMOKE_PASSPHRASE=secret-a \
 *     npx tsx scripts/smoke-comm-roundtrip.mts
 *
 *   ROLE B (signer/receiver) — after A prints its address:
 *     COMM_ROLE=B \
 *     COMM_IDENTITY_DIR=/tmp/chainpay-smoke-b \
 *     SMOKE_PASSPHRASE=secret-b \
 *     PEER_A_ADDRESS=ckt1... \
 *     npx tsx scripts/smoke-comm-roundtrip.mts
 *
 *   Then re-run A with PEER_B_ADDRESS=ckt1... set.
 *
 * DRY-RUN (unfunded wallet — exits 3 after generating identity):
 *   COMM_ROLE=A \
 *   COMM_IDENTITY_DIR=/tmp/chainpay-smoke-a-dry \
 *   SMOKE_PASSPHRASE=dryrun \
 *   npx tsx scripts/smoke-comm-roundtrip.mts
 *
 *   Expected: prints the generated address and exits 3 with "FUND ... with at least 70 CKB".
 *   This verifies the wiring up to the chain step without needing funded testnet keys.
 *
 * Environment variables:
 *   COMM_ROLE           — "A" or "B" (required)
 *   COMM_IDENTITY_DIR   — directory to store the encrypted identity file (required)
 *   SMOKE_PASSPHRASE    — AES-GCM passphrase for the PassphraseSafeStorage provider (required;
 *                         the smoke never runs inside Electron so safe-storage.ts falls back to
 *                         PassphraseSafeStorage when SMOKE_PASSPHRASE is set)
 *   PEER_B_ADDRESS      — CKB testnet address for Role B (required by A when sending)
 *   PEER_A_ADDRESS      — CKB testnet address for Role A (required by B when replying)
 *   COMM_CKB_RPC_URL    — CKB testnet RPC URL (default: https://testnet.ckb.dev/rpc)
 *
 * Import strategy:
 *   We run source TypeScript directly via `npx tsx` rather than importing the built
 *   out/main/index.js.  The main bundle is an Electron entry point — it calls app.whenReady()
 *   and never exports the comm functions.  Using tsx with the workspace root as cwd resolves
 *   node_modules from the hoisted chain-pay workspace (which holds @ckb-ccc/core, cemp-pq,
 *   @noble/post-quantum, etc.) while the relative import path reaches the source files in
 *   apps/desktop/electron/main/.
 *
 * Idempotency:
 *   - Identity generation is skipped if COMM_IDENTITY_DIR already contains comm-identity.enc.
 *   - Profile publication is skipped if resolveProfile() already resolves the address.
 *   - Re-running A or B without state changes is safe.
 *
 * Cleanup (Phase 2.7a "optional" per spec):
 *   Notification cells and surplus capacity are NOT reclaimed in this first cut.
 *   The comm wallet will accumulate small notification cells across smoke runs.
 *   Full self-clean is deferred to Phase 2.7b.
 */

import { ccc } from "@ckb-ccc/core";
import {
  exists,
  publicInfo,
  generateIdentity,
  publishProfile,
  sendMessage,
  decryptIncoming,
  resolveProfile,
} from "../apps/desktop/electron/main/comm-transport-service.ts";

// ── Envelope codec (matches the shape the ChainPay UI will use) ───────────────

const ENVELOPE_VERSION = 0x01;
const KIND_PACKET = 0x01;
const KIND_SIGNATURE = 0x02;
const KIND_ACK = 0x03;

function encodeEnvelope(
  kindByte: number,
  senderHash: Uint8Array,
  payload: unknown,
): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(22 + json.length);
  out[0] = ENVELOPE_VERSION;
  out[1] = kindByte;
  // senderHash is 20 bytes; used by the receiver as a sender hint.
  out.set(senderHash.slice(0, 20), 2);
  out.set(json, 22);
  return out;
}

interface DecodedEnvelope {
  kind: "packet" | "signature" | "ack" | "unknown";
  senderHash: Uint8Array;
  payload: unknown;
}

function decodeEnvelope(bytes: Uint8Array): DecodedEnvelope {
  if (bytes.length < 22 || bytes[0] !== ENVELOPE_VERSION) {
    throw new Error(`bad envelope: version=${bytes[0]}, length=${bytes.length}`);
  }
  const kindByte = bytes[1];
  const kind: DecodedEnvelope["kind"] =
    kindByte === KIND_PACKET ? "packet"
    : kindByte === KIND_SIGNATURE ? "signature"
    : kindByte === KIND_ACK ? "ack"
    : "unknown";
  const senderHash = bytes.slice(2, 22);
  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes.slice(22)));
  return { kind, senderHash, payload };
}

// ── Fixture payloads ─────────────────────────────────────────────────────────
//
// Phase 2.7b-2 update: txHash is now a realistic 32-byte sighashDigest so the
// fixture matches what an operator-side PayrollBatch.sighashDigest looks like.
// Override via SMOKE_BATCH_SIGHASH=0x… to match a specific in-flight batch
// while manually verifying the auto-match path against a running app.
//
// To verify Phase 2.7b-2's auto-match end-to-end manually:
//   1. Start ChainPay on Role A (operator) with a funded comm wallet.
//   2. Create a PayrollBatch whose sighashDigest equals FIXTURE_BATCH_SIGHASH
//      (or set SMOKE_BATCH_SIGHASH on this script to match the live batch).
//   3. Add Role B as a peer in Settings → Peer book, associated with the
//      multisig slot 0 signer hash.
//   4. Run this smoke as Role B with PEER_A_ADDRESS=<operator address>.
//   5. Watch operator's PayPanel: CommSendSection pill for slot 0 should
//      transition idle → sending → sent on A's send, and partialSigs should
//      auto-populate when B's reply arrives.
//
// The smoke can't observe the React-side auto-match — that's a manual UI
// verification step in the Phase 2.7b-2 acceptance checklist.

const FIXTURE_BATCH_SIGHASH =
  process.env["SMOKE_BATCH_SIGHASH"] ?? `0x${"ab".repeat(32)}`;

const FIXTURE_PACKET = {
  txHash: FIXTURE_BATCH_SIGHASH,
  treasuryAddress: "ckt1qfixturetreasury",
  expiresAt: 9999999999,
  packet: { kind: "transfer", payments: [] as unknown[] },
};

const FIXTURE_SIGNATURE = {
  txHash: FIXTURE_BATCH_SIGHASH,
  slotIndex: 0,
  signature: "0x" + "ab".repeat(65),
};

// ── CKB client (shared) ───────────────────────────────────────────────────────

function makeClient(): ccc.ClientPublicTestnet {
  return new ccc.ClientPublicTestnet({
    url: process.env.COMM_CKB_RPC_URL ?? "https://testnet.ckb.dev/rpc",
  });
}

// ── Smoke steps ───────────────────────────────────────────────────────────────

async function ensureIdentity(): Promise<{ address: string }> {
  if (await exists()) {
    const info = await publicInfo();
    if (!info) throw new Error("identity file exists but publicInfo() returned null");
    console.log("[smoke] using existing identity");
    return { address: info.address };
  }
  console.log("[smoke] generating new ML-DSA-65 + ML-KEM-768 identity...");
  const id = await generateIdentity();
  console.log("[smoke] identity generated");
  return { address: id.address };
}

async function ensureFunded(address: string): Promise<void> {
  const client = makeClient();
  const lock = (await ccc.Address.fromString(address, client)).script;
  const capShannons = await client.getCellsCapacity({
    script: lock,
    scriptType: "lock",
    scriptSearchMode: "exact",
  });
  // getCellsCapacity returns a Hex string (0x-prefixed).
  const ckb = Number(BigInt(capShannons ?? "0x0") / 100_000_000n);
  if (ckb < 70) {
    console.error(`[smoke] FUND ${address} with at least 70 CKB (current: ${ckb} CKB)`);
    console.error(`[smoke] Use the CKB testnet faucet: https://faucet.nervos.org/`);
    process.exit(3);
  }
  console.log(`[smoke] funded: ${ckb} CKB`);
}

async function ensureProfilePublished(address: string): Promise<void> {
  try {
    await resolveProfile(address);
    console.log("[smoke] profile already published — skipping");
    return;
  } catch {
    // Not found — publish it.
  }
  console.log("[smoke] publishing Profile Cell...");
  const role = process.env["COMM_ROLE"] ?? "?";
  const bundle = await publishProfile({ displayName: `smoke-${role}` });
  console.log(`[smoke] profile tx built: ${bundle.txHash}`);
  const client = makeClient();
  const txBytes = Uint8Array.from(Buffer.from(bundle.txBytes.slice(2), "hex"));
  const tx = ccc.Transaction.fromBytes(txBytes);
  await client.sendTransaction(tx);
  console.log("[smoke] profile broadcast — waiting ~15 s for confirmation...");
  await sleep(15_000);
}

/**
 * Poll for incoming notification cells on `ownAddress`, decrypt each one,
 * and return the first envelope whose kind matches `expectedKind`.
 *
 * Notification cells are plain CKB cells locked to the recipient address with no
 * type script and empty output data.  The encrypted message lives in the *Message
 * Cell* — we need to find it via the Message OutPoint.
 *
 * The CEMP-PQ protocol splits a message across two outputs in the same tx:
 *   - outputs[0] = Message Cell  (locked to sender, holds the encrypted blob)
 *   - outputs[1] = Notification Cell  (locked to recipient, holds a 52-byte
 *                                     MessagePointer molecule)
 * We watch the recipient's lock for non-empty cells (the notifications),
 * then dereference each one to its message cell. Since sender and notification
 * are always in the same tx today, we use the notification's own OutPoint.txHash
 * and read outputs[0] for the encrypted blob — the pointer's embedded tx_hash
 * field can't be self-referential (writing it would change the tx hash), so the
 * receive-side convention is "same-tx, message at index 0."
 */
async function pollIncoming(
  ownAddress: string,
  expectedKind: "packet" | "signature",
  maxWaitSec = 180,
): Promise<unknown> {
  const client = makeClient();
  const ownLock = (await ccc.Address.fromString(ownAddress, client)).script;
  const deadline = Date.now() + maxWaitSec * 1000;
  const seen = new Set<string>();
  let tick = 0;

  while (Date.now() < deadline) {
    const resp = await client.findCellsPaged(
      { script: ownLock, scriptType: "lock", scriptSearchMode: "exact" },
      "asc",
      50n,
    );
    for (const c of resp.cells) {
      const key = `${c.outPoint.txHash}:${c.outPoint.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const data = c.outputData;
      if (!data || data === "0x" || data.length < 4) continue;

      // Notification cells carry a 52-byte MessagePointer. Dereference to the
      // message cell at outputs[0] of the same tx (same-tx convention).
      try {
        const decryptedHex = await decryptIncoming({
          txHash: c.outPoint.txHash,
          index: 0,
        });
        const bytes = Uint8Array.from(Buffer.from(decryptedHex.slice(2), "hex"));
        const decoded = decodeEnvelope(bytes);
        if (decoded.kind === expectedKind) {
          console.log(`[smoke] received ${expectedKind} envelope`);
          return decoded.payload;
        }
      } catch {
        // Not for us or not a valid envelope — skip.
      }
    }

    tick++;
    if (tick % 6 === 0) {
      const remainSec = Math.ceil((deadline - Date.now()) / 1000);
      console.log(`[smoke] still waiting for ${expectedKind}... (${remainSec}s left)`);
    }
    await sleep(5_000);
  }

  throw new Error(`timeout after ${maxWaitSec}s waiting for ${expectedKind} envelope`);
}

/**
 * Poll for an ack envelope on `ownAddress` that references `expectedTxHash`.
 *
 * Role A uses this after broadcasting a packet to wait for B's auto-ack before
 * sending the signature reply. Same dereference convention as pollIncoming:
 * notifications at any output index, message cell at outputs[0] of the same tx.
 */
async function waitForAckOn(
  ownAddress: string,
  expectedTxHash: string,
  maxWaitSec = 60,
): Promise<void> {
  const client = makeClient();
  const ownLock = (await ccc.Address.fromString(ownAddress, client)).script;
  const deadline = Date.now() + maxWaitSec * 1000;
  const seen = new Set<string>();
  while (Date.now() < deadline) {
    const resp = await client.findCellsPaged(
      { script: ownLock, scriptType: "lock", scriptSearchMode: "exact" },
      "asc",
      50n,
    );
    for (const c of resp.cells) {
      const key = `${c.outPoint.txHash}:${c.outPoint.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!c.outputData || c.outputData === "0x") continue;
      try {
        const decryptedHex = await decryptIncoming({
          txHash: c.outPoint.txHash,
          index: 0,
        });
        const bytes = Uint8Array.from(Buffer.from(decryptedHex.slice(2), "hex"));
        const decoded = decodeEnvelope(bytes);
        const body = decoded.payload as { txHash?: string };
        if (decoded.kind === "ack" && body.txHash === expectedTxHash) {
          console.log(`[smoke] ack received for ${expectedTxHash}`);
          return;
        }
      } catch {
        // skip
      }
    }
    await sleep(5_000);
  }
  throw new Error(`timeout waiting for ack on ${expectedTxHash}`);
}

async function broadcastTx(bundle: { txHash: string; txBytes: string }): Promise<void> {
  const client = makeClient();
  const txBytes = Uint8Array.from(Buffer.from(bundle.txBytes.slice(2), "hex"));
  const tx = ccc.Transaction.fromBytes(txBytes);
  await client.sendTransaction(tx);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Role A: operator sends a batch packet and waits for B's signature ─────────

async function runRoleA(peerBAddress: string): Promise<void> {
  const { address } = await ensureIdentity();
  console.log(`[smoke] Role A address: ${address}`);
  await ensureFunded(address);
  await ensureProfilePublished(address);

  console.log("[smoke] resolving peer B profile...");
  await resolveProfile(peerBAddress);
  console.log("[smoke] peer B profile resolved");

  console.log("[smoke] sending FIXTURE_PACKET to B...");
  const senderHash = new Uint8Array(20); // placeholder — authenticity comes from ML-KEM decryption
  const envelope = encodeEnvelope(KIND_PACKET, senderHash, FIXTURE_PACKET);
  const bundle = await sendMessage(peerBAddress, envelope);
  await broadcastTx(bundle);
  console.log(`[smoke] packet sent: ${bundle.txHash}`);

  if (process.env["SMOKE_SKIP_ACK"] !== "1") {
    console.log("[smoke] waiting for ack from B...");
    await waitForAckOn(address, bundle.txHash);
  } else {
    console.log("[smoke] skipping ack wait (SMOKE_SKIP_ACK=1)");
  }

  console.log("[smoke] waiting for FIXTURE_SIGNATURE reply from B...");
  const sig = await pollIncoming(address, "signature") as typeof FIXTURE_SIGNATURE;

  if (sig.signature !== FIXTURE_SIGNATURE.signature) {
    throw new Error(`signature mismatch — got: ${sig.signature}`);
  }
  console.log(`[smoke] ROUNDTRIP OK — signature verified: ${sig.signature.slice(0, 12)}...`);
}

// ── Role B: signer receives batch packet and replies with a signature ─────────

async function runRoleB(peerAAddress: string): Promise<void> {
  const { address } = await ensureIdentity();
  console.log(`[smoke] Role B address: ${address}`);
  await ensureFunded(address);
  await ensureProfilePublished(address);

  console.log("[smoke] waiting for FIXTURE_PACKET from A...");
  const packet = await pollIncoming(address, "packet") as typeof FIXTURE_PACKET;

  if (packet.txHash !== FIXTURE_PACKET.txHash) {
    throw new Error(`packet mismatch — got txHash: ${packet.txHash}`);
  }
  console.log(`[smoke] packet received: txHash=${packet.txHash}`);

  console.log("[smoke] resolving peer A profile...");
  await resolveProfile(peerAAddress);
  console.log("[smoke] peer A profile resolved");

  console.log("[smoke] sending FIXTURE_SIGNATURE reply to A...");
  const senderHash = new Uint8Array(20);
  const envelope = encodeEnvelope(KIND_SIGNATURE, senderHash, FIXTURE_SIGNATURE);
  const bundle = await sendMessage(peerAAddress, envelope);
  await broadcastTx(bundle);
  console.log(`[smoke] signature sent: ${bundle.txHash}`);
  console.log("[smoke] ROUNDTRIP OK — signature reply broadcast");
}

// ── Entry point ───────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[smoke] error: ${name} is required`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const role = process.env["COMM_ROLE"];
  if (role !== "A" && role !== "B") {
    console.error("[smoke] error: set COMM_ROLE=A or COMM_ROLE=B");
    process.exit(2);
  }

  // Parse --network flag (default: testnet)
  const networkArg = process.argv.find((a) => a.startsWith("--network="));
  const network: "testnet" | "mainnet" = networkArg
    ? (networkArg.split("=")[1] as "testnet" | "mainnet")
    : "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    console.error(`[smoke] error: --network value must be 'testnet' or 'mainnet', got '${network}'`);
    process.exit(2);
  }
  if (network === "mainnet") {
    console.error(
      "[smoke] error: CEMP-PQ contract not deployed on mainnet — smoke roundtrip cannot run",
    );
    process.exit(2);
  }
  console.log(`[smoke] network: ${network}`);

  requireEnv("COMM_IDENTITY_DIR");
  requireEnv("SMOKE_PASSPHRASE");

  if (role === "A") {
    const peerB = process.env["PEER_B_ADDRESS"];
    if (!peerB) {
      // First-run: just generate identity and print the address so the operator
      // can share it with the Role B runner and fund the wallet.
      const { address } = await ensureIdentity();
      console.log(`[smoke] Role A address: ${address}`);
      await ensureFunded(address); // exits 3 if unfunded
      await ensureProfilePublished(address);
      console.log("[smoke] Profile published. Set PEER_B_ADDRESS=<role-B-address> and re-run.");
      process.exit(0);
    }
    await runRoleA(peerB);
  } else {
    const peerA = process.env["PEER_A_ADDRESS"];
    if (!peerA) {
      // First-run: generate identity and print address.
      const { address } = await ensureIdentity();
      console.log(`[smoke] Role B address: ${address}`);
      await ensureFunded(address); // exits 3 if unfunded
      await ensureProfilePublished(address);
      console.log("[smoke] Profile published. Set PEER_A_ADDRESS=<role-A-address> and re-run.");
      process.exit(0);
    }
    await runRoleB(peerA);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[smoke] FAILED:", msg);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
