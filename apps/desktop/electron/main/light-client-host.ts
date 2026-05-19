import { app } from "electron";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export type CkbNetwork = "mainnet" | "testnet";

export interface SyncProgress {
  network: CkbNetwork;
  tipBlockNumber: bigint;
  syncedBlockNumber: bigint;
  peers: number;
  fastSync: boolean;
}

export interface CellsCapacityResult {
  capacity: bigint;
  blockHash: string;
  blockNumber: bigint;
}

export interface SearchKey {
  script: { codeHash: string; hashType: "type" | "data" | "data1"; args: string };
  scriptType: "lock" | "type";
  scriptSearchMode?: "prefix" | "exact";
}

/**
 * Owns the embedded WASM light client lifecycle in the Electron main process.
 * Phase 1 will replace stubs with real ckb-light-client-js calls.
 */
export class LightClientHost extends EventEmitter {
  private network: CkbNetwork | null = null;
  private started = false;

  async start(network: CkbNetwork): Promise<void> {
    if (this.started) return;
    const storeDir = join(app.getPath("userData"), "light-client-store", network);
    await mkdir(storeDir, { recursive: true });
    this.network = network;
    this.started = true;
    // TODO Phase 1: instantiate ckb-light-client-js with storeDir + embedded mainnet/testnet config
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    // TODO Phase 1: graceful shutdown of the wasm light client
    this.started = false;
    this.network = null;
  }

  status(): { started: boolean; network: CkbNetwork | null } {
    return { started: this.started, network: this.network };
  }

  async tipHeader(): Promise<{ number: bigint; hash: string } | null> {
    if (!this.started) return null;
    // TODO Phase 1
    return null;
  }

  async getCellsCapacity(_searchKey: SearchKey): Promise<CellsCapacityResult | null> {
    if (!this.started) return null;
    // TODO Phase 1
    return null;
  }

  async getTransactions(
    _searchKey: SearchKey,
    _order: "asc" | "desc",
    _limit: number,
    _cursor?: string,
  ): Promise<{ txs: unknown[]; lastCursor: string }> {
    if (!this.started) return { txs: [], lastCursor: "" };
    // TODO Phase 1
    return { txs: [], lastCursor: "" };
  }
}
