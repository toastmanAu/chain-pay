import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { OutgoingPacket } from "@/lib/comm/types";

/**
 * A decrypted transfer packet received via the comm channel, awaiting the
 * signer's review in the inbox UI. Lives in the buffer until either:
 *   - the signer dismisses it after signing/rejecting, or
 *   - pruneExpired drops it once packet.expiresAt has passed.
 */
export interface IncomingPacketEntry {
  /** Matches OutgoingPacket.txHash; used as the store key. */
  sighashDigest: string;
  /** Full decrypted packet body for replay into SignPanel. */
  packet: OutgoingPacket;
  /** 0x-prefixed 20-byte hex of the envelope sender's identity hash. */
  senderAddrHash: string;
  /** Epoch ms when the watcher dispatched this packet. */
  receivedAt: number;
}

interface IncomingPacketsStore {
  bySighash: Record<string, IncomingPacketEntry>;
  /** Add (or replace) an entry by sighashDigest. Most recent wins. */
  enqueue: (entry: IncomingPacketEntry) => void;
  /** Remove the entry for this digest. No-op if absent. */
  dismiss: (sighashDigest: string) => void;
  /**
   * Drop entries whose packet.expiresAt has passed. `now` is injectable for
   * deterministic tests; defaults to Date.now().
   */
  pruneExpired: (now?: number) => void;
  /** Return all entries (no filtering). Useful for SignInbox enumeration. */
  getAll: () => IncomingPacketEntry[];
}

const storageImpl: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useIncomingPacketsStore = create<IncomingPacketsStore>()(
  persist(
    (set, get) => ({
      bySighash: {},
      enqueue: (entry) =>
        set((s) => ({
          bySighash: { ...s.bySighash, [entry.sighashDigest]: entry },
        })),
      dismiss: (sighashDigest) =>
        set((s) => {
          if (!(sighashDigest in s.bySighash)) return s;
          const { [sighashDigest]: _omit, ...rest } = s.bySighash;
          return { bySighash: rest };
        }),
      pruneExpired: (now = Date.now()) =>
        set((s) => {
          const next: Record<string, IncomingPacketEntry> = {};
          const nowSec = now / 1000;
          for (const [digest, e] of Object.entries(s.bySighash)) {
            // expiresAt is epoch seconds. 0 / undefined treated as "never expires"
            // to match isExpired() semantics (see lib/comm/expires-at.ts coming in T5).
            if (e.packet.expiresAt && nowSec > e.packet.expiresAt) continue;
            next[digest] = e;
          }
          return { bySighash: next };
        }),
      getAll: () => Object.values(get().bySighash),
    }),
    {
      name: "chain-pay:incoming-packets",
      storage: createJSONStorage(() => storageImpl),
      version: 1,
      partialize: (state) => ({ bySighash: state.bySighash }),
    },
  ),
);
