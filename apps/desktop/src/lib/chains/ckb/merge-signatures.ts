import {
  bytesConcat,
  bytesFrom,
  hexFrom,
  Transaction,
  WitnessArgs,
} from "@ckb-ccc/core";
import { encodeMultisigScript, type CkbMultisigConfig } from "./multisig";
import { recoverPubkeyHashFromSignature } from "../../signers/ckb-secp256k1";

export interface PartialSignature {
  /** Index into treasuryConfig.pubkeyHashes — which co-signer slot this came from. */
  slotIndex: number;
  /** 65-byte CKB sig: r(32) || s(32) || v(1). */
  signature: string;
}

/**
 * Replace witness[0]'s zero-filled signature slots with the M collected
 * partial signatures.
 *
 * Multisig witness lock layout (consumed by `secp256k1_blake160_multisig_all`):
 *
 *   multisig_script(4 + 20N) | Sig1(65) | Sig2(65) | ... | SigM(65)
 *
 * For ChainPay v0.1, R = 0 always — the on-chain script doesn't require sigs
 * in a specific order, but we sort them by slotIndex anyway for deterministic
 * tx bytes (helps with reproducible builds and explorer lookups).
 *
 * Validation:
 *  - Exactly M sigs supplied
 *  - Each sig is 65 bytes
 *  - No duplicate slot indices
 *  - Each signature must recover to the pubkey hash at the claimed slot
 *    (computed independently — re-derives pubkey, blake160s it, compares).
 *    Catches: caller mis-routing sigs, signer keystore mismatches, tampered
 *    sigs in transit.
 *
 * Returns the mutated `tx` for caller convenience (already had a reference).
 */
export function mergeSignatures(
  tx: Transaction,
  cfg: CkbMultisigConfig,
  sighashDigest: string,
  partials: PartialSignature[],
): Transaction {
  if (partials.length !== cfg.m) {
    throw new Error(
      `expected exactly ${cfg.m} signatures (M), got ${partials.length}`,
    );
  }

  const seen = new Set<number>();
  for (const p of partials) {
    if (seen.has(p.slotIndex)) {
      throw new Error(`duplicate slot index ${p.slotIndex} in partials`);
    }
    seen.add(p.slotIndex);

    const sigBytes = bytesFrom(p.signature);
    if (sigBytes.length !== 65) {
      throw new Error(
        `signature for slot ${p.slotIndex} must be 65 bytes, got ${sigBytes.length}`,
      );
    }

    const expectedHash = cfg.pubkeyHashes[p.slotIndex];
    if (!expectedHash) {
      throw new Error(`slot index ${p.slotIndex} out of range (N=${cfg.n})`);
    }
    const recoveredHash = recoverPubkeyHashFromSignature(sighashDigest, p.signature);
    if (recoveredHash === null) {
      throw new Error(`signature for slot ${p.slotIndex} is malformed (couldn't recover pubkey)`);
    }
    if (recoveredHash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error(
        `signature for slot ${p.slotIndex} recovers to ${recoveredHash}, not the claimed slot's expected hash ${expectedHash}`,
      );
    }
  }

  // Deterministic ordering by slot index. For R = 0 the on-chain script is
  // order-independent so this only matters for repeatable tx bytes.
  const sorted = [...partials].sort((a, b) => a.slotIndex - b.slotIndex);

  const { multisigScript } = encodeMultisigScript(cfg);
  const sigBufs = sorted.map((p) => bytesFrom(p.signature));
  const newLock = bytesConcat(multisigScript, ...sigBufs);

  const witness0 = WitnessArgs.fromBytes(bytesFrom(tx.witnesses[0]!));
  witness0.lock = hexFrom(newLock);
  tx.setWitnessAt(0, hexFrom(witness0.toBytes()));

  return tx;
}

