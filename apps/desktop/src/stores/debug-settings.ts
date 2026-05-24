import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

interface DebugSettingsStore {
  /** Show the clipboard bottom-bar even when comm is configured. */
  showClipboard: boolean;
  setShowClipboard: (v: boolean) => void;
}

const storageImpl: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useDebugSettingsStore = create<DebugSettingsStore>()(
  persist(
    (set) => ({
      showClipboard: false,
      setShowClipboard: (v) => set({ showClipboard: v }),
    }),
    {
      name: "chain-pay:debug-settings",
      storage: createJSONStorage(() => storageImpl),
      version: 1,
      partialize: (state) => ({ showClipboard: state.showClipboard }),
    },
  ),
);
