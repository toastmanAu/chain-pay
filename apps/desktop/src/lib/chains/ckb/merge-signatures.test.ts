import { describe, expect, it } from "vitest";
import { Cell, OutPoint, Script, WitnessArgs, bytesFrom } from "@ckb-ccc/core";
import type { Hex20 } from "@chain-pay/shared";
import { treasuryLockScript } from "./address";
import {
  SECP256K1_BLAKE160_CODE_HASH,
  buildPaymentSkeleton,
} from "./tx-builder";
import type { CkbMultisigConfig } from "./multisig";
import { treasurySighashDigest } from "./transfer-packet";
import {
  mergeSignatures,
  type PartialSignature,
} from "./merge-signatures";
import {
  pubkeyHashFromPrivateKey,
  signDigest,
} from "../../signers/ckb-secp256k1";

// Three deterministic test private keys.
const PK1 = "0x" + "11".repeat(32);
const PK2 = "0x" + "22".repeat(32);
const PK3 = "0x" + "33".repeat(32);

const HASH1 = pubkeyHashFromPrivateKey(PK1);
const HASH2 = pubkeyHashFromPrivateKey(PK2);
const HASH3 = pubkeyHashFromPrivateKey(PK3);

const cfg: CkbMultisigConfig = {
  s: 0,
  r: 0,
  m: 2,
  n: 3,
  pubkeyHashes: [HASH1, HASH2, HASH3],
};
const treasuryScript = Script.from(treasuryLockScript(cfg));
const payeeScript = Script.from({
  codeHash: SECP256K1_BLAKE160_CODE_HASH,
  hashType: "type",
  args: ("0x" + "aa".repeat(20)) as Hex20,
});
const CKB = 100_000_000n;

function makeCell(capacity: bigint, lock: Script): Cell {
  return Cell.from({
    outPoint: OutPoint.from({ txHash: "0x" + "01".repeat(32), index: 0 }),
    cellOutput: { capacity, lock, type: null },
    outputData: "0x",
  });
}

function buildExample() {
  return buildPaymentSkeleton({
    treasuryConfig: cfg,
    treasuryScript,
    recipients: [{ lock: payeeScript, capacity: 70n * CKB }],
    availableCells: [makeCell(200n * CKB, treasuryScript)],
    network: "testnet",
    feeRateShannonsPerByte: 1000n,
  });
}

function signWith(privKey: string, digest: string): PartialSignature {
  return {
    slotIndex: indexOf(pubkeyHashFromPrivateKey(privKey)),
    signature: signDigest(digest, privKey),
  };
}

function indexOf(hash: Hex20): number {
  return cfg.pubkeyHashes.findIndex((h) => h.toLowerCase() === hash.toLowerCase());
}

describe("mergeSignatures", () => {
  it("packs M sigs into witness[0].lock at the end of the multisig_script", () => {
    const { tx } = buildExample();
    const digest = treasurySighashDigest(tx);
    const merged = mergeSignatures(tx, cfg, digest, [
      signWith(PK1, digest),
      signWith(PK2, digest),
    ]);

    const witnessBytes = bytesFrom(merged.witnesses[0]!);
    const decoded = WitnessArgs.fromBytes(witnessBytes);
    expect(decoded.lock).toBeDefined();

    const lockBytes = bytesFrom(decoded.lock!);
    const headerLen = 4 + 20 * cfg.n; // S|R|M|N + N×20
    expect(lockBytes.length).toBe(headerLen + 65 * cfg.m);

    // First 4 bytes still the S|R|M|N header.
    expect(lockBytes[0]).toBe(0); // S
    expect(lockBytes[1]).toBe(0); // R
    expect(lockBytes[2]).toBe(2); // M
    expect(lockBytes[3]).toBe(3); // N

    // Sig slots are no longer all-zero.
    const sigBytes = lockBytes.slice(headerLen);
    expect(sigBytes.some((b) => b !== 0)).toBe(true);
  });

  it("accepts sigs in any order (R = 0 path)", () => {
    const { tx: tx1 } = buildExample();
    const { tx: tx2 } = buildExample();
    const digest = treasurySighashDigest(tx1);

    const a = mergeSignatures(tx1, cfg, digest, [
      signWith(PK1, digest),
      signWith(PK2, digest),
    ]);
    const b = mergeSignatures(tx2, cfg, digest, [
      signWith(PK2, digest),
      signWith(PK1, digest),
    ]);

    // Both end up with the same witness — sigs are sorted by slotIndex.
    expect(a.witnesses[0]).toBe(b.witnesses[0]);
  });

  it("rejects fewer than M sigs", () => {
    const { tx } = buildExample();
    const digest = treasurySighashDigest(tx);
    expect(() =>
      mergeSignatures(tx, cfg, digest, [signWith(PK1, digest)]),
    ).toThrow(/2|threshold|M/);
  });

  it("rejects more than M sigs", () => {
    const { tx } = buildExample();
    const digest = treasurySighashDigest(tx);
    expect(() =>
      mergeSignatures(tx, cfg, digest, [
        signWith(PK1, digest),
        signWith(PK2, digest),
        signWith(PK3, digest),
      ]),
    ).toThrow(/2|threshold|M|more than/);
  });

  it("rejects duplicate slot indices (same signer twice)", () => {
    const { tx } = buildExample();
    const digest = treasurySighashDigest(tx);
    expect(() =>
      mergeSignatures(tx, cfg, digest, [
        signWith(PK1, digest),
        { slotIndex: 0, signature: signDigest(digest, PK1) },
      ]),
    ).toThrow(/duplicate|slot/i);
  });

  it("rejects signatures that don't recover to the claimed slot's pubkey", () => {
    const { tx } = buildExample();
    const digest = treasurySighashDigest(tx);
    const wrongSig = signDigest(digest, "0x" + "55".repeat(32));
    expect(() =>
      mergeSignatures(tx, cfg, digest, [
        { slotIndex: 0, signature: wrongSig }, // claims slot 0 but signed by an unknown key
        signWith(PK2, digest),
      ]),
    ).toThrow(/recover|verify|slot/i);
  });

  it("rejects sigs of the wrong byte length", () => {
    const { tx } = buildExample();
    const digest = treasurySighashDigest(tx);
    expect(() =>
      mergeSignatures(tx, cfg, digest, [
        { slotIndex: 0, signature: "0x1234" },
        signWith(PK2, digest),
      ]),
    ).toThrow(/65/);
  });
});
