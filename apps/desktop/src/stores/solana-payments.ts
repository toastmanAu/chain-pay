import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type {
  SolanaPaymentProposal,
  SolanaPaymentReceipt,
  SolanaPaymentRecord,
  SolanaSignatureEnvelope,
  SolanaTransactionState,
} from "@chain-pay/shared";

interface SolanaPaymentsStore {
  records: Record<string, SolanaPaymentRecord>;
  acceptProposal(treasuryId: string, proposal: SolanaPaymentProposal): void;
  addVerifiedSignature(treasuryId: string, envelope: SolanaSignatureEnvelope): void;
  beginSubmit(treasuryId: string): void;
  submissionFailed(treasuryId: string, message: string): void;
  acceptReceipt(treasuryId: string, receipt: SolanaPaymentReceipt): void;
  updateTransactionState(treasuryId: string, state: SolanaTransactionState): void;
  fail(treasuryId: string, message: string): void;
  clear(treasuryId: string): void;
}

const storage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useSolanaPaymentsStore = create<SolanaPaymentsStore>()(
  persist(
    (set, get) => ({
      records: {},
      acceptProposal: (treasuryId, proposal) => {
        if (proposal.treasuryId !== treasuryId) throw new Error("Solana payment proposal treasury does not match");
        const now = new Date().toISOString();
        set((state) => ({ records: { ...state.records, [treasuryId]: {
          treasuryId,
          state: "reviewed",
          proposal,
          signatures: [],
          receipt: null,
          transactionState: null,
          rollbackDetected: false,
          error: null,
          updatedAt: now,
        } } }));
      },
      addVerifiedSignature: (treasuryId, envelope) => {
        const record = get().records[treasuryId];
        if (!record) throw new Error("Solana payment proposal is missing");
        if (record.receipt) throw new Error("Submitted Solana payment cannot accept signatures");
        if (envelope.reviewDigest !== record.proposal.reviewDigest || envelope.treasuryId !== treasuryId || envelope.chain !== record.proposal.chain) {
          throw new Error("Solana signature does not match the active review");
        }
        if (!record.proposal.requiredSigners.includes(envelope.signer)) throw new Error("Solana signature is from an unknown signer");
        if (record.signatures.some((item) => item.signer === envelope.signer)) throw new Error("Solana signer already provided a signature");
        const signatures = [...record.signatures, envelope].sort(
          (a, b) => record.proposal.requiredSigners.indexOf(a.signer) - record.proposal.requiredSigners.indexOf(b.signer),
        );
        const ready = signatures.length === record.proposal.requiredSigners.length;
        set((state) => ({ records: { ...state.records, [treasuryId]: {
          ...record,
          signatures,
          state: ready ? "ready" : "collecting_signatures",
          error: null,
          updatedAt: new Date().toISOString(),
        } } }));
      },
      beginSubmit: (treasuryId) => {
        const record = get().records[treasuryId];
        if (!record || record.state !== "ready") throw new Error("Solana payment is not ready for submission");
        set((state) => ({ records: { ...state.records, [treasuryId]: { ...record, state: "submitting", error: null, updatedAt: new Date().toISOString() } } }));
      },
      submissionFailed: (treasuryId, message) => {
        const record = get().records[treasuryId];
        if (!record || record.receipt || record.state !== "submitting") return;
        const allSignaturesPresent = record.signatures.length === record.proposal.requiredSigners.length;
        set((state) => ({ records: { ...state.records, [treasuryId]: {
          ...record,
          state: allSignaturesPresent ? "ready" : "failed",
          error: message,
          updatedAt: new Date().toISOString(),
        } } }));
      },
      acceptReceipt: (treasuryId, receipt) => {
        const record = get().records[treasuryId];
        if (!record || receipt.reviewDigest !== record.proposal.reviewDigest) throw new Error("Solana payment receipt does not match the active review");
        set((state) => ({ records: { ...state.records, [treasuryId]: { ...record, state: "submitted", receipt, transactionState: "processed", error: null, updatedAt: new Date().toISOString() } } }));
      },
      updateTransactionState: (treasuryId, transactionState) => {
        const record = get().records[treasuryId];
        if (!record?.receipt) return;
        const rollbackDetected = isRegression(record.transactionState, transactionState) || record.rollbackDetected;
        set((state) => ({ records: { ...state.records, [treasuryId]: { ...record, transactionState, rollbackDetected, updatedAt: new Date().toISOString() } } }));
      },
      fail: (treasuryId, message) => {
        const record = get().records[treasuryId];
        if (!record) return;
        const state = record.receipt ? "submitted" : "failed";
        set((current) => ({ records: { ...current.records, [treasuryId]: { ...record, state, error: message, updatedAt: new Date().toISOString() } } }));
      },
      clear: (treasuryId) => set((state) => {
        const records = { ...state.records };
        delete records[treasuryId];
        return { records };
      }),
    }),
    {
      name: "chain-pay:solana-payments",
      storage: createJSONStorage(() => storage),
      version: 1,
      partialize: (state) => ({ records: state.records }),
      merge: (persisted, current) => {
        const records = (persisted as Partial<SolanaPaymentsStore> | undefined)?.records ?? {};
        return {
          ...current,
          records: Object.fromEntries(Object.entries(records).map(([id, record]) => [id, {
            ...record,
            state: record.state === "submitting" ? "ready" : record.state,
            error: record.state === "submitting" ? "The previous submission was interrupted; revalidation is required" : record.error,
          }])),
        };
      },
    },
  ),
);

function isRegression(previous: SolanaTransactionState | null, next: SolanaTransactionState): boolean {
  if (previous === null) return false;
  const rank: Record<SolanaTransactionState, number> = { unknown: 0, failed: 0, processed: 1, confirmed: 2, finalized: 3 };
  return (previous === "confirmed" || previous === "finalized") && rank[next] < rank[previous];
}
