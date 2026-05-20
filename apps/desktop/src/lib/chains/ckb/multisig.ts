import { HasherCkb } from "@ckb-ccc/core";
import type { Hex20 } from "@chain-pay/shared";

/**
 * secp256k1_blake160_multisig_all configuration.
 *
 *   multisig_script = S(1) | R(1) | M(1) | N(1) | PubKeyHash1(20) | ... | PubKeyHashN(20)
 *
 *   lock.args = blake160(multisig_script)               [20 bytes]
 *             | blake160(multisig_script) | since(8)    [28 bytes, time-locked]
 *
 *   witness lock (partially signed) = multisig_script | Sig1(65) | Sig2(65) | ... | SigM(65)
 *
 * `since` follows RFC-0017 and serialises as 8-byte little-endian u64.
 */
export interface CkbMultisigConfig {
  /** Reserved, must be 0. */
  s: 0;
  /** First R public keys must always sign (R <= M). */
  r: number;
  /** Threshold M-of-N (1 <= M <= N). */
  m: number;
  /** Total signers N (1 <= N <= 255 — single-byte field). */
  n: number;
  /** blake160 hashes of compressed pubkeys, length === N. */
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

const PUBKEY_HASH_LEN = 20;
const SIG_LEN = 65;
const U64_MAX_EXCLUSIVE = 1n << 64n;

export function encodeMultisigScript(cfg: CkbMultisigConfig): EncodedMultisigScript {
  validateConfig(cfg);

  const multisigScript = new Uint8Array(4 + PUBKEY_HASH_LEN * cfg.n);
  multisigScript[0] = cfg.s;
  multisigScript[1] = cfg.r;
  multisigScript[2] = cfg.m;
  multisigScript[3] = cfg.n;
  cfg.pubkeyHashes.forEach((hash, i) => {
    multisigScript.set(hexToBytes(hash), 4 + i * PUBKEY_HASH_LEN);
  });

  const scriptHash20 = new HasherCkb(PUBKEY_HASH_LEN).update(multisigScript).digest() as Hex20;
  return { multisigScript, scriptHash20 };
}

export function lockArgsFromConfig(cfg: CkbMultisigConfig): Uint8Array {
  const { scriptHash20 } = encodeMultisigScript(cfg);
  const hashBytes = hexToBytes(scriptHash20);
  if (cfg.since === undefined) return hashBytes;

  if (cfg.since < 0n || cfg.since >= U64_MAX_EXCLUSIVE) {
    throw new Error(`since must fit in u64, got ${cfg.since}`);
  }
  const out = new Uint8Array(PUBKEY_HASH_LEN + 8);
  out.set(hashBytes, 0);
  out.set(u64LE(cfg.since), PUBKEY_HASH_LEN);
  return out;
}

export function placeholderWitnessLock(cfg: CkbMultisigConfig): Uint8Array {
  const { multisigScript } = encodeMultisigScript(cfg);
  // Uint8Array initialises to zero — the M sig slots are already correctly padded.
  const out = new Uint8Array(multisigScript.length + SIG_LEN * cfg.m);
  out.set(multisigScript, 0);
  return out;
}

function validateConfig(cfg: CkbMultisigConfig): void {
  if (cfg.s !== 0) throw new Error(`S must be 0 (reserved), got ${cfg.s}`);
  if (cfg.m < 1) throw new Error(`M (threshold) must be >= 1, got ${cfg.m}`);
  if (cfg.n < 1) throw new Error(`N must be >= 1, got ${cfg.n}`);
  if (cfg.n > 255) throw new Error(`N must be <= 255 (single-byte overflow), got ${cfg.n}`);
  if (cfg.m > cfg.n) throw new Error(`M (threshold) must be <= N, got M=${cfg.m} N=${cfg.n}`);
  if (cfg.r > cfg.m) throw new Error(`R (required-prefix) must be <= M, got R=${cfg.r} M=${cfg.m}`);
  if (cfg.r < 0) throw new Error(`R must be >= 0, got ${cfg.r}`);
  if (cfg.pubkeyHashes.length !== cfg.n) {
    throw new Error(`pubkeyHashes.length (${cfg.pubkeyHashes.length}) must equal N (${cfg.n})`);
  }
  cfg.pubkeyHashes.forEach((h, i) => {
    const bytes = hexToBytes(h);
    if (bytes.length !== PUBKEY_HASH_LEN) {
      throw new Error(`pubkeyHashes[${i}] must be exactly 20 bytes, got ${bytes.length}`);
    }
  });
}

function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length % 2 !== 0) {
    throw new Error(`hex string must have even length: ${hex}`);
  }
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function u64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
