import {
  LightClient,
  LightClientSetScriptsCommand,
  randomSecretKey,
  type ScriptStatus,
} from "@nervosnetwork/ckb-light-client-js";
import {
  Cell,
  ClientPublicMainnet,
  ClientPublicTestnet,
  hexFrom,
  numFrom,
  OutPoint,
  type Hex,
  type ScriptLike,
  type Transaction,
} from "@ckb-ccc/core";
import { configFor, type CkbNetwork } from "./network-configs";
import {
  recentWatchBlock,
  FRESH_WALLET_WATCH_MARGIN_BLOCKS,
} from "./recent-watch-block";

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
  /**
   * Optional full-node JSON-RPC URL. When non-empty, transactions are
   * broadcast through it instead of the embedded light client's relay
   * protocol — which is unreliable on public testnet because most peers
   * reject tx relay from light clients (anti-spam). Set this to a CKB node
   * you control (e.g. `http://192.168.68.134:8114`).
   */
  private broadcastRpcUrl = "";

  setBroadcastRpcUrl(url: string): void {
    this.broadcastRpcUrl = url.trim();
  }

  getBroadcastRpcUrl(): string {
    return this.broadcastRpcUrl;
  }

  async start(network: CkbNetwork): Promise<void> {
    if (this.client) {
      if (this.network === network) return;
      await this.stop();
    }

    const secretKey = loadOrCreateSecretKey(network);
    const client = new LightClient();
    // We MUST pass our own config — see network-configs.ts. The WASM default
    // bootnodes are IP-only and unreachable from a browser WSS context.
    await client.start(
      { type: network === "mainnet" ? "MainNet" : "TestNet", config: configFor(network) },
      secretKey,
      "info",
      "wss",
    );

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

  /**
   * Subscribe the light client to a lock script so it syncs the blocks that
   * touch it. Without this, getCellsCapacity returns 0 — the WASM client only
   * fetches blocks for scripts it's been told to watch.
   *
   * Idempotent: re-watching an existing script is a no-op upstream.
   */
  async watchLockScript(script: ScriptLike, fromBlock: bigint = 0n): Promise<void> {
    const status: ScriptStatus = {
      script,
      scriptType: "lock",
      blockNumber: fromBlock,
    };
    await this.requireClient().setScripts([status], LightClientSetScriptsCommand.Partial);
  }

  /**
   * Watch a *freshly created* wallet's lock from near the chain tip instead of
   * genesis. A new wallet can hold nothing older than its creation, so a
   * full-history filter sync is wasted work — and is why a just-funded balance
   * otherwise takes a very long time (or never, within a session) to appear.
   *
   * Do NOT use for connected wallets that may hold pre-existing coins (JoyID,
   * imported mnemonics) — those must watch from genesis.
   */
  async watchLockScriptFromRecent(
    script: ScriptLike,
    marginBlocks: bigint = FRESH_WALLET_WATCH_MARGIN_BLOCKS,
  ): Promise<void> {
    const tip = await this.requireClient().getTipHeader();
    const from = recentWatchBlock(BigInt(tip.number ?? 0), marginBlocks);
    await this.watchLockScript(script, from);
  }

  async getWatchedScripts(): Promise<ScriptStatus[]> {
    return this.requireClient().getScripts();
  }

  /** Convenience: total CKB balance (in shannons) for a lock script. */
  async getLockBalance(script: ScriptLike): Promise<bigint> {
    const capacity = await this.requireClient().getCellsCapacity({
      script,
      scriptType: "lock",
      scriptSearchMode: "exact",
    });
    return BigInt(capacity);
  }

  /** List unspent cells belonging to a lock script (paginated, max 100/page). */
  async listCellsForLock(script: ScriptLike, limit = 100): Promise<Cell[]> {
    const response = await this.requireClient().getCells(
      { script, scriptType: "lock", scriptSearchMode: "exact" },
      "asc",
      limit,
    );
    return response.cells.map((c) =>
      Cell.from({
        outPoint: OutPoint.from({
          txHash: hexFrom(c.outPoint.txHash),
          index: numFrom(c.outPoint.index),
        }),
        cellOutput: {
          capacity: numFrom(c.cellOutput.capacity),
          lock: c.cellOutput.lock,
          type: c.cellOutput.type ?? null,
        },
        outputData: hexFrom(c.outputData),
      }),
    );
  }

  /**
   * Broadcast a fully-signed transaction. Returns the txHash.
   *
   * If `broadcastRpcUrl` is configured, routes through a full-node JSON-RPC
   * client (CCC's `ClientPublic{Testnet,Mainnet}`). Otherwise falls back to
   * the embedded light client's relay protocol — works for reads but is
   * unreliable for tx submission on public testnet (peers drop LC-relayed
   * txs as anti-spam).
   */
  async broadcastTransaction(tx: Transaction): Promise<Hex> {
    if (this.broadcastRpcUrl) {
      const ClientCtor = this.network === "mainnet" ? ClientPublicMainnet : ClientPublicTestnet;
      const fullNodeClient = new ClientCtor({ url: this.broadcastRpcUrl });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return fullNodeClient.sendTransaction(tx as any);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.requireClient().sendTransaction(tx as any);
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
