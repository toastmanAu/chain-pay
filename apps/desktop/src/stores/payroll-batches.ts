import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type {
  CommSendSlotStatus,
  PartialSigEntry,
  PayrollBatch,
  PayrollBatchState,
} from "@chain-pay/shared";
import { assertCanTransition, canTransition } from "@/lib/payroll/state-machine";
import { recoverPubkeyHashFromSignature } from "@/lib/signers/ckb-secp256k1";
import { useIncomingSigsStore } from "./incoming-sigs";

export interface MultisigDrainCfg {
  /** Threshold — auto-transitions to `approved` when partialSigs reaches this. */
  m: number;
  /** Canonical slot → pubkey hash mapping for sig validation. */
  pubkeyHashes: readonly `0x${string}`[];
}

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
  /**
   * Pull all buffered incoming sigs whose sighashDigest matches this batch's,
   * validate each against the given multisig config, and merge the valid ones
   * into partialSigs. Auto-transitions calculated → approved when partialSigs
   * reaches M. Invalid entries are dropped silently (NOT re-buffered).
   */
  drainIncomingSigsInto: (
    batchId: string,
    multisig: MultisigDrainCfg,
  ) => { merged: number; rejected: number };
  /** Record per-slot comm-send status (idle/sending/sent/acked/error) on a batch. */
  recordCommSendStatus: (
    batchId: string,
    slotIndex: number,
    status: CommSendSlotStatus["status"],
    detail?: { txHash?: string; error?: string; retryCount?: number; nextRetryAt?: number },
  ) => void;
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
      drainIncomingSigsInto: (batchId, multisig) => {
        const batch = get().batches.find((b) => b.id === batchId);
        if (!batch || !batch.sighashDigest) return { merged: 0, rejected: 0 };

        const existingSlots = new Set((batch.partialSigs ?? []).map((p) => p.slotIndex));
        const buffered = useIncomingSigsStore.getState().drain(batch.sighashDigest);

        const accepted: PartialSigEntry[] = [];
        let rejected = 0;
        for (const entry of buffered) {
          if (existingSlots.has(entry.slotIndex)) {
            rejected++;
            continue;
          }
          const expected = multisig.pubkeyHashes[entry.slotIndex];
          if (!expected) {
            rejected++;
            continue;
          }
          const recovered = recoverPubkeyHashFromSignature(batch.sighashDigest, entry.signature);
          if (!recovered || recovered !== expected) {
            rejected++;
            continue;
          }
          accepted.push({
            slotIndex: entry.slotIndex,
            signature: entry.signature,
            signerPubkeyHash: expected,
            ...(entry.sourceCommTx !== undefined ? { sourceCommTx: entry.sourceCommTx } : {}),
          });
          existingSlots.add(entry.slotIndex);
        }

        if (accepted.length === 0) return { merged: 0, rejected };

        const mergedSigs = [...(batch.partialSigs ?? []), ...accepted];
        const shouldPromote =
          mergedSigs.length === multisig.m && canTransition(batch.state, "approved");

        set((s) => ({
          batches: s.batches.map((b) =>
            b.id === batchId
              ? {
                  ...b,
                  partialSigs: mergedSigs,
                  ...(shouldPromote ? { state: "approved" as PayrollBatchState } : {}),
                  updatedAt: new Date().toISOString(),
                }
              : b,
          ),
        }));

        return { merged: accepted.length, rejected };
      },
      recordCommSendStatus: (batchId, slotIndex, status, detail) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            const existing = b.commSendStatus?.[slotIndex] ?? {};
            const slot: CommSendSlotStatus = {
              ...existing,
              status,
              updatedAt: Date.now(),
              ...(detail?.txHash !== undefined ? { txHash: detail.txHash } : {}),
              ...(detail?.error !== undefined ? { error: detail.error } : {}),
              ...(detail?.retryCount !== undefined ? { retryCount: detail.retryCount } : {}),
              ...(detail?.nextRetryAt !== undefined ? { nextRetryAt: detail.nextRetryAt } : {}),
            };
            return {
              ...b,
              commSendStatus: { ...(b.commSendStatus ?? {}), [slotIndex]: slot },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },
    }),
    {
      name: "chain-pay:payroll-batches",
      storage: jsonStorage,
      version: 1,
      partialize: (state) => ({ batches: state.batches }),
    },
  ),
);
