import {
  CellDep,
  ClientPublicMainnet,
  ClientPublicTestnet,
  KnownScript,
  Script,
  ScriptInfo,
} from "@ckb-ccc/core";
import type { CkbNetwork } from "../../light-client/network-configs";

/** PURE: build the JoyID lock Script + its cell deps from resolved ScriptInfo + args. */
export function joyidLockAndDeps(
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
 * Resolve the JoyID known-script config for a network. CCC ships the JoyID
 * codeHash/hashType/cellDeps as static known-script data — this is a lookup,
 * not an RPC round-trip, so it doesn't violate light-client-first. Not unit
 * tested (exercised by manual JoyID smoke).
 */
export async function resolveJoyIdScriptInfo(network: CkbNetwork): Promise<ScriptInfo> {
  const client = network === "mainnet" ? new ClientPublicMainnet() : new ClientPublicTestnet();
  return client.getKnownScript(KnownScript.JoyId);
}
