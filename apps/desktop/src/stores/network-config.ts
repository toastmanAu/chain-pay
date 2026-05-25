import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { CkbNetwork } from "@/lib/light-client/network-configs";

interface NetworkConfigStore {
  /** Currently selected CKB network. Default "testnet". Changing requires app
   *  restart (light-client IndexedDB is not partitioned by network and would
   *  panic on chain-data mismatch otherwise). */
  network: CkbNetwork;
  /**
   * Optional full-node RPC URL used for broadcasting transactions. Empty
   * string = fall back to the embedded light client's `sendTransaction`,
   * which is unreliable on public testnet because peers reject tx relay
   * from light clients.
   *
   * Example: "http://192.168.68.134:8114" (local testnet full node)
   */
  broadcastRpcUrl: string;
  setNetwork: (network: CkbNetwork) => void;
  setBroadcastRpcUrl: (url: string) => void;
}

const networkConfigStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useNetworkConfigStore = create<NetworkConfigStore>()(
  persist(
    (set) => ({
      network: "testnet",
      broadcastRpcUrl: "",
      setNetwork: (network) => set({ network }),
      setBroadcastRpcUrl: (url) => set({ broadcastRpcUrl: url.trim() }),
    }),
    {
      name: "chain-pay:network-config",
      storage: createJSONStorage(() => networkConfigStorage),
      version: 2,
      migrate: (persistedState, fromVersion) => {
        if (fromVersion < 2) {
          const prev = (persistedState ?? {}) as Partial<NetworkConfigStore>;
          return { ...prev, network: prev.network ?? "testnet" };
        }
        return persistedState as NetworkConfigStore;
      },
      partialize: (state) => ({
        network: state.network,
        broadcastRpcUrl: state.broadcastRpcUrl,
      }),
    },
  ),
);
