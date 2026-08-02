import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type {
  BitcoinWatchConfig,
  BitcoinWatchSnapshot,
  BitcoinWatchSyncState,
} from "@chain-pay/shared";

interface BitcoinDiscoveryProgress {
  scannedIndex: number;
  used: boolean;
}

interface BitcoinWatchStore {
  records: Record<string, BitcoinWatchSyncState>;
  ensure: (treasuryId: string, config: BitcoinWatchConfig) => BitcoinWatchSyncState;
  beginSync: (treasuryId: string, config: BitcoinWatchConfig) => void;
  recordDiscovery: (treasuryId: string, progress: BitcoinDiscoveryProgress) => void;
  reconcileDiscovery: (treasuryId: string, usedByIndex: boolean[]) => void;
  commitSync: (treasuryId: string, snapshot: BitcoinWatchSnapshot) => void;
  failSync: (treasuryId: string, message: string) => void;
  remove: (treasuryId: string) => void;
}

const storage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export function initialBitcoinWatchSyncState(
  treasuryId: string,
  config: BitcoinWatchConfig,
): BitcoinWatchSyncState {
  const fixedAddress = config.source.kind === "address";
  return {
    treasuryId,
    status: "idle",
    nextReceiveIndex: 0,
    nextScanIndex: fixedAddress ? 1 : 0,
    lastUsedIndex: null,
    scannedThrough: fixedAddress ? 0 : -1,
    consecutiveUnused: 0,
    tipHeight: null,
    tipHash: null,
    lastSyncedAt: null,
    error: null,
    snapshot: null,
  };
}

export const useBitcoinWatchStore = create<BitcoinWatchStore>()(
  persist(
    (set, get) => ({
      records: {},
      ensure: (treasuryId, config) => {
        const existing = get().records[treasuryId];
        if (existing) return existing;
        const created = initialBitcoinWatchSyncState(treasuryId, config);
        set((state) => ({ records: { ...state.records, [treasuryId]: created } }));
        return created;
      },
      beginSync: (treasuryId, config) => {
        const existing = get().records[treasuryId] ?? initialBitcoinWatchSyncState(treasuryId, config);
        set((state) => ({
          records: {
            ...state.records,
            [treasuryId]: {
              ...existing,
              status: "syncing",
              error: null,
              // An interrupted pass resumes from its persisted cursor. A completed
              // pass begins discovery immediately after the last known used index.
              ...(existing.status === "syncing"
                ? {}
                : {
                    nextScanIndex:
                      config.source.kind === "address" ? 1 : (existing.lastUsedIndex ?? -1) + 1,
                    consecutiveUnused: 0,
                  }),
            },
          },
        }));
      },
      recordDiscovery: (treasuryId, progress) => {
        const existing = get().records[treasuryId];
        if (!existing) throw new Error("Bitcoin watch sync record is missing");
        if (existing.status !== "syncing") throw new Error("Bitcoin watch sync is not active");
        if (progress.scannedIndex !== existing.nextScanIndex) {
          throw new Error("Bitcoin discovery progress is not contiguous");
        }
        if (!Number.isSafeInteger(progress.scannedIndex) || progress.scannedIndex < 0) {
          throw new Error("Bitcoin discovery index is invalid");
        }
        const lastUsedIndex = progress.used ? progress.scannedIndex : existing.lastUsedIndex;
        set((state) => ({
          records: {
            ...state.records,
            [treasuryId]: {
              ...existing,
              lastUsedIndex,
              nextReceiveIndex: (lastUsedIndex ?? -1) + 1,
              scannedThrough: progress.scannedIndex,
              nextScanIndex: progress.scannedIndex + 1,
              consecutiveUnused: progress.used ? 0 : existing.consecutiveUnused + 1,
            },
          },
        }));
      },
      reconcileDiscovery: (treasuryId, usedByIndex) => {
        const existing = get().records[treasuryId];
        if (!existing) throw new Error("Bitcoin watch sync record is missing");
        let lastUsedIndex: number | null = null;
        for (let index = 0; index < usedByIndex.length; index++) {
          if (usedByIndex[index]) lastUsedIndex = index;
        }
        let consecutiveUnused = 0;
        for (let index = usedByIndex.length - 1; index >= 0 && !usedByIndex[index]; index--) {
          consecutiveUnused++;
        }
        set((state) => ({
          records: {
            ...state.records,
            [treasuryId]: {
              ...existing,
              lastUsedIndex,
              nextReceiveIndex: (lastUsedIndex ?? -1) + 1,
              scannedThrough: usedByIndex.length - 1,
              nextScanIndex: usedByIndex.length,
              consecutiveUnused,
            },
          },
        }));
      },
      commitSync: (treasuryId, snapshot) => {
        const existing = get().records[treasuryId];
        if (!existing) throw new Error("Bitcoin watch sync record is missing");
        validateSnapshot(snapshot);
        set((state) => ({
          records: {
            ...state.records,
            [treasuryId]: {
              ...existing,
              status: "ready",
              tipHeight: snapshot.tipHeight,
              tipHash: snapshot.tipHash,
              lastSyncedAt: new Date().toISOString(),
              error: null,
              // Atomic replacement is deliberate: stale confirmations and UTXOs
              // cannot survive a provider snapshot taken after a reorg.
              snapshot,
            },
          },
        }));
      },
      failSync: (treasuryId, message) => {
        const existing = get().records[treasuryId];
        if (!existing) return;
        set((state) => ({
          records: {
            ...state.records,
            [treasuryId]: { ...existing, status: "error", error: message },
          },
        }));
      },
      remove: (treasuryId) => {
        set((state) => {
          const records = { ...state.records };
          delete records[treasuryId];
          return { records };
        });
      },
    }),
    {
      name: "chain-pay:bitcoin-watch",
      storage: createJSONStorage(() => storage),
      version: 1,
      partialize: (state) => ({ records: state.records }),
    },
  ),
);

function validateSnapshot(snapshot: BitcoinWatchSnapshot): void {
  if (!Number.isSafeInteger(snapshot.tipHeight) || snapshot.tipHeight < 0) {
    throw new Error("Bitcoin provider returned an invalid tip height");
  }
  if (!/^[0-9a-f]{64}$/.test(snapshot.tipHash)) {
    throw new Error("Bitcoin provider returned an invalid tip hash");
  }
  assertSatoshiText(snapshot.balanceSats, false);
  for (const utxo of snapshot.utxos) assertSatoshiText(utxo.valueSats, false);
  for (const transaction of snapshot.transactions) assertSatoshiText(transaction.netValueSats, true);
}

function assertSatoshiText(value: string, signed: boolean): void {
  const pattern = signed ? /^-?(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/;
  if (!pattern.test(value)) throw new Error("Bitcoin provider returned an invalid satoshi amount");
  BigInt(value);
}
