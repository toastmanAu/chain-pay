import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { InvoiceApprovalStatus, InvoiceRecord } from "@chain-pay/shared";
import { assertCanTransitionInvoice } from "@/lib/invoices/state-machine";

/** Local-only wrapper field — backlink to the linked PayrollBatch or VendorPaymentBatch id. */
export interface StoredInvoiceRecord extends InvoiceRecord {
  /** Set when approval.status transitions to "queued-for-signing". */
  batchId?: string;
}

interface InvoicesStore {
  invoices: StoredInvoiceRecord[];
  addInvoice: (i: InvoiceRecord) => void;
  updateInvoice: (
    id: string,
    patch: Partial<Omit<StoredInvoiceRecord, "id" | "createdAt" | "schema_version">>,
  ) => void;
  markInReview: (id: string) => void;
  markQueuedForSigning: (id: string, batchId: string, reviewerId: string) => void;
  markSigned: (id: string, link: { txHash: string; chain: "ckb" | "evm" }) => void;
  markRejected: (id: string, reason: string) => void;
  appendEdit: (
    id: string,
    entry: { field: string; before: unknown; after: unknown; edited_by: string },
  ) => void;
  findById: (id: string) => StoredInvoiceRecord | undefined;
  filterByStatus: (status: InvoiceApprovalStatus) => StoredInvoiceRecord[];
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}
function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  return value;
}

const invoicesStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

const jsonStorage = createJSONStorage(() => invoicesStorage, {
  replacer: bigintReplacer,
  reviver: bigintReviver,
});

function transitionStatus(
  invoice: StoredInvoiceRecord,
  to: InvoiceApprovalStatus,
  extra: Partial<InvoiceRecord["approval"]> = {},
): StoredInvoiceRecord {
  assertCanTransitionInvoice(invoice.approval.status, to);
  return {
    ...invoice,
    approval: { ...invoice.approval, ...extra, status: to },
    updatedAt: new Date().toISOString(),
  };
}

export const useInvoicesStore = create<InvoicesStore>()(
  persist(
    (set, get) => ({
      invoices: [],
      addInvoice: (i) =>
        set((s) =>
          s.invoices.some((x) => x.id === i.id) ? s : { invoices: [...s.invoices, i] },
        ),
      updateInvoice: (id, patch) =>
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === id
              ? {
                  ...i,
                  ...patch,
                  id: i.id,
                  createdAt: i.createdAt,
                  schema_version: i.schema_version,
                  updatedAt: new Date().toISOString(),
                }
              : i,
          ),
        })),
      markInReview: (id) =>
        set((s) => ({
          invoices: s.invoices.map((i) => (i.id === id ? transitionStatus(i, "in-review") : i)),
        })),
      markQueuedForSigning: (id, batchId, reviewerId) =>
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === id
              ? {
                  ...transitionStatus(i, "queued-for-signing", {
                    reviewed_by: reviewerId,
                    reviewed_at: new Date().toISOString(),
                  }),
                  batchId,
                }
              : i,
          ),
        })),
      markSigned: (id, link) =>
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === id
              ? {
                  ...transitionStatus(i, "signed"),
                  chainpay_link: { tx_hash: link.txHash, chain: link.chain },
                }
              : i,
          ),
        })),
      markRejected: (id, reason) =>
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === id
              ? transitionStatus(i, "rejected", { rejection_reason: reason })
              : i,
          ),
        })),
      appendEdit: (id, entry) =>
        set((s) => ({
          invoices: s.invoices.map((i) => {
            if (i.id !== id) return i;
            const existing = i.approval.edits_made ?? [];
            const fullEntry = { ...entry, edited_at: new Date().toISOString() };
            return {
              ...i,
              approval: { ...i.approval, edits_made: [...existing, fullEntry] },
              updatedAt: new Date().toISOString(),
            };
          }),
        })),
      findById: (id) => get().invoices.find((i) => i.id === id),
      filterByStatus: (status) => get().invoices.filter((i) => i.approval.status === status),
    }),
    {
      name: "chain-pay:invoices",
      storage: jsonStorage,
      version: 1,
      partialize: (state) => ({ invoices: state.invoices }),
    },
  ),
);
