import { Address, type ScriptInfo } from "@ckb-ccc/core";
import { secp256k1LockAndDeps } from "./secp256k1-lock";

/**
 * Encodes secp256k1_blake160_sighash_all lock-args to a bech32m CKB address.
 *
 * Builds the `secp256k1_blake160_sighash_all` Script from `scriptInfo` + `args`
 * (via `secp256k1LockAndDeps`), then encodes it with CCC's full-format bech32m
 * encoder. The result is a `ckb1…` (mainnet) or `ckt1…` (testnet) address string
 * that any CKB-compatible wallet can decode.
 *
 * @param args     0x-prefixed 20-byte blake160 hash of the compressed secp256k1 pubkey.
 * @param network  Address prefix: "ckb" (mainnet) or "ckt" (testnet).
 * @param scriptInfo  Resolved secp256k1_blake160_sighash_all ScriptInfo from CCC.
 * @returns Full-format bech32m address string.
 */
export function secp256k1AddressFromLockArgs(
  args: string,
  network: "ckb" | "ckt",
  scriptInfo: ScriptInfo,
): string {
  const { lock } = secp256k1LockAndDeps(scriptInfo, args);
  return Address.from({ script: lock, prefix: network }).toString();
}
