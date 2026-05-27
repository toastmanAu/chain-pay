import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { InvoiceRecord } from "@chain-pay/shared";

interface InvoiceDraftsStore {
  drafts: Record<string, Partial<InvoiceRecord>>;
  upsertDraft: (invoiceId: string, partial: Partial<InvoiceRecord>) => void;
  getDraft: (invoiceId: string) => Partial<InvoiceRecord> | undefined;
  clearDraft: (invoiceId: string) => void;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}
function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  return value;
}

const draftsStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

const jsonStorage = createJSONStorage(() => draftsStorage, {
  replacer: bigintReplacer,
  reviver: bigintReviver,
});

export const useInvoiceDraftsStore = create<InvoiceDraftsStore>()(
  persist(
    (set, get) => ({
      drafts: {},
      upsertDraft: (invoiceId, partial) =>
        set((s) => ({
          drafts: { ...s.drafts, [invoiceId]: { ...(s.drafts[invoiceId] ?? {}), ...partial } },
        })),
      getDraft: (invoiceId) => get().drafts[invoiceId],
      clearDraft: (invoiceId) =>
        set((s) => {
          const next = { ...s.drafts };
          delete next[invoiceId];
          return { drafts: next };
        }),
    }),
    {
      name: "chain-pay:invoice-drafts",
      storage: jsonStorage,
      version: 1,
      partialize: (state) => ({ drafts: state.drafts }),
    },
  ),
);
