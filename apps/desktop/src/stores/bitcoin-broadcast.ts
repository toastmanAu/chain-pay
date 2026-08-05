import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type {
  BitcoinBroadcastError,
  BitcoinBroadcastReceipt,
  BitcoinBroadcastReview,
  BitcoinChain,
  BitcoinTransactionStatusResponse,
  BitcoinFinalizedPaymentEvidence,
  BitcoinAccountingState,
} from "@chain-pay/shared";

export type BitcoinBroadcastUiState =
  | "draft"
  | "reviewing"
  | "reviewed"
  | "submitting"
  | "submitted"
  | "already_broadcast"
  | "rejected"
  | "unavailable";

export interface BitcoinBroadcastRecord {
  treasuryId: string;
  chain: BitcoinChain;
  rawTxHex: string;
  state: BitcoinBroadcastUiState;
  review: BitcoinBroadcastReview | null;
  receipt: BitcoinBroadcastReceipt | null;
  status: BitcoinTransactionStatusResponse | null;
  reorged: boolean;
  finalizedEvidence: BitcoinFinalizedPaymentEvidence | null;
  accountingState: BitcoinAccountingState;
  accountingRecordName: string | null;
  journalEntryName: string | null;
  accountingError: string | null;
  reconciliationRequired: boolean;
  error: BitcoinBroadcastError | null;
  createdAt: string;
  updatedAt: string;
}

interface BitcoinBroadcastStore {
  records: Record<string, BitcoinBroadcastRecord>;
  beginReview: (treasuryId: string, chain: BitcoinChain, rawTxHex: string) => void;
  acceptReview: (treasuryId: string, review: BitcoinBroadcastReview) => void;
  fail: (treasuryId: string, error: BitcoinBroadcastError) => void;
  beginSubmit: (treasuryId: string) => void;
  acceptReceipt: (treasuryId: string, receipt: BitcoinBroadcastReceipt) => void;
  refreshStatus: (treasuryId: string, status: BitcoinTransactionStatusResponse) => void;
  acceptFinalizedEvidence: (treasuryId: string, evidence: BitcoinFinalizedPaymentEvidence) => void;
  finalizationFailed: (treasuryId: string, message: string) => void;
  beginAccountingPost: (treasuryId: string) => void;
  markAccountingPosted: (treasuryId: string, journalEntryName: string, accountingRecordName: string) => void;
  markAccountingPostFailed: (treasuryId: string, message: string) => void;
  clear: (treasuryId: string) => void;
}

const storage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useBitcoinBroadcastStore = create<BitcoinBroadcastStore>()(
  persist(
    (set, get) => ({
      records: {},
      beginReview: (treasuryId, chain, rawTxHex) => {
        const now = new Date().toISOString();
        const existing = get().records[treasuryId];
        set((state) => ({
          records: {
            ...state.records,
            [treasuryId]: {
              treasuryId,
              chain,
              rawTxHex,
              state: "reviewing",
              review: null,
              receipt: null,
              status: null,
              reorged: false,
              finalizedEvidence: null,
              accountingState: "not_applicable",
              accountingRecordName: null,
              journalEntryName: null,
              accountingError: null,
              reconciliationRequired: false,
              error: null,
              createdAt: existing?.rawTxHex === rawTxHex ? existing.createdAt : now,
              updatedAt: now,
            },
          },
        }));
      },
      acceptReview: (treasuryId, review) => {
        const existing = requireRecord(get(), treasuryId);
        if (review.treasuryId !== treasuryId || review.chain !== existing.chain) throw new Error("Bitcoin review treasury binding is invalid");
        setRecord(set, treasuryId, {
          ...existing, state: "reviewed", review, receipt: null, status: null, reorged: false, error: null,
          finalizedEvidence: null,
          accountingState: review.reviewVersion === 2 ? "awaiting_finalization" : "not_applicable",
          accountingRecordName: null, journalEntryName: null, accountingError: null, reconciliationRequired: false,
        });
      },
      fail: (treasuryId, error) => {
        const existing = requireRecord(get(), treasuryId);
        const unavailable = error.code === "provider_unavailable";
        const already = error.code === "already_known";
        setRecord(set, treasuryId, {
          ...existing,
          state: unavailable ? "unavailable" : already ? "already_broadcast" : "rejected",
          error,
        });
      },
      beginSubmit: (treasuryId) => {
        const existing = requireRecord(get(), treasuryId);
        if (!existing.review) throw new Error("Bitcoin transaction has not been reviewed");
        setRecord(set, treasuryId, { ...existing, state: "submitting", error: null });
      },
      acceptReceipt: (treasuryId, receipt) => {
        const existing = requireRecord(get(), treasuryId);
        if (!existing.review || receipt.reviewDigest !== existing.review.digest || receipt.txid !== existing.review.txid) {
          throw new Error("Bitcoin receipt does not match the approved review");
        }
        setRecord(set, treasuryId, {
          ...existing,
          state: receipt.state === "already_broadcast" ? "already_broadcast" : "submitted",
          receipt,
          accountingState: existing.review.reviewVersion === 2 ? "awaiting_finalization" : "not_applicable",
          error: null,
        });
      },
      refreshStatus: (treasuryId, status) => {
        const existing = requireRecord(get(), treasuryId);
        const previous = existing.status;
        const wasConfirmed = previous?.state === "confirming" || previous?.state === "confirmed";
        const regression = wasConfirmed && (status.state === "pending" || status.state === "unknown" || (previous?.state === "confirmed" && status.state !== "confirmed") || (previous.blockHash !== null && status.blockHash !== null && previous.blockHash !== status.blockHash));
        const reorged = existing.reorged || regression;
        const reconciliationRequired = existing.reconciliationRequired || (reorged && existing.review?.reviewVersion === 2);
        setRecord(set, treasuryId, {
          ...existing, status, reorged, reconciliationRequired,
          accountingState: reconciliationRequired ? "reconciliation_required" : existing.accountingState,
          accountingError: reconciliationRequired ? "Bitcoin confirmation regressed; accounting reconciliation is required" : existing.accountingError,
          error: null,
        });
      },
      acceptFinalizedEvidence: (treasuryId, evidence) => {
        const existing = requireRecord(get(), treasuryId);
        if (!existing.receipt || existing.review?.reviewVersion !== 2 || existing.status?.state !== "confirmed" || existing.reconciliationRequired) throw new Error("Bitcoin payment is not eligible for finalized accounting evidence");
        assertEvidenceMatches(existing, evidence);
        setRecord(set, treasuryId, { ...existing, finalizedEvidence: evidence, accountingState: "ready", accountingError: null });
      },
      finalizationFailed: (treasuryId, message) => {
        const existing = requireRecord(get(), treasuryId);
        if (existing.accountingState !== "awaiting_finalization") return;
        setRecord(set, treasuryId, { ...existing, accountingError: message });
      },
      beginAccountingPost: (treasuryId) => {
        const existing = requireRecord(get(), treasuryId);
        if ((existing.accountingState !== "ready" && existing.accountingState !== "post_failed") || existing.status?.state !== "confirmed" || existing.reconciliationRequired) throw new Error("Bitcoin payment accounting is not ready to post");
        setRecord(set, treasuryId, { ...existing, accountingState: "posting", accountingError: null });
      },
      markAccountingPosted: (treasuryId, journalEntryName, accountingRecordName) => {
        const existing = requireRecord(get(), treasuryId);
        if ((existing.accountingState !== "posting" && existing.accountingState !== "reconciliation_required") || !journalEntryName || !accountingRecordName) throw new Error("Bitcoin payment accounting is not posting");
        const reconciling = existing.reconciliationRequired || existing.accountingState === "reconciliation_required";
        setRecord(set, treasuryId, { ...existing, accountingState: reconciling ? "reconciliation_required" : "posted", journalEntryName, accountingRecordName, accountingError: reconciling ? existing.accountingError : null });
      },
      markAccountingPostFailed: (treasuryId, message) => {
        const existing = requireRecord(get(), treasuryId);
        if (existing.accountingState !== "posting") return;
        setRecord(set, treasuryId, { ...existing, accountingState: "post_failed", accountingError: message });
      },
      clear: (treasuryId) => set((state) => {
        const records = { ...state.records };
        delete records[treasuryId];
        return { records };
      }),
    }),
    {
      name: "chain-pay:bitcoin-broadcasts",
      storage: createJSONStorage(() => storage),
      version: 2,
      partialize: (state) => ({ records: state.records }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<BitcoinBroadcastStore>;
        const records = Object.fromEntries(
          Object.entries(saved.records ?? {}).map(([treasuryId, record]) => {
            const reviewV2 = record.review?.reviewVersion === 2;
            const interruptedPosting = record.accountingState === "posting";
            const migrated = {
              ...record,
              finalizedEvidence: record.finalizedEvidence ?? null,
              accountingState: interruptedPosting ? "post_failed" as const : (record.accountingState ?? (reviewV2 ? "awaiting_finalization" : "not_applicable")),
              accountingRecordName: record.accountingRecordName ?? null,
              journalEntryName: record.journalEntryName ?? null,
              accountingError: interruptedPosting ? "The previous Bitcoin accounting post was interrupted; retry is safe" : (record.accountingError ?? null),
              reconciliationRequired: record.reconciliationRequired ?? false,
            };
            if (record.state !== "reviewing" && record.state !== "submitting") return [treasuryId, migrated];
            return [treasuryId, {
              ...migrated,
              state: record.review ? "reviewed" : "draft",
              error: {
                code: "provider_unavailable" as const,
                message: record.review
                  ? "The prior broadcast was interrupted; confirm again to check provider idempotency before retrying"
                  : "The prior review was interrupted; review the raw transaction again",
              },
            }];
          }),
        );
        return { ...current, ...saved, records };
      },
    },
  ),
);

function assertEvidenceMatches(record: BitcoinBroadcastRecord, evidence: BitcoinFinalizedPaymentEvidence): void {
  const review = record.review!;
  const receipt = record.receipt!;
  const pairs: Array<[unknown, unknown]> = [
    [evidence.chain, review.chain], [evidence.reviewDigest, review.digest], [evidence.txid, receipt.txid],
    [evidence.wtxid, review.wtxid], [evidence.rawTransactionHash, review.reviewVersion === 2 ? review.rawTransactionHash : null],
    [evidence.transactionVersion, review.version], [evidence.lockTime, review.lockTime],
    [evidence.inputValueSats, review.inputValueSats], [evidence.outputValueSats, review.outputValueSats],
    [evidence.feeSats, review.feeSats], [evidence.feeRateSatsPerVbyte, review.feeRateSatsPerVbyte],
    [JSON.stringify(evidence.outputs), JSON.stringify(review.outputs)],
  ];
  if (evidence.version !== 1 || evidence.confirmations < 6 || evidence.feePayerPolicy !== "transaction_inputs" || pairs.some(([actual, expected]) => actual !== expected)) {
    throw new Error("Finalized Bitcoin evidence does not match the immutable review");
  }
}

function requireRecord(state: BitcoinBroadcastStore, treasuryId: string): BitcoinBroadcastRecord {
  const record = state.records[treasuryId];
  if (!record) throw new Error("Bitcoin broadcast record is missing");
  return record;
}

function setRecord(
  set: (partial: (state: BitcoinBroadcastStore) => Partial<BitcoinBroadcastStore>) => void,
  treasuryId: string,
  record: BitcoinBroadcastRecord,
): void {
  set((state) => ({
    records: {
      ...state.records,
      [treasuryId]: { ...record, updatedAt: new Date().toISOString() },
    },
  }));
}
