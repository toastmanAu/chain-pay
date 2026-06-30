import {
  LightClientSetScriptsCommand,
  type ScriptStatus,
} from "@nervosnetwork/ckb-light-client-js";
import type { ScriptLike } from "@ckb-ccc/core";

export interface SetScriptsClient {
  setScripts(
    scripts: ScriptStatus[],
    command: LightClientSetScriptsCommand,
  ): Promise<unknown>;
}

/**
 * Force a fresh filter-sync of an already-watched lock from `fromBlock`.
 *
 * Delete + re-add, because `setScripts(Partial)` will NOT lower an existing
 * cursor — re-watching is a documented no-op upstream. The Delete clears the
 * persisted IndexedDB cursor; the Partial re-add registers the lock at
 * `fromBlock` (0n = genesis). If the Delete throws, we never re-add, so the
 * lock is left in its prior state rather than orphaned.
 */
export async function rescanLock(
  client: SetScriptsClient,
  script: ScriptLike,
  fromBlock: bigint,
): Promise<void> {
  await client.setScripts(
    [{ script, scriptType: "lock", blockNumber: 0n }],
    LightClientSetScriptsCommand.Delete,
  );
  await client.setScripts(
    [{ script, scriptType: "lock", blockNumber: fromBlock }],
    LightClientSetScriptsCommand.Partial,
  );
}
