import {
  Transaction,
  WitnessArgs,
  HasherCkb,
  bytesFrom,
  hexFrom,
  numToBytes,
} from "@ckb-ccc/core";

/**
 * Compute the CKB `secp256k1_blake160_sighash_all` signing digest for a group
 * of inputs.
 *
 * Formula (RFC-0032 / CKB script convention):
 *   blake2b_ckb(
 *     txHash                                          // 32 bytes
 *     || u64le(len(witness[g0] with zeroed lock))
 *     || witness[g0] with zeroed lock (65 zero bytes)
 *     || [for each remaining group input witness i]:
 *          u64le(len(witness[i])) || witness[i]
 *     || [for each witness beyond inputs.length]:
 *          u64le(len(witness[i])) || witness[i]
 *   )
 *
 * The zeroed lock is always 65 bytes of 0x00, placed inside a WitnessArgs
 * molecule. If the group's first witness is empty ("0x"), a fresh WitnessArgs
 * with only a zeroed lock is used. Otherwise the existing witness is
 * deserialized and its lock field is zeroed.
 *
 * This is used by the Electron main process to recompute the digest from the
 * tx it receives — it never trusts a renderer-supplied digest.
 *
 * @param tx - The CCC Transaction (unsigned; witnesses may be empty or padded).
 * @param groupInputIndices - Indices of inputs belonging to the signing group.
 *   The first element is the "group leader" whose witness carries the lock.
 * @returns 0x-prefixed 32-byte hex digest.
 */
export function computeSighashAllDigest(
  tx: Transaction,
  groupInputIndices: number[],
): string {
  if (groupInputIndices.length === 0) {
    throw new Error("empty signing group");
  }

  const hasher = new HasherCkb(32);

  // 1. Commit to the tx hash.
  hasher.update(bytesFrom(tx.hash()));

  // 2. Commit to the group-leader witness with its lock zeroed to 65 bytes.
  const leaderIdx = groupInputIndices[0]!;
  const leaderRaw = tx.witnesses[leaderIdx] ?? "0x";
  const leaderWa = zeroWitnessLock(leaderRaw);
  const leaderBytes = leaderWa.toBytes();
  hasher.update(numToBytes(leaderBytes.length, 8));
  hasher.update(leaderBytes);

  // 3. Commit to the remaining group witnesses (indices 1+).
  for (const idx of groupInputIndices.slice(1)) {
    const w = bytesFrom(tx.witnesses[idx] ?? "0x");
    hasher.update(numToBytes(w.length, 8));
    hasher.update(w);
  }

  // 4. Commit to any extra witnesses beyond inputs.length (appended witnesses).
  for (let i = tx.inputs.length; i < tx.witnesses.length; i++) {
    const w = bytesFrom(tx.witnesses[i] ?? "0x");
    hasher.update(numToBytes(w.length, 8));
    hasher.update(w);
  }

  return hexFrom(hasher.digest());
}

/**
 * Deserialize (or initialize) a WitnessArgs and zero its lock field to 65 bytes.
 *
 * "0x" (empty witness) is treated as a fresh WitnessArgs with no fields set;
 * the zeroed lock is then the only field.
 */
function zeroWitnessLock(witnessHex: string): WitnessArgs {
  const ZEROED_LOCK = "0x" + "00".repeat(65);
  if (witnessHex === "0x") {
    return WitnessArgs.from({ lock: ZEROED_LOCK });
  }
  const existing = WitnessArgs.fromBytes(bytesFrom(witnessHex));
  // Explicit properties instead of spread to satisfy exactOptionalPropertyTypes:
  // WitnessArgs optional fields use `null` to unset, not `undefined`.
  return WitnessArgs.from({
    lock: ZEROED_LOCK,
    ...(existing.inputType != null ? { inputType: existing.inputType } : {}),
    ...(existing.outputType != null ? { outputType: existing.outputType } : {}),
  });
}
