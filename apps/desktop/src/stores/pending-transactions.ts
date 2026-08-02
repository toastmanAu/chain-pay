import { getAddress, isAddress } from "viem";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type {
  EvmMultisig,
  EvmAddress,
  PartialSignature,
  PendingTx,
  TransactionHash,
} from "@chain-pay/shared";
import { verifySafeOwnerSignature } from "@/lib/chains/evm/safe-owner-signature";

interface PendingTransactionsStore {
  transactions: PendingTx[];
  addTransaction: (transaction: PendingTx) => void;
  removeTransaction: (id: string) => void;
  findById: (id: string) => PendingTx | undefined;
  markBroadcasted: (id: string, hash: TransactionHash) => void;
  markConfirming: (id: string) => void;
  markConfirmed: (id: string, confirmation: EvmConfirmationEvidence) => void;
  markPosting: (id: string) => void;
  markPosted: (id: string, journalEntryName: string, recordName: string) => void;
  markPostFailed: (id: string, reason: string) => void;
  recoverInterruptedPostings: () => void;
  markFailed: (id: string, reason: string) => void;
  recordEvmSignature: (
    id: string,
    signature: PartialSignature,
    multisig: EvmMultisig,
  ) => Promise<boolean>;
}

export interface EvmConfirmationEvidence {
  blockNumber: bigint;
  confirmedAt: string;
  executorAddress: EvmAddress;
  gasUsed: bigint;
  effectiveGasPriceWei: bigint;
  gasFeeWei: bigint;
}

export const INTERRUPTED_EVM_POST_ERROR =
  "Accounting post was interrupted before ChainPay received the result. Retry is safe and will reuse the immutable source record and Journal Entry.";

const storageImpl: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { __chainPayBytes: bytesToHex(value) };
  if (typeof value === "bigint") return { __chainPayBigInt: value.toString() };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "__chainPayBytes" in value &&
    typeof value.__chainPayBytes === "string"
  ) {
    return hexToBytes(value.__chainPayBytes);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "__chainPayBigInt" in value &&
    typeof value.__chainPayBigInt === "string" &&
    /^-?\d+$/.test(value.__chainPayBigInt)
  ) {
    return BigInt(value.__chainPayBigInt);
  }
  return value;
}

export const usePendingTransactionsStore = create<PendingTransactionsStore>()(
  persist(
    (set, get) => ({
      transactions: [],
      addTransaction: (transaction) => {
        if (transaction.state !== "awaiting_signature") {
          throw new Error("a new pending transaction must await signatures");
        }
        set((state) =>
          state.transactions.some((existing) => existing.id === transaction.id)
            ? state
            : { transactions: [...state.transactions, transaction] },
        );
      },
      removeTransaction: (id) =>
        set((state) => ({ transactions: state.transactions.filter((transaction) => transaction.id !== id) })),
      findById: (id) => get().transactions.find((transaction) => transaction.id === id),
      markBroadcasted: (id, hash) => {
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("invalid broadcast transaction hash");
        updateLifecycle(set, get, id, ["ready_to_broadcast"], "broadcasted", {
          broadcastedHash: hash,
        });
      },
      markConfirming: (id) =>
        updateLifecycle(set, get, id, ["broadcasted"], "confirming", {}),
      markConfirmed: (id, confirmation) =>
        updateLifecycle(set, get, id, ["confirming"], "confirmed", {
          confirmedBlockNumber: confirmation.blockNumber.toString(),
          confirmedAt: confirmation.confirmedAt,
          executorAddress: getAddress(confirmation.executorAddress),
          receiptGasUsed: confirmation.gasUsed.toString(),
          receiptEffectiveGasPriceWei: confirmation.effectiveGasPriceWei.toString(),
          receiptGasFeeWei: confirmation.gasFeeWei.toString(),
        }),
      markPosting: (id) =>
        updateLifecycle(set, get, id, ["confirmed", "post_failed"], "posting", {
          postError: undefined,
        }),
      markPosted: (id, journalEntryName, recordName) =>
        updateLifecycle(set, get, id, ["posting"], "posted", {
          journalEntryName,
          accountingRecordName: recordName,
          postError: undefined,
        }),
      markPostFailed: (id, reason) =>
        updateLifecycle(set, get, id, ["posting"], "post_failed", { postError: reason }),
      recoverInterruptedPostings: () =>
        set((state) => ({
          transactions: state.transactions.map((transaction) =>
            transaction.state === "posting"
              ? {
                  ...transaction,
                  state: "post_failed" as const,
                  postError: INTERRUPTED_EVM_POST_ERROR,
                  updatedAt: new Date().toISOString(),
                }
              : transaction,
          ),
        })),
      markFailed: (id, reason) =>
        updateLifecycle(set, get, id, ["broadcasted", "confirming"], "failed", {
          failureReason: reason,
        }),
      recordEvmSignature: async (id, signature, multisig) => {
        const transaction = get().transactions.find((candidate) => candidate.id === id);
        if (!transaction) throw new Error(`pending transaction not found: ${id}`);
        if (transaction.chain !== multisig.chain) throw new Error("treasury chain does not match transaction");
        if (transaction.state !== "awaiting_signature" && transaction.state !== "ready_to_broadcast") {
          throw new Error(`cannot add a signature while transaction is ${transaction.state}`);
        }
        if (!isAddress(signature.signerHash, { strict: false })) throw new Error("signature has an invalid signer address");
        if (signature.bytes.length !== 65) throw new Error("Safe owner signature must be 65 bytes");

        const signer = getAddress(signature.signerHash);
        if (!multisig.owners.some((owner) => owner.toLowerCase() === signer.toLowerCase())) {
          throw new Error("connected signer is not an owner of this Safe");
        }
        const verified = await verifySafeOwnerSignature({
          digest: transaction.signingDigest,
          signer,
          signature: signature.bytes,
        });
        const current = get().transactions.find((candidate) => candidate.id === id);
        if (!current) throw new Error(`pending transaction not found: ${id}`);
        if (current.state !== "awaiting_signature" && current.state !== "ready_to_broadcast") {
          throw new Error(`cannot add a signature while transaction is ${current.state}`);
        }
        if (current.signatures.some((existing) => existing.signerHash.toLowerCase() === signer.toLowerCase())) {
          return false;
        }

        const signatures = [
          ...current.signatures,
          { ...signature, signerHash: verified.signer, bytes: verified.bytes },
        ];
        set((state) => ({
          transactions: state.transactions.map((candidate) =>
            candidate.id === id
              ? {
                  ...candidate,
                  signatures,
                  state:
                    signatures.length >= multisig.threshold
                      ? "ready_to_broadcast"
                      : "awaiting_signature",
                  updatedAt: new Date().toISOString(),
                }
              : candidate,
          ),
        }));
        return true;
      },
    }),
    {
      name: "chain-pay:pending-transactions",
      storage: createJSONStorage(() => storageImpl, { replacer, reviver }),
      version: 2,
      migrate: (persisted) => persisted as PendingTransactionsStore,
      partialize: (state) => ({ transactions: state.transactions }),
      onRehydrateStorage: () => (state) => state?.recoverInterruptedPostings(),
    },
  ),
);

function updateLifecycle(
  set: (updater: (state: PendingTransactionsStore) => Partial<PendingTransactionsStore>) => void,
  get: () => PendingTransactionsStore,
  id: string,
  allowed: PendingTx["state"][],
  next: PendingTx["state"],
  patch: Partial<PendingTx>,
): void {
  const transaction = get().transactions.find((candidate) => candidate.id === id);
  if (!transaction) throw new Error(`pending transaction not found: ${id}`);
  if (!allowed.includes(transaction.state)) {
    throw new Error(`cannot transition pending transaction ${transaction.state} → ${next}`);
  }
  set((state) => ({
    transactions: state.transactions.map((candidate) =>
      candidate.id === id
        ? { ...candidate, ...patch, state: next, updatedAt: new Date().toISOString() }
        : candidate,
    ),
  }));
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error("invalid persisted byte string");
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}
