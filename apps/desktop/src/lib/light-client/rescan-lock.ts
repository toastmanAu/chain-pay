import {
  LightClientSetScriptsCommand,
  type ScriptStatus,
} from "@nervosnetwork/ckb-light-client-js";
import { Script, type ScriptLike } from "@ckb-ccc/core";

export interface RebuildLightClientIndexDeps {
  getScripts(): Promise<ScriptStatus[]>;
  stop(): Promise<void>;
  deleteChainIndex(): Promise<void>;
  start(): Promise<void>;
  setScripts(scripts: ScriptStatus[], command: LightClientSetScriptsCommand): Promise<unknown>;
}

/**
 * Delete an IndexedDB database after the light-client workers have stopped.
 *
 * `set_scripts(Delete)` is insufficient for a rescan: upstream deletes only
 * filter-script metadata and leaves the indexed live-cell keys untouched.
 * The chain database is a recoverable cache, so a real rescan rebuilds it.
 */
export function deleteIndexedDbDatabase(
  name: string,
  factory: IDBFactory = globalThis.indexedDB,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error(`failed to delete IndexedDB database ${name}`));
    // `blocked` is informational: the delete request remains pending and will
    // complete once the terminated worker's database handle finishes closing.
    // Rejecting here and restarting the client would reopen the database while
    // that pending deletion is still armed.
    request.onblocked = () => undefined;
  });
}

/**
 * Build the watch set for a clean chain index.
 *
 * Existing cursors are progress markers, not original start blocks. Reusing
 * them after deleting the index would omit every older live cell, so all other
 * watches must be replayed from the requested start too. A from-genesis reset
 * remains the safe default; a custom block is a global lower bound for every
 * watched wallet because the WASM client has one shared chain index.
 */
export function rescanScriptStatuses(
  watched: ScriptStatus[],
  script: ScriptLike,
  fromBlock: bigint,
): ScriptStatus[] {
  const target = Script.from(script);
  const statuses = watched
    .filter((status) => !(status.scriptType === "lock" && Script.from(status.script).eq(target)))
    .map((status) => ({ ...status, blockNumber: fromBlock }));

  statuses.push({ script: target, scriptType: "lock", blockNumber: fromBlock });
  return statuses;
}

/**
 * Rebuild the light-client chain index and restore all watched scripts.
 *
 * If cache deletion fails (for example, a worker still owns the database), the
 * previous index is left intact and the client is restarted before surfacing
 * the error. Once deletion succeeds, the restarted client receives the full
 * watch set in one `All` command.
 */
export async function rescanLock(
  deps: RebuildLightClientIndexDeps,
  script: ScriptLike,
  fromBlock: bigint,
): Promise<void> {
  const statuses = rescanScriptStatuses(await deps.getScripts(), script, fromBlock);

  await deps.stop();
  try {
    await deps.deleteChainIndex();
  } catch (error) {
    await deps.start();
    throw error;
  }

  await deps.start();
  await deps.setScripts(statuses, LightClientSetScriptsCommand.All);
}
