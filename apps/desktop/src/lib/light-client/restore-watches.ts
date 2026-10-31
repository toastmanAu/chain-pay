import {
  Address, ClientPublicMainnet, ClientPublicTestnet, Script, type ScriptLike,
} from "@ckb-ccc/core";
import { isMultisigTreasury, type Source, type Treasury } from "@chain-pay/shared";
import { treasuryLockScript } from "@/lib/chains/ckb/address";
import type { CkbNetwork } from "./network-configs";

export interface WatchRestoreHost {
  getWatchedScripts(): Promise<Array<{ script: ScriptLike; scriptType: string }>>;
  watchLockScript(script: Script, fromBlock: bigint): Promise<void>;
}

/** Restore public wallet watches after a fresh or migrated chain index starts. */
export async function restorePersistedWatches(
  host: WatchRestoreHost,
  network: CkbNetwork,
  sources: Source[],
  treasuries: Treasury[],
): Promise<void> {
  const watched = (await host.getWatchedScripts())
    .filter((status) => status.scriptType === "lock")
    .map((status) => Script.from(status.script));
  const client = network === "mainnet" ? new ClientPublicMainnet() : new ClientPublicTestnet();
  const chain = `ckb:${network}`;

  const sourceLocks: Script[] = [];
  const invalidSources: string[] = [];
  for (const source of sources.filter((item) => item.chain === chain)) {
    try {
      sourceLocks.push((await Address.fromString(source.address, client)).script);
    } catch {
      invalidSources.push(source.id);
    }
  }
  const treasuryLocks = treasuries
    .filter((treasury) => isMultisigTreasury(treasury) && treasury.multisig.chain === chain)
    .map((treasury) => {
      if (!isMultisigTreasury(treasury) || !("pubkeyHashes" in treasury.multisig)) {
        throw new Error("invalid CKB treasury watch");
      }
      const { s, r, m, n, pubkeyHashes, since } = treasury.multisig;
      return Script.from(treasuryLockScript({
        s, r, m, n, pubkeyHashes, ...(since !== undefined ? { since } : {}),
      }));
    });

  for (const script of [...sourceLocks, ...treasuryLocks]) {
    if (watched.some((current) => current.eq(script))) continue;
    // An old file-origin index is not migrated. Genesis is the only safe
    // lower bound for a previously funded wallet whose first block is unknown.
    await host.watchLockScript(script, 0n);
    watched.push(script);
  }
  if (invalidSources.length > 0) {
    throw new Error(
      `Cannot restore CKB watches for invalid source IDs: ${invalidSources.join(", ")}`,
    );
  }
}
