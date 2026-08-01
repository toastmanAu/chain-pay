import { getAddress, isAddress } from "viem";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type {
  EvmMultisig,
  PartialSignature,
  PendingTx,
  TransactionHash,
} from "@chain-pay/shared";

interface PendingTransactionsStore {
  transactions: PendingTx[];
  addTransaction: (transaction: PendingTx) => void;
  removeTransaction: (id: string) => void;
  findById: (id: string) => PendingTx | undefined;
  markBroadcasted: (id: string, hash: TransactionHash) => void;
  markConfirming: (id: string) => void;
  markConfirmed: (id: string, blockNumber: bigint) => void;
  markFailed: (id: string, reason: string) => void;
  recordEvmSignature: (
    id: string,
    signature: PartialSignature,
    multisig: EvmMultisig,
  ) => boolean;
}

const storageImpl: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { __chainPayBytes: bytesToHex(value) };
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
      markConfirmed: (id, blockNumber) =>
        updateLifecycle(set, get, id, ["confirming"], "confirmed", {
          confirmedBlockNumber: blockNumber.toString(),
          confirmedAt: new Date().toISOString(),
        }),
      markFailed: (id, reason) =>
        updateLifecycle(set, get, id, ["broadcasted", "confirming"], "failed", {
          failureReason: reason,
        }),
      recordEvmSignature: (id, signature, multisig) => {
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
        if (transaction.signatures.some((existing) => existing.signerHash.toLowerCase() === signer.toLowerCase())) {
          return false;
        }

        const signatures = [...transaction.signatures, { ...signature, signerHash: signer }];
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
      version: 1,
      partialize: (state) => ({ transactions: state.transactions }),
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
