import { contextBridge, ipcRenderer } from "electron";
import type { CkbNetwork, SearchKey, SyncProgress, CellsCapacityResult } from "../main/light-client-host";

const ckbApi = {
  start: (network: CkbNetwork): Promise<void> => ipcRenderer.invoke("ckb:start", network),
  stop: (): Promise<void> => ipcRenderer.invoke("ckb:stop"),
  status: (): Promise<{ started: boolean; network: CkbNetwork | null }> => ipcRenderer.invoke("ckb:status"),
  tipHeader: (): Promise<{ number: bigint; hash: string } | null> => ipcRenderer.invoke("ckb:tip-header"),
  getCellsCapacity: (searchKey: SearchKey): Promise<CellsCapacityResult | null> =>
    ipcRenderer.invoke("ckb:get-cells-capacity", searchKey),
  getTransactions: (
    searchKey: SearchKey,
    order: "asc" | "desc",
    limit: number,
    cursor?: string,
  ): Promise<{ txs: unknown[]; lastCursor: string }> =>
    ipcRenderer.invoke("ckb:get-transactions", searchKey, order, limit, cursor),
  onSyncProgress: (handler: (p: SyncProgress) => void): (() => void) => {
    const listener = (_: unknown, p: SyncProgress) => handler(p);
    ipcRenderer.on("ckb:sync-progress", listener);
    return () => ipcRenderer.off("ckb:sync-progress", listener);
  },
};

contextBridge.exposeInMainWorld("ckb", ckbApi);

export type CkbApi = typeof ckbApi;
