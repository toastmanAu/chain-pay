import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { VendorProfile } from "@chain-pay/shared";

interface VendorsStore {
  vendors: VendorProfile[];
  addVendor: (v: VendorProfile) => void;
  updateVendor: (id: string, patch: Partial<Omit<VendorProfile, "id" | "createdAt">>) => void;
  removeVendor: (id: string) => void;
  findById: (id: string) => VendorProfile | undefined;
  /** Exact-match dedup. Treat undefined taxId as a value (so two no-taxId vendors with same name match). */
  findByDisplayNameAndTaxId: (displayName: string, taxId: string | undefined) => VendorProfile | undefined;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}
function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  return value;
}

const vendorsStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

const jsonStorage = createJSONStorage(() => vendorsStorage, {
  replacer: bigintReplacer,
  reviver: bigintReviver,
});

export const useVendorsStore = create<VendorsStore>()(
  persist(
    (set, get) => ({
      vendors: [],
      addVendor: (v) => set((s) => ({ vendors: [...s.vendors, v] })),
      updateVendor: (id, patch) =>
        set((s) => ({
          vendors: s.vendors.map((v) =>
            v.id === id ? { ...v, ...patch, id: v.id, createdAt: v.createdAt, updatedAt: new Date().toISOString() } : v,
          ),
        })),
      removeVendor: (id) => set((s) => ({ vendors: s.vendors.filter((v) => v.id !== id) })),
      findById: (id) => get().vendors.find((v) => v.id === id),
      findByDisplayNameAndTaxId: (displayName, taxId) =>
        get().vendors.find((v) => v.displayName === displayName && v.taxId === taxId),
    }),
    {
      name: "chain-pay:vendors",
      storage: jsonStorage,
      version: 1,
      partialize: (state) => ({ vendors: state.vendors }),
    },
  ),
);
