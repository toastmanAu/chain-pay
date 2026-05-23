import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { PayrollBatch, PayrollBatchState } from "@chain-pay/shared";
import { assertCanTransition } from "@/lib/payroll/state-machine";

interface PayrollBatchesStore {
  batches: PayrollBatch[];
  /**
   * Batch id the user has elected to resume in PayPanel. PayPanel reads this
   * on mount, hydrates from the matching batch, then clears it. Lives in the
   * store (not URL state) so the Resume button on PayrollBatches doesn't need
   * to know about routing internals.
   */
  selectedDraftId: string | null;
  addBatch: (b: PayrollBatch) => void;
  updateBatch: (id: string, patch: Partial<Omit<PayrollBatch, "id" | "createdAt">>) => void;
  /** Advance a batch's state through the validated state machine. Throws on invalid transitions or unknown ids. */
  transition: (id: string, to: PayrollBatchState) => void;
  removeBatch: (id: string) => void;
  findById: (id: string) => PayrollBatch | undefined;
  selectDraft: (id: string | null) => void;
}

// PayrollBatch holds bigints inside `lines[i].fiat.minor`, `lines[i].crypto.value`,
// and `lines[i].feeAllocated.value`. Same suffix-tagged JSON pattern as the
// treasury and payees stores so localStorage round-trips lossless.
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) {
    return BigInt(value.slice(0, -1));
  }
  return value;
}

const batchesStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

const jsonStorage = createJSONStorage(() => batchesStorage, {
  replacer: bigintReplacer,
  reviver: bigintReviver,
});

export const usePayrollBatchesStore = create<PayrollBatchesStore>()(
  persist(
    (set, get) => ({
      batches: [],
      selectedDraftId: null,
      addBatch: (b) => set((s) => ({ batches: [...s.batches, b] })),
      selectDraft: (id) => set({ selectedDraftId: id }),
      updateBatch: (id, patch) =>
        set((s) => ({
          batches: s.batches.map((b) =>
            b.id === id
              ? { ...b, ...patch, id: b.id, createdAt: b.createdAt, updatedAt: new Date().toISOString() }
              : b,
          ),
        })),
      transition: (id, to) => {
        const current = get().batches.find((b) => b.id === id);
        if (!current) throw new Error(`batch not found: ${id}`);
        assertCanTransition(current.state, to);
        set((s) => ({
          batches: s.batches.map((b) =>
            b.id === id ? { ...b, state: to, updatedAt: new Date().toISOString() } : b,
          ),
        }));
      },
      removeBatch: (id) => set((s) => ({ batches: s.batches.filter((b) => b.id !== id) })),
      findById: (id) => get().batches.find((b) => b.id === id),
    }),
    {
      name: "chain-pay:payroll-batches",
      storage: jsonStorage,
      version: 1,
      partialize: (state) => ({ batches: state.batches }),
    },
  ),
);
