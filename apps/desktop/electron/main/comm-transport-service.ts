/**
 * comm-transport-service.ts
 *
 * Main-process bridge between ChainPay and the vendored CEMP-PQ library.
 * The renderer never imports CEMP-PQ directly — all signing and key material
 * stays in the Electron main process.
 *
 * Phase 2.7a scope:
 *   - Identity generation / persistence via comm-identity-store
 *   - Publish a Profile Cell on CKB testnet
 *   - Send an encrypted message cell
 *   - Decrypt an incoming message cell
 *   - Resolve a remote profile (ML-KEM pubkey only; ML-DSA + metadata in 2.7b)
 *
 * API notes vs. original task spec template:
 *   - ML_DSA_TESTNET fields are UPPERCASE flat: CODE_HASH, HASH_TYPE, TX_HASH, INDEX ✓
 *   - MLDSASigner(client, secretKey, publicKey?): pass 32-byte seed → internal keygen ✓
 *   - fetchRecipientProfile returns bare Uint8Array (KEM pubkey bytes) and throws if
 *     profile not found; does NOT return null. Caught here and re-thrown cleanly.
 *   - CEMPPQ.encrypt/decrypt are static helpers; decryptIncoming uses CEMPPQ.decrypt
 *     rather than manual TLV parsing to stay in sync with CEMP-PQ's own format.
 *   - buildSendMessageTx calls TextEncoder().encode(message) internally, so it expects
 *     a string. For pre-serialised binary envelopes (our use case) we call
 *     CEMPPQ.encrypt directly and build the tx manually.
 *   - Lock args derivation is internal to MLDSASigner; we derive the address by
 *     instantiating a throw-away signer from the seed rather than replicating the
 *     sha3_256 / hashCkb logic here.
 */

import { ccc } from "@ckb-ccc/core";
import {
  CEMPPQ,
  CEMPTransactionBuilder,
  MLDSASigner,
  ML_DSA_TESTNET,
} from "cemp-pq";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";
import { ml_kem768 } from "@noble/post-quantum/ml-kem";
import {
  withSecrets,
  loadCommIdentity,
  saveCommIdentity,
  deleteCommIdentity,
  type PlainIdentity,
  type PublicIdentity,
} from "./comm-identity-store";

// ── Types exported to callers (IPC handler, smoke script) ────────────────────

export type { PublicIdentity };

export interface ProfileFetchResult {
  address: string;
  /** hex-encoded ML-DSA public key. Empty in 2.7a — enriched in 2.7b. */
  mlDsaPubKey: string;
  /** hex-encoded ML-KEM-768 public key. */
  mlKemPubKey: string;
  /** UTF-8 profile metadata string. Empty in 2.7a — enriched in 2.7b. */
  metadata: string;
}

export interface SignedTxBundle {
  /** Hex tx hash (0x-prefixed). */
  txHash: string;
  /** 0x-prefixed serialised transaction bytes, ready for broadcast. */
  txBytes: string;
}

// ── CKB client ───────────────────────────────────────────────────────────────

let cachedClient: ccc.ClientPublicTestnet | null = null;

function getClient(): ccc.ClientPublicTestnet {
  if (!cachedClient) {
    const url =
      process.env.COMM_CKB_RPC_URL ?? "https://testnet.ckb.dev/rpc";
    cachedClient = new ccc.ClientPublicTestnet({ url });
  }
  return cachedClient;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

function fromHex(hex: string): Uint8Array {
  return Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex");
}

/**
 * Derive the CKB testnet address + 20-byte addrHash for a given 32-byte ML-DSA seed.
 * We instantiate a throw-away MLDSASigner (which computes the lock internally)
 * rather than replicating the hashCkb/args derivation here.
 */
async function deriveIdentityLock(seed: Uint8Array): Promise<{ address: string; addrHash: Uint8Array }> {
  const signer = new MLDSASigner(getClient(), seed);
  const addrObj = await signer.getRecommendedAddressObj();
  const argsHex = addrObj.script.args.startsWith("0x")
    ? addrObj.script.args.slice(2)
    : addrObj.script.args;
  // First 20 bytes of args = the canonical comm-identity hash used for the refusal invariant.
  const addrHash = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    addrHash[i] = parseInt(argsHex.slice(i * 2, i * 2 + 2), 16);
  }
  return { address: addrObj.toString(), addrHash };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a new ML-DSA-65 + ML-KEM-768 identity, encrypt and persist it.
 * Throws if an identity already exists (call deleteIdentity() first).
 */
export async function generateIdentity(): Promise<PublicIdentity> {
  const existing = await loadCommIdentity();
  if (existing) throw new Error("comm identity already exists");

  const dsaSeed = crypto.getRandomValues(new Uint8Array(32));
  const dsa = ml_dsa65.keygen(dsaSeed);
  const kemSeed = crypto.getRandomValues(new Uint8Array(64));
  const kem = ml_kem768.keygen(kemSeed);
  const { address, addrHash } = await deriveIdentityLock(dsaSeed);

  const plain: PlainIdentity = {
    mlDsaSec: dsaSeed, // store the 32-byte seed; MLDSASigner will expand on use
    mlKemSec: kem.secretKey,
    mlDsaPub: dsa.publicKey,
    mlKemPub: kem.publicKey,
    address,
    addrHash,
    createdAt: Date.now(),
  };
  await saveCommIdentity(plain);

  // Zero locals after persistence.
  dsaSeed.fill(0);
  kem.secretKey.fill(0);

  return {
    mlDsaPub: toHex(dsa.publicKey),
    mlKemPub: toHex(kem.publicKey),
    address,
    addrHash: toHex(addrHash),
    createdAt: plain.createdAt,
  };
}

/** Returns true if a comm identity file exists. */
export async function exists(): Promise<boolean> {
  return (await loadCommIdentity()) !== null;
}

/** Returns public fields of the stored identity, or null if none. */
export async function publicInfo(): Promise<PublicIdentity | null> {
  return loadCommIdentity();
}

/** Permanently delete the stored comm identity. */
export async function deleteIdentity(): Promise<void> {
  await deleteCommIdentity();
}

/**
 * Publish a Profile Cell to CKB testnet.
 * The cell advertises the ML-DSA verifying key and ML-KEM encapsulation key so
 * other participants can encrypt messages to this identity.
 *
 * Returns a SignedTxBundle; the caller (IPC handler / smoke script) is
 * responsible for broadcasting the tx bytes.
 */
export async function publishProfile(
  metadata: { displayName?: string } = {},
): Promise<SignedTxBundle> {
  const pub = await loadCommIdentity();
  if (!pub) throw new Error("no comm identity — call generateIdentity() first");

  const dsaPub = fromHex(pub.mlDsaPub);
  const kemPub = fromHex(pub.mlKemPub);
  const metaString = JSON.stringify(metadata);

  return withSecrets(async (secrets) => {
    // secrets.mlDsaSec is the 32-byte seed; MLDSASigner expands it internally.
    const signer = new MLDSASigner(getClient(), secrets.mlDsaSec);
    const builder = new CEMPTransactionBuilder(getClient());

    const tx = await builder.buildCreateProfileTx(
      signer,
      dsaPub,
      kemPub,
      metaString,
    );
    const signed = await signer.signOnlyTransaction(tx);
    const txBytes = signed.toBytes();
    return {
      txHash: "0x" + Buffer.from(ccc.bytesFrom(signed.hash())).toString("hex"),
      txBytes: toHex(txBytes),
    };
  });
}

/**
 * Send an encrypted message to a recipient.
 *
 * `envelopeBytes` is the raw binary payload to encrypt (e.g. a serialised
 * payroll notification or arbitrary bytes). It is encrypted with the
 * recipient's ML-KEM public key before being placed in a Message Cell.
 *
 * NOTE: We bypass CEMPTransactionBuilder.buildSendMessageTx because that
 * helper calls TextEncoder().encode(message) expecting a string, which would
 * corrupt binary data. Instead we call CEMPPQ.encrypt directly and build the
 * transaction manually, mirroring what buildSendMessageTx does internally.
 *
 * Returns a SignedTxBundle; caller broadcasts.
 */
export async function sendMessage(
  recipientAddress: string,
  envelopeBytes: Uint8Array,
): Promise<SignedTxBundle> {
  const pub = await loadCommIdentity();
  if (!pub) throw new Error("no comm identity — call generateIdentity() first");

  // Resolve recipient lock from address.
  const recipientAddrObj = await ccc.Address.fromString(
    recipientAddress,
    getClient(),
  );
  const recipientLock = recipientAddrObj.script;

  return withSecrets(async (secrets) => {
    const signer = new MLDSASigner(getClient(), secrets.mlDsaSec);
    const { script: senderLock } = await signer.getRecommendedAddressObj();

    // Fetch recipient's profile (ML-KEM public key + ML-DSA pubkey + metadata).
    const builder = new CEMPTransactionBuilder(getClient());
    const profile = await builder.fetchRecipientProfile(recipientLock);
    if (!profile) {
      throw new Error(`profile not found for recipient ${recipientAddress}`);
    }

    // Encrypt envelope bytes directly (not via buildSendMessageTx which expects a string).
    const encryptedData = await CEMPPQ.encrypt(envelopeBytes, profile.mlKemPubKey);

    // Build tx manually, matching buildSendMessageTx's output structure.
    const tx = ccc.Transaction.from({
      outputs: [
        // Output 0: Message Cell (owned by sender — spendable to reclaim capacity).
        {
          lock: senderLock,
          capacity: ccc.fixedPointFrom(0),
          type: null,
        },
        // Output 1: Notification Cell (owned by recipient — signals a new message).
        {
          lock: recipientLock,
          capacity: ccc.fixedPointFrom(0),
          type: null,
        },
      ],
      outputsData: [ccc.hexFrom(encryptedData), "0x"],
    });

    tx.addCellDeps({
      outPoint: {
        txHash: ML_DSA_TESTNET.TX_HASH,
        index: ML_DSA_TESTNET.INDEX,
      },
      depType: "code",
    });

    // Cast to ccc.Signer: MLDSASigner.prepareTransaction takes `Transaction` (more
    // specific than the base-class `TransactionLike`), which under
    // exactOptionalPropertyTypes causes a structural mismatch in the .d.ts.
    // The cast is safe — at runtime MLDSASigner is a proper CCC Signer.
    await tx.completeInputsByCapacity(signer as unknown as ccc.Signer);
    await tx.completeFeeBy(signer as unknown as ccc.Signer, 1200n);

    const signed = await signer.signOnlyTransaction(tx);
    const txBytes = signed.toBytes();
    return {
      txHash:
        "0x" + Buffer.from(ccc.bytesFrom(signed.hash())).toString("hex"),
      txBytes: toHex(txBytes),
    };
  });
}

/**
 * Decrypt an incoming message cell identified by its on-chain OutPoint.
 *
 * Fetches the cell live (bypasses CCC cell cache — avoids the "outputData=0x"
 * cache-hit trap documented in the CKB transactions rule for CKBFS cells).
 * Decrypts using CEMPPQ.decrypt which handles the TLV wire format internally.
 *
 * Returns the decrypted payload as a 0x-prefixed hex string.
 */
export async function decryptIncoming(messageOutPoint: {
  txHash: string;
  index: number;
}): Promise<string> {
  // getCellLive bypasses CCC's internal cell cache.
  const messageCell = await getClient().getCellLive(
    {
      txHash: messageOutPoint.txHash,
      index: BigInt(messageOutPoint.index),
    },
    true,
  );
  if (!messageCell) {
    throw new Error(
      `message cell at ${messageOutPoint.txHash}:${messageOutPoint.index} not found or already consumed`,
    );
  }

  return withSecrets(async (secrets) => {
    const encryptedData = fromHex(messageCell.outputData);
    // CEMPPQ.decrypt handles the TLV layout (header offsets) produced by CEMPPQ.encrypt.
    const plainBytes = await CEMPPQ.decrypt(encryptedData, secrets.mlKemSec);
    return toHex(plainBytes);
  });
}

/**
 * Resolve a remote participant's Profile Cell.
 *
 * Returns the full profile (ML-DSA pubkey, ML-KEM pubkey, UTF-8 metadata).
 * Throws if the profile cell is not found.
 */
export async function resolveProfile(
  address: string,
): Promise<ProfileFetchResult> {
  const addrObj = await ccc.Address.fromString(address, getClient());
  const lock = addrObj.script;
  const builder = new CEMPTransactionBuilder(getClient());

  const profile = await builder.fetchRecipientProfile(lock);
  if (!profile) {
    throw new Error(`profile not found for ${address}`);
  }

  return {
    address,
    mlDsaPubKey: toHex(profile.mlDsaPubKey),
    mlKemPubKey: toHex(profile.mlKemPubKey),
    metadata: new TextDecoder().decode(profile.metadata),
  };
}
