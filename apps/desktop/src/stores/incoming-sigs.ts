import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/**
 * A signature received via the comm channel, buffered before the operator's
 * PayrollBatch store has consumed it. Lives in the buffer until either:
 *   - drainIncomingSigsInto pulls it (matched to a known batch), or
 *   - prune() drops it after maxAgeMs.
 */
export interface IncomingSigEntry {
  /** The sighashDigest the signer signed; matches PayrollBatch.sighashDigest. */
  sighashDigest: string;
  /** Which multisig slot this signature is for. */
  slotIndex: number;
  /** Raw secp65 signature, 0x-prefixed. */
  signature: string;
  /** 0x-prefixed 20-byte hex of the envelope sender's identity hash. */
  senderAddrHash: string;
  /** Epoch ms at which the watcher dispatched the envelope. */
  receivedAt: number;
  /** Tx hash of the signer's notification cell, if known. Audit trail. */
  sourceCommTx?: string;
}

interface IncomingSigsStore {
  bySighash: Record<string, IncomingSigEntry[]>;
  /** Append an entry; dedups by (sighashDigest, slotIndex, signature) triplet. */
  enqueue: (entry: IncomingSigEntry) => void;
  /** Return all entries for this digest and clear the key. */
  drain: (sighashDigest: string) => IncomingSigEntry[];
  /** Return all entries for this digest without modifying state. */
  peek: (sighashDigest: string) => IncomingSigEntry[];
  /**
   * Drop entries older than maxAgeMs. `now` is injectable for deterministic
   * tests; defaults to Date.now(). Empty digests are removed entirely.
   */
  prune: (maxAgeMs: number, now?: number) => void;
}

const storageImpl: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

function isSameEntry(a: IncomingSigEntry, b: IncomingSigEntry): boolean {
  return (
    a.sighashDigest === b.sighashDigest &&
    a.slotIndex === b.slotIndex &&
    a.signature === b.signature
  );
}

export const useIncomingSigsStore = create<IncomingSigsStore>()(
  persist(
    (set, get) => ({
      bySighash: {},
      enqueue: (entry) => {
        const current = get().bySighash[entry.sighashDigest] ?? [];
        if (current.some((e) => isSameEntry(e, entry))) return;
        set((s) => ({
          bySighash: {
            ...s.bySighash,
            [entry.sighashDigest]: [...current, entry],
          },
        }));
      },
      drain: (sighashDigest) => {
        const entries = get().bySighash[sighashDigest];
        if (!entries) return [];
        set((s) => {
          const { [sighashDigest]: _omit, ...rest } = s.bySighash;
          return { bySighash: rest };
        });
        return entries;
      },
      peek: (sighashDigest) => get().bySighash[sighashDigest] ?? [],
      prune: (maxAgeMs, now = Date.now()) => {
        const cutoff = now - maxAgeMs;
        set((s) => {
          const next: Record<string, IncomingSigEntry[]> = {};
          for (const [digest, entries] of Object.entries(s.bySighash)) {
            const kept = entries.filter((e) => e.receivedAt >= cutoff);
            if (kept.length > 0) next[digest] = kept;
          }
          return { bySighash: next };
        });
      },
    }),
    {
      name: "chain-pay:incoming-sigs",
      storage: createJSONStorage(() => storageImpl),
      version: 1,
      partialize: (state) => ({ bySighash: state.bySighash }),
    },
  ),
);
