import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Invoice, InvoiceApprovalStatus, InvoiceRecord } from "@chain-pay/shared";
import { assertCanTransitionInvoice } from "@/lib/invoices/state-machine";

/**
 * Runtime-only extraction lifecycle status.
 * Existing persisted records that pre-date this field will have `undefined` here;
 * downstream consumers (Task 12 hook) treat `undefined` as equivalent to "pending"
 * (i.e. no extraction has been attempted yet). No backfill migration is applied —
 * adding a default-undefined field to persisted records is safe.
 */
export type ExtractionStatus = "pending" | "running" | "extracted" | "failed";

/** Local-only wrapper fields — runtime state that is NOT part of the durable schema. */
export interface StoredInvoiceRecord extends InvoiceRecord {
  /** Set when approval.status transitions to "queued-for-signing". */
  batchId?: string;
  /** Tracks where this record is in the OCR/extraction pipeline. */
  extractionStatus: ExtractionStatus;
  /** Human-readable error message when extractionStatus === "failed". */
  extractionError?: string;
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
  markExtractionRunning: (id: string) => void;
  markExtractionFailed: (id: string, error: string) => void;
  applyExtraction: (
    id: string,
    result: {
      stages: Invoice["extraction"]["pipeline"]["stages"];
      body: Partial<Invoice["invoice"]>;
      field_confidences: Record<string, number>;
      warnings: NonNullable<Invoice["extraction"]["warnings"]>;
    },
  ) => void;
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
          s.invoices.some((x) => x.id === i.id)
            ? s
            : { invoices: [...s.invoices, { ...i, extractionStatus: "pending" as const }] },
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
          // Idempotent on already-in-review: route effects can fire this twice under
          // React Strict Mode. Other illegal transitions still throw.
          invoices: s.invoices.map((i) => {
            if (i.id !== id) return i;
            if (i.approval.status === "in-review") return i;
            return transitionStatus(i, "in-review");
          }),
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
      markExtractionRunning: (id) =>
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === id
              ? { ...i, extractionStatus: "running" as const, updatedAt: new Date().toISOString() }
              : i,
          ),
        })),

      markExtractionFailed: (id, error) =>
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === id
              ? {
                  ...i,
                  extractionStatus: "failed" as const,
                  extractionError: error,
                  updatedAt: new Date().toISOString(),
                }
              : i,
          ),
        })),

      // Contract: `result` is a complete atomic result from one pipeline invocation —
      // not an incremental partial. The idempotency guard compares only the head (last)
      // stage signature, which is sufficient when the caller never sends partial runs.
      // Retries land a fresh `result` and append a new run to the stages history.
      applyExtraction: (id, result) =>
        set((s) => ({
          invoices: s.invoices.map((i) => {
            if (i.id !== id) return i;
            // Idempotency: skip if the head stage signature already matches incoming head.
            const existingTop = i.extraction.pipeline.stages.at(-1);
            const incomingTop = result.stages.at(-1);
            if (
              existingTop &&
              incomingTop &&
              existingTop.name === incomingTop.name &&
              existingTop.model === incomingTop.model &&
              existingTop.version === incomingTop.version &&
              existingTop.elapsed_ms === incomingTop.elapsed_ms
            ) {
              return i;
            }
            // User-typed-preserve merge: only fill fields that are still at the default-empty
            // shape (undefined, null, empty string, or total===0). Fields the user has already
            // set are left untouched.
            const merged: Invoice["invoice"] = { ...i.invoice };
            for (const [k, v] of Object.entries(result.body) as [
              keyof Invoice["invoice"],
              unknown,
            ][]) {
              const current = merged[k];
              // `total` is required + numeric and coerced to 0 at form-init by ReviewInvoiceForm.fromInvoice,
              // so 0 is the "not yet typed" sentinel for it. `subtotal` and `tax_total` are optional and
              // stay undefined until the user types them, so the `undefined` arm covers them naturally.
              const isDefaultEmpty =
                current === undefined ||
                current === null ||
                current === "" ||
                (k === "total" && current === 0);
              if (isDefaultEmpty) {
                (merged as Record<string, unknown>)[k] = v;
              }
            }
            return {
              ...i,
              invoice: merged,
              extraction: {
                ...i.extraction,
                pipeline: { stages: [...i.extraction.pipeline.stages, ...result.stages] },
                field_confidences: {
                  ...(i.extraction.field_confidences ?? {}),
                  ...result.field_confidences,
                },
                warnings: [...(i.extraction.warnings ?? []), ...result.warnings],
                extracted_at: new Date().toISOString(),
              },
              extractionStatus: "extracted" as const,
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
