import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { PayeeProfile } from "@chain-pay/shared";

interface PayeesStore {
  payees: PayeeProfile[];
  addPayee: (p: PayeeProfile) => void;
  updatePayee: (id: string, patch: Partial<Omit<PayeeProfile, "id" | "createdAt">>) => void;
  removePayee: (id: string) => void;
  findById: (id: string) => PayeeProfile | undefined;
}

// PayeeProfile.salaryFiat.minor is bigint (cents/pence/etc.) and is not native
// to JSON. Tag bigints with a trailing "n" on the way out and detect that
// marker on the way back in. Same pattern as the treasury store.
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) {
    return BigInt(value.slice(0, -1));
  }
  return value;
}

const payeeStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

const jsonStorage = createJSONStorage(() => payeeStorage, {
  replacer: bigintReplacer,
  reviver: bigintReviver,
});

export const usePayeesStore = create<PayeesStore>()(
  persist(
    (set, get) => ({
      payees: [],
      addPayee: (p) => set((s) => ({ payees: [...s.payees, p] })),
      updatePayee: (id, patch) =>
        set((s) => ({
          payees: s.payees.map((p) =>
            p.id === id ? { ...p, ...patch, id: p.id, createdAt: p.createdAt, updatedAt: new Date().toISOString() } : p,
          ),
        })),
      removePayee: (id) => set((s) => ({ payees: s.payees.filter((p) => p.id !== id) })),
      findById: (id) => get().payees.find((p) => p.id === id),
    }),
    {
      name: "chain-pay:payees",
      storage: jsonStorage,
      version: 1,
      partialize: (state) => ({ payees: state.payees }),
    },
  ),
);
