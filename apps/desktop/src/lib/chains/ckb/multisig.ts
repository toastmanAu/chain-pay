import type { Hex20 } from "@chain-pay/shared";

/**
 * secp256k1_blake160_multisig_all configuration.
 *
 *   multisig_script = S | R | M | N | PubKeyHash1 | ... | PubKeyHashN
 *
 *   lock.args = blake160(multisig_script)  [+ optional 8-byte since]
 *
 * Phase 2 fills in the actual encode / decode / builder logic against `@ckb-ccc/core`.
 */
export interface CkbMultisigConfig {
  /** Reserved, must be 0. */
  s: 0;
  /** First R public keys must always sign. */
  r: number;
  /** Threshold M-of-N. */
  m: number;
  /** Total signers N. */
  n: number;
  /** blake160 hashes of compressed pubkeys, length === n. */
  pubkeyHashes: Hex20[];
  /** Optional 8-byte since for time-locked multisig (RFC 0017). */
  since?: bigint;
}

export interface EncodedMultisigScript {
  /** S|R|M|N|hashes... — used inside the witness lock. */
  multisigScript: Uint8Array;
  /** blake160(multisigScript) — used in lock.args. */
  scriptHash20: Hex20;
}

export function encodeMultisigScript(_cfg: CkbMultisigConfig): EncodedMultisigScript {
  throw new Error("encodeMultisigScript — Phase 2");
}

export function lockArgsFromConfig(_cfg: CkbMultisigConfig): Uint8Array {
  throw new Error("lockArgsFromConfig — Phase 2");
}

/**
 * Witness lock layout for a partially signed multisig tx:
 *   multisig_script | Sig1 | Sig2 | ... | SigM
 *
 * Unsigned slots are filled with 65-byte zero placeholders so the witness size
 * is stable across the partial-signature collection rounds.
 */
export function placeholderWitnessLock(_cfg: CkbMultisigConfig): Uint8Array {
  throw new Error("placeholderWitnessLock — Phase 2");
}
