import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export const CLIPBOARD_BIN_COUNT = 4;

export interface ClipboardBin {
  id: number;
  /** User-set or auto-detected label. */
  label: string;
  /** Empty string = unset. */
  value: string;
  /** Epoch ms; null when bin is unset. */
  savedAt: number | null;
}

interface ClipboardStore {
  bins: ClipboardBin[];
  setBin: (id: number, value: string, label?: string) => void;
  clearBin: (id: number) => void;
  renameBin: (id: number, label: string) => void;
  /** Save into the first empty bin; rotates oldest if all four are full. */
  saveToNextOpen: (value: string, label?: string) => number;
}

function emptyBin(id: number): ClipboardBin {
  return { id, label: `Bin ${id + 1}`, value: "", savedAt: null };
}

const initialBins: ClipboardBin[] = Array.from({ length: CLIPBOARD_BIN_COUNT }, (_, i) =>
  emptyBin(i),
);

const clipboardStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useClipboardStore = create<ClipboardStore>()(
  persist(
    (set, get) => ({
      bins: initialBins,
      setBin: (id, value, label) =>
        set((s) => ({
          bins: s.bins.map((b) =>
            b.id === id ? { ...b, value, label: label ?? b.label, savedAt: Date.now() } : b,
          ),
        })),
      clearBin: (id) =>
        set((s) => ({ bins: s.bins.map((b) => (b.id === id ? emptyBin(id) : b)) })),
      renameBin: (id, label) =>
        set((s) => ({ bins: s.bins.map((b) => (b.id === id ? { ...b, label } : b)) })),
      saveToNextOpen: (value, label) => {
        const bins = get().bins;
        const open = bins.find((b) => !b.value);
        if (open) {
          get().setBin(open.id, value, label);
          return open.id;
        }
        const sorted = [...bins].sort((a, b) => (a.savedAt ?? 0) - (b.savedAt ?? 0));
        const oldest = sorted[0] ?? bins[0];
        if (!oldest) return -1; // bins should never be empty by construction
        get().setBin(oldest.id, value, label);
        return oldest.id;
      },
    }),
    {
      name: "chain-pay:clipboard",
      storage: createJSONStorage(() => clipboardStorage),
      version: 1,
      partialize: (state) => ({ bins: state.bins }),
    },
  ),
);
