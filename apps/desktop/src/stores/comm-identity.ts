import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export interface CommIdentityState {
  /** Hex 0x-prefixed ML-DSA-65 public key (1952 bytes). */
  mlDsaPub: string;
  /** Hex 0x-prefixed ML-KEM-768 public key (1184 bytes). */
  mlKemPub: string;
  /** ckb-mldsa-lock address derived from mlDsaPub. */
  address: string;
  /** 0x-prefixed 20-byte hex of address args (cached at keygen for sync access). */
  addrHash: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms when the address first observed >= 70 CKB. Null until funded. */
  fundedAt: number | null;
  /** Tx hash of the Profile Cell publish. Null until published. */
  profileTxHash: string | null;
  /** Epoch ms when profile publish landed. */
  profilePublishedAt: number | null;
}

interface CommIdentityStore {
  identity: CommIdentityState | null;
  setIdentity: (identity: CommIdentityState) => void;
  recordFunded: (epochMs: number) => void;
  recordProfilePublished: (txHash: string, epochMs: number) => void;
  clear: () => void;
}

const storageImpl: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useCommIdentityStore = create<CommIdentityStore>()(
  persist(
    (set, get) => ({
      identity: null,
      setIdentity: (identity) => {
        if (get().identity) throw new Error("comm identity already exists; clear() first");
        if (!identity.addrHash || !/^0x[0-9a-f]{40}$/i.test(identity.addrHash)) {
          throw new Error("addrHash must be a 0x-prefixed 20-byte hex string");
        }
        set({ identity });
      },
      recordFunded: (epochMs) => {
        const current = get().identity;
        if (!current) return;
        set({ identity: { ...current, fundedAt: epochMs } });
      },
      recordProfilePublished: (txHash, epochMs) => {
        const current = get().identity;
        if (!current) return;
        set({ identity: { ...current, profileTxHash: txHash, profilePublishedAt: epochMs } });
      },
      clear: () => set({ identity: null }),
    }),
    {
      name: "chain-pay:comm-identity",
      storage: createJSONStorage(() => storageImpl),
      version: 2,
      migrate: (_persisted, fromVersion) => {
        if (fromVersion < 2) {
          // Pre-v2 records lacked addrHash. Drop them — no production users yet.
          return { identity: null };
        }
        return _persisted as { identity: CommIdentityState | null };
      },
      partialize: (state) => ({ identity: state.identity }),
    },
  ),
);
