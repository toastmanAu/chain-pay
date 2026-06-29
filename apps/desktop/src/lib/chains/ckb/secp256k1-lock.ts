import {
  CellDep,
  ClientPublicMainnet,
  ClientPublicTestnet,
  KnownScript,
  Script,
  ScriptInfo,
} from "@ckb-ccc/core";
import type { CkbNetwork } from "../../light-client/network-configs";

/** PURE: build the secp256k1_blake160_sighash_all lock Script + its cell deps
 *  from resolved ScriptInfo + args. Mirrors joyidLockAndDeps shape/return type. */
export function secp256k1LockAndDeps(
  scriptInfo: ScriptInfo,
  args: string,
): { lock: Script; cellDeps: CellDep[] } {
  const lock = Script.from({
    codeHash: scriptInfo.codeHash,
    hashType: scriptInfo.hashType,
    args,
  });
  const cellDeps = scriptInfo.cellDeps.map((c) => CellDep.from(c.cellDep));
  return { lock, cellDeps };
}

/**
 * Resolve the secp256k1_blake160_sighash_all known-script config for a network.
 * CCC ships the code hash/hashType/cellDeps as static known-script data — this
 * is a lookup, not an RPC round-trip, so it doesn't violate light-client-first.
 * Not unit-tested directly (exercised by build-and-send integration path).
 */
export async function resolveSecp256k1ScriptInfo(network: CkbNetwork): Promise<ScriptInfo> {
  const client =
    network === "mainnet" ? new ClientPublicMainnet() : new ClientPublicTestnet();
  return client.getKnownScript(KnownScript.Secp256k1Blake160);
}
