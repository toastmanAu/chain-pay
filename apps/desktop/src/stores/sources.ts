import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Source } from "@chain-pay/shared";

interface SourcesStore {
  sources: Source[];
  activeSourceId: string | null;
  addSource: (s: Source) => void;
  removeSource: (id: string) => void;
  setActiveSource: (id: string | null) => void;
  findById: (id: string) => Source | undefined;
}

const sourcesStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useSourcesStore = create<SourcesStore>()(
  persist(
    (set, get) => ({
      sources: [],
      activeSourceId: null,
      setActiveSource: (id) => set({ activeSourceId: id }),
      addSource: (s) =>
        set((st) => ({
          sources: [...st.sources, s],
          activeSourceId: st.activeSourceId ?? s.id,
        })),
      removeSource: (id) =>
        set((st) => ({
          sources: st.sources.filter((x) => x.id !== id),
          activeSourceId: st.activeSourceId === id ? null : st.activeSourceId,
        })),
      findById: (id) => get().sources.find((x) => x.id === id),
    }),
    {
      name: "chain-pay:sources",
      storage: createJSONStorage(() => sourcesStorage),
      version: 1,
      partialize: (st) => ({ sources: st.sources, activeSourceId: st.activeSourceId }),
    },
  ),
);
