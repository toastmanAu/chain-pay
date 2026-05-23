import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

interface NetworkConfigStore {
  /**
   * Optional full-node RPC URL used for broadcasting transactions. Empty
   * string = fall back to the embedded light client's `sendTransaction`,
   * which is unreliable on public testnet because peers reject tx relay
   * from light clients.
   *
   * Example: "http://192.168.68.134:8114" (local testnet full node)
   */
  broadcastRpcUrl: string;
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
      broadcastRpcUrl: "",
      setBroadcastRpcUrl: (url) => set({ broadcastRpcUrl: url.trim() }),
    }),
    {
      name: "chain-pay:network-config",
      storage: createJSONStorage(() => networkConfigStorage),
      version: 1,
      partialize: (state) => ({ broadcastRpcUrl: state.broadcastRpcUrl }),
    },
  ),
);
