import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type {
  SolanaTransactionState,
  SolanaWatchConfig,
  SolanaWatchSnapshot,
  SolanaWatchSyncState,
} from "@chain-pay/shared";

interface SolanaWatchStore {
  records: Record<string, SolanaWatchSyncState>;
  ensure(treasuryId: string, config: SolanaWatchConfig): SolanaWatchSyncState;
  beginSync(treasuryId: string, config: SolanaWatchConfig): void;
  commitSync(treasuryId: string, snapshot: SolanaWatchSnapshot): void;
  updateTransactionStatus(treasuryId: string, signature: string, state: SolanaTransactionState): void;
  failSync(treasuryId: string, message: string): void;
  remove(treasuryId: string): void;
}

const storage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export function initialSolanaWatchSyncState(treasuryId: string): SolanaWatchSyncState {
  return {
    treasuryId,
    status: "idle",
    slot: null,
    blockhash: null,
    lastSyncedAt: null,
    error: null,
    rollbackDetected: false,
    rollbackSignatures: [],
    snapshot: null,
  };
}

export const useSolanaWatchStore = create<SolanaWatchStore>()(
  persist(
    (set, get) => ({
      records: {},
      ensure: (treasuryId) => {
        const existing = get().records[treasuryId];
        if (existing) return existing;
        const created = initialSolanaWatchSyncState(treasuryId);
        set((state) => ({ records: { ...state.records, [treasuryId]: created } }));
        return created;
      },
      beginSync: (treasuryId) => {
        const existing = get().records[treasuryId] ?? initialSolanaWatchSyncState(treasuryId);
        set((state) => ({ records: { ...state.records, [treasuryId]: { ...existing, status: "syncing", error: null } } }));
      },
      commitSync: (treasuryId, snapshot) => {
        validateSnapshot(snapshot);
        const existing = get().records[treasuryId];
        if (!existing) throw new Error("Solana watch sync record is missing");
        const rollbackSignatures = detectRollbacks(existing.snapshot, snapshot);
        const contextRollback = detectContextRollback(existing.snapshot, snapshot);
        set((state) => ({
          records: {
            ...state.records,
            [treasuryId]: {
              ...existing,
              status: "ready",
              slot: snapshot.slot,
              blockhash: snapshot.blockhash,
              lastSyncedAt: new Date().toISOString(),
              error: null,
              rollbackDetected: contextRollback || rollbackSignatures.length > 0,
              rollbackSignatures,
              snapshot,
            },
          },
        }));
      },
      updateTransactionStatus: (treasuryId, signature, transactionState) => {
        const existing = get().records[treasuryId];
        if (!existing?.snapshot) return;
        const prior = existing.snapshot.transactions.find((transaction) => transaction.signature === signature);
        if (!prior) return;
        const rollback = regressed(prior.state, transactionState);
        const signatures = rollback
          ? [...new Set([...existing.rollbackSignatures, signature])]
          : existing.rollbackSignatures;
        const snapshot = {
          ...existing.snapshot,
          transactions: existing.snapshot.transactions.map((transaction) =>
            transaction.signature === signature ? { ...transaction, state: transactionState } : transaction),
        };
        set((state) => ({ records: { ...state.records, [treasuryId]: {
          ...existing,
          rollbackDetected: signatures.length > 0,
          rollbackSignatures: signatures,
          snapshot,
        } } }));
      },
      failSync: (treasuryId, message) => {
        const existing = get().records[treasuryId];
        if (!existing) return;
        set((state) => ({ records: { ...state.records, [treasuryId]: { ...existing, status: "error", error: message } } }));
      },
      remove: (treasuryId) => set((state) => {
        const records = { ...state.records };
        delete records[treasuryId];
        return { records };
      }),
    }),
    {
      name: "chain-pay:solana-watch",
      storage: createJSONStorage(() => storage),
      version: 1,
      partialize: (state) => ({ records: state.records }),
      merge: (persisted, current) => {
        const stored = (persisted as Partial<SolanaWatchStore> | undefined)?.records ?? {};
        const records = Object.fromEntries(Object.entries(stored).map(([id, record]) => [id, {
          ...record,
          status: record.status === "syncing" ? "idle" : record.status,
          error: record.status === "syncing" ? "The previous sync was interrupted" : record.error,
          rollbackDetected: record.rollbackDetected ?? false,
          rollbackSignatures: record.rollbackSignatures ?? [],
        }]));
        return { ...current, records };
      },
    },
  ),
);

function detectRollbacks(previous: SolanaWatchSnapshot | null, next: SolanaWatchSnapshot): string[] {
  if (!previous) return [];
  const current = new Map(next.transactions.map((transaction) => [transaction.signature, transaction.state]));
  const rollbacks: string[] = [];
  for (const transaction of previous.transactions) {
    const state = current.get(transaction.signature);
    if (state ? regressed(transaction.state, state) : !next.historyTruncated && settled(transaction.state)) {
      rollbacks.push(transaction.signature);
    }
  }
  return rollbacks;
}

function detectContextRollback(previous: SolanaWatchSnapshot | null, next: SolanaWatchSnapshot): boolean {
  if (!previous) return false;
  const priorSlot = BigInt(previous.slot);
  const nextSlot = BigInt(next.slot);
  return nextSlot < priorSlot || (nextSlot === priorSlot && next.blockhash !== previous.blockhash);
}

function settled(state: SolanaTransactionState): boolean {
  return state === "confirmed" || state === "finalized";
}

function regressed(previous: SolanaTransactionState, next: SolanaTransactionState): boolean {
  const rank: Record<SolanaTransactionState, number> = { unknown: 0, processed: 1, confirmed: 2, finalized: 3, failed: 0 };
  return settled(previous) && rank[next] < rank[previous];
}

function validateSnapshot(snapshot: SolanaWatchSnapshot): void {
  assertUnsigned(snapshot.slot, "slot");
  assertUnsigned(snapshot.lastValidBlockHeight, "last valid block height");
  assertUnsigned(snapshot.balanceLamports, "balance");
  if (!snapshot.address || !snapshot.blockhash) throw new Error("Solana provider returned incomplete snapshot metadata");
  const seen = new Set<string>();
  for (const transaction of snapshot.transactions) {
    if (seen.has(transaction.signature)) throw new Error("Solana provider returned duplicate signatures");
    seen.add(transaction.signature);
    assertUnsigned(transaction.slot, "transaction slot");
    if (transaction.netLamports !== null && !/^-?(?:0|[1-9]\d*)$/.test(transaction.netLamports)) {
      throw new Error("Solana provider returned an invalid lamport delta");
    }
    if (transaction.feeLamports !== null) assertUnsigned(transaction.feeLamports, "transaction fee");
  }
}

function assertUnsigned(value: string, label: string): void {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`Solana provider returned an invalid ${label}`);
  BigInt(value);
}
