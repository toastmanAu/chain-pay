import type { Script, ScriptInfo } from "@ckb-ccc/core";
import type { Source, Hex20 } from "@chain-pay/shared";
import { secp256k1AddressFromLockArgs } from "@/lib/chains/ckb/secp256k1-address";
import { secp256k1LockAndDeps } from "@/lib/chains/ckb/secp256k1-lock";

/** v1 supports exactly one local keyvault, derivation index 0. */
const VAULT_ID = "main";
const DERIVATION_INDEX = 0;

/**
 * Promote a local keystore (its derived blake160 lock-args) into a send
 * `Source` of kind "secp256k1", plus the `Script` to hand to
 * `watchLockScript` so the light client syncs its cells (balance + inputs).
 *
 * Pure: the caller resolves the secp256k1 ScriptInfo (a static known-script
 * lookup) and persists/watches the result. The address is derived through the
 * same encoder the on-chain lock uses, so display, change outputs, and the
 * watched lock are guaranteed consistent.
 */
export function buildKeystoreSource(
  lockArgs: string,
  network: "mainnet" | "testnet",
  scriptInfo: ScriptInfo,
): { source: Source; lock: Script } {
  const prefix = network === "mainnet" ? "ckb" : "ckt";
  const chain: Source["chain"] =
    network === "mainnet" ? "ckb:mainnet" : "ckb:testnet";
  const address = secp256k1AddressFromLockArgs(lockArgs, prefix, scriptInfo);
  const { lock } = secp256k1LockAndDeps(scriptInfo, lockArgs);
  const now = new Date().toISOString();

  const source: Source = {
    id: crypto.randomUUID(),
    label: `Local: ${address.slice(0, 10)}`,
    chain,
    address,
    joyidLockArgs: lockArgs as Hex20,
    lockKind: "secp256k1",
    keyvaultId: VAULT_ID,
    derivationIndex: DERIVATION_INDEX,
    createdAt: now,
    updatedAt: now,
  };

  return { source, lock };
}
