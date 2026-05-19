import { create } from "zustand";

interface CkbSyncState {
  started: boolean;
  network: "mainnet" | "testnet" | null;
  tipBlockNumber: bigint;
  syncedBlockNumber: bigint;
  peers: number;
  synced: boolean;
}

interface SyncStore {
  ckb: CkbSyncState;
  startCkb: (network: "mainnet" | "testnet") => Promise<void>;
  stopCkb: () => Promise<void>;
}

const initialCkb: CkbSyncState = {
  started: false,
  network: null,
  tipBlockNumber: 0n,
  syncedBlockNumber: 0n,
  peers: 0,
  synced: false,
};

export const useSyncStore = create<SyncStore>((set) => {
  if (typeof window !== "undefined" && window.ckb) {
    window.ckb.onSyncProgress((p) => {
      set({
        ckb: {
          started: true,
          network: p.network,
          tipBlockNumber: p.tipBlockNumber,
          syncedBlockNumber: p.syncedBlockNumber,
          peers: p.peers,
          synced: p.syncedBlockNumber >= p.tipBlockNumber && p.tipBlockNumber > 0n,
        },
      });
    });
  }

  return {
    ckb: initialCkb,
    startCkb: async (network) => {
      await window.ckb.start(network);
      set((s) => ({ ckb: { ...s.ckb, started: true, network } }));
    },
    stopCkb: async () => {
      await window.ckb.stop();
      set({ ckb: initialCkb });
    },
  };
});
