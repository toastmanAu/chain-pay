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

/**
 * Collapse duplicate sources that share an `address`, keeping the entry with
 * the oldest `createdAt`. If `activeSourceId` pointed at a dropped duplicate,
 * repoint it to the surviving entry for that same address. Pure + total.
 */
export function dedupeSourcesByAddress(
  sources: Source[],
  activeSourceId: string | null,
): { sources: Source[]; activeSourceId: string | null } {
  const byAddr = new Map<string, Source>();
  for (const s of sources) {
    const cur = byAddr.get(s.address);
    if (!cur || s.createdAt < cur.createdAt) byAddr.set(s.address, s);
  }
  const survivors = [...byAddr.values()];
  let active = activeSourceId;
  if (active && !survivors.some((s) => s.id === active)) {
    const dropped = sources.find((s) => s.id === active);
    active = (dropped ? byAddr.get(dropped.address)?.id : undefined) ?? survivors[0]?.id ?? null;
  }
  return { sources: survivors, activeSourceId: active };
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
        set((st) => {
          // Dedup by address: a CKB address fully identifies a lock on a network,
          // so a repeat Connect/keystore-add for the same wallet is a no-op.
          if (st.sources.some((x) => x.address === s.address)) return st;
          return {
            sources: [...st.sources, s],
            activeSourceId: st.activeSourceId ?? s.id,
          };
        }),
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
      version: 2,
      migrate: (persisted, version) => {
        const st = (persisted ?? {}) as Partial<Pick<SourcesStore, "sources" | "activeSourceId">>;
        const sources = Array.isArray(st.sources) ? st.sources : [];
        if (version < 2) {
          return dedupeSourcesByAddress(sources, st.activeSourceId ?? null);
        }
        return { sources, activeSourceId: st.activeSourceId ?? null };
      },
      partialize: (st) => ({ sources: st.sources, activeSourceId: st.activeSourceId }),
    },
  ),
);
