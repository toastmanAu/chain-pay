import { create } from "zustand";
import { lightClient } from "@/lib/light-client/client";
import type { CkbNetwork } from "@/lib/light-client/network-configs";

export interface CkbSyncState {
  started: boolean;
  starting: boolean;
  network: CkbNetwork | null;
  tipBlockNumber: bigint;
  tipBlockTimestampMs: bigint;
  peers: number;
  lastPolledAt: number;
  startedAt: number;
  lastError: string | null;
}

interface SyncStore {
  ckb: CkbSyncState;
  startCkb: (network: CkbNetwork) => Promise<void>;
  stopCkb: () => Promise<void>;
}

const initialCkb: CkbSyncState = {
  started: false,
  starting: false,
  network: null,
  tipBlockNumber: 0n,
  tipBlockTimestampMs: 0n,
  peers: 0,
  lastPolledAt: 0,
  startedAt: 0,
  lastError: null,
};

const host = lightClient();

host.onSnapshot((snapshot) => {
  useSyncStore.setState((state) => ({
    ckb: {
      ...state.ckb,
      started: true,
      starting: false,
      network: snapshot.network,
      tipBlockNumber: snapshot.tipBlockNumber,
      tipBlockTimestampMs: snapshot.tipBlockTimestampMs,
      peers: snapshot.peers,
      lastPolledAt: snapshot.lastPolledAt,
      startedAt: snapshot.startedAt,
      lastError: null,
    },
  }));
});

host.onError((error) => {
  useSyncStore.setState((state) => ({
    ckb: { ...state.ckb, lastError: error.message },
  }));
});

export const useSyncStore = create<SyncStore>((set) => ({
  ckb: initialCkb,
  startCkb: async (network) => {
    if (host.isStarted() && host.currentNetwork() === network) return;
    set((state) => ({ ckb: { ...state.ckb, starting: true, lastError: null } }));
    try {
      await host.start(network);
      set((state) => ({ ckb: { ...state.ckb, started: true, starting: false, network } }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "failed to start light client";
      set((state) => ({ ckb: { ...state.ckb, starting: false, lastError: message } }));
      throw error;
    }
  },
  stopCkb: async () => {
    await host.stop();
    set({ ckb: initialCkb });
  },
}));
