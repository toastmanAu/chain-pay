import { LightClient, randomSecretKey } from "@nervosnetwork/ckb-light-client-js";
import type { Hex } from "@ckb-ccc/core";
import { configFor, type CkbNetwork } from "./network-configs";

export interface SyncSnapshot {
  network: CkbNetwork;
  tipBlockNumber: bigint;
  tipBlockTimestampMs: bigint;
  peers: number;
  startedAt: number;
  lastPolledAt: number;
}

type SnapshotListener = (snapshot: SyncSnapshot) => void;
type ErrorListener = (error: Error) => void;

const SECRET_KEY_STORAGE_PREFIX = "chainpay.ckb.lc.secret-key.";
const POLL_INTERVAL_MS = 5_000;

/**
 * Wraps @nervosnetwork/ckb-light-client-js. Owns one LightClient instance and
 * a polling loop that pushes sync snapshots to subscribers.
 *
 * Lives in the renderer process — the wasm package uses Web Workers,
 * SharedArrayBuffer and IndexedDB, all browser-only primitives.
 */
export class LightClientHost {
  private client: LightClient | null = null;
  private network: CkbNetwork | null = null;
  private startedAt = 0;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private snapshotListeners = new Set<SnapshotListener>();
  private errorListeners = new Set<ErrorListener>();
  private lastSnapshot: SyncSnapshot | null = null;

  async start(network: CkbNetwork): Promise<void> {
    if (this.client) {
      if (this.network === network) return;
      await this.stop();
    }

    const secretKey = loadOrCreateSecretKey(network);
    const client = new LightClient();
    await client.start({ type: network === "mainnet" ? "MainNet" : "TestNet", config: configFor(network) }, secretKey, "info", "wss");

    this.client = client;
    this.network = network;
    this.startedAt = Date.now();
    this.startPolling();
  }

  async stop(): Promise<void> {
    this.stopPolling();
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.network = null;
    this.lastSnapshot = null;
    try {
      await client.stop();
    } catch (error: unknown) {
      this.emitError(toError(error, "light client stop failed"));
    }
  }

  isStarted(): boolean {
    return this.client !== null;
  }

  currentNetwork(): CkbNetwork | null {
    return this.network;
  }

  snapshot(): SyncSnapshot | null {
    return this.lastSnapshot;
  }

  onSnapshot(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    if (this.lastSnapshot) listener(this.lastSnapshot);
    return () => this.snapshotListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async getTipHeader() {
    return this.requireClient().getTipHeader();
  }

  async getPeers() {
    return this.requireClient().getPeers();
  }

  async getCellsCapacity(searchKey: Parameters<LightClient["getCellsCapacity"]>[0]) {
    return this.requireClient().getCellsCapacity(searchKey);
  }

  async getTransactions(
    searchKey: Parameters<LightClient["getTransactions"]>[0],
    order: "asc" | "desc" = "desc",
    limit = 50,
    afterCursor?: Hex,
  ) {
    return this.requireClient().getTransactions(searchKey, order, limit, afterCursor);
  }

  private requireClient(): LightClient {
    if (!this.client) throw new Error("light client not started");
    return this.client;
  }

  private startPolling(): void {
    this.stopPolling();
    void this.pollOnce();
    this.pollHandle = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollHandle === null) return;
    clearInterval(this.pollHandle);
    this.pollHandle = null;
  }

  private async pollOnce(): Promise<void> {
    if (!this.client || !this.network) return;
    try {
      const [tip, peers] = await Promise.all([this.client.getTipHeader(), this.client.getPeers()]);
      const snapshot: SyncSnapshot = {
        network: this.network,
        tipBlockNumber: BigInt(tip.number ?? 0),
        tipBlockTimestampMs: BigInt(tip.timestamp ?? 0),
        peers: peers.length,
        startedAt: this.startedAt,
        lastPolledAt: Date.now(),
      };
      this.lastSnapshot = snapshot;
      for (const listener of this.snapshotListeners) listener(snapshot);
    } catch (error: unknown) {
      this.emitError(toError(error, "light client poll failed"));
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

function loadOrCreateSecretKey(network: CkbNetwork): Hex {
  const storageKey = `${SECRET_KEY_STORAGE_PREFIX}${network}`;
  const existing = window.localStorage.getItem(storageKey);
  if (existing && /^0x[0-9a-f]+$/i.test(existing)) return existing as Hex;
  const fresh = randomSecretKey();
  window.localStorage.setItem(storageKey, fresh);
  return fresh;
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : fallback);
}
