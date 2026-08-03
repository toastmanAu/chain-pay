import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type {
  BitcoinBroadcastError,
  BitcoinBroadcastReceipt,
  BitcoinBroadcastReview,
  BitcoinChain,
  BitcoinTransactionStatusResponse,
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
        setRecord(set, treasuryId, { ...existing, state: "reviewed", review, receipt: null, status: null, reorged: false, error: null });
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
          error: null,
        });
      },
      refreshStatus: (treasuryId, status) => {
        const existing = requireRecord(get(), treasuryId);
        const previous = existing.status;
        const wasConfirmed = previous?.state === "confirming" || previous?.state === "confirmed";
        const reorged = existing.reorged || (wasConfirmed && (status.state === "pending" || status.state === "unknown" || (previous.blockHash !== null && status.blockHash !== null && previous.blockHash !== status.blockHash)));
        setRecord(set, treasuryId, { ...existing, status, reorged });
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
      version: 1,
      partialize: (state) => ({ records: state.records }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<BitcoinBroadcastStore>;
        const records = Object.fromEntries(
          Object.entries(saved.records ?? {}).map(([treasuryId, record]) => {
            if (record.state !== "reviewing" && record.state !== "submitting") return [treasuryId, record];
            return [treasuryId, {
              ...record,
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
