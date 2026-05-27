import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { MultisigConfig, Treasury } from "@chain-pay/shared";
import { assertNotMultisigSigner } from "../lib/comm/refusal-invariant";
import { getOwnIdentityHash } from "../lib/comm/own-identity-hash";

interface TreasuryStore {
  treasuries: Treasury[];
  /**
   * Currently selected treasury id used by features like invoice review.
   * Null when no treasury has been chosen yet (or treasuries is empty).
   */
  activeTreasuryId: string | null;
  addTreasury: (t: Treasury) => void;
  removeTreasury: (id: string) => void;
  setActiveTreasury: (id: string | null) => void;
  findByMultisig: (cfg: MultisigConfig) => Treasury | undefined;
}

// Treasury.since (RFC 0017 time-lock) is bigint, which is not native to JSON.
// Tag bigints with a trailing "n" on the way out and detect that marker on the
// way back in. Plain numbers stay plain so the persisted file is still readable.
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) {
    return BigInt(value.slice(0, -1));
  }
  return value;
}

// Zustand's persist middleware reads `localStorage` lazily on first access, so
// importing this module in a node-only test environment is safe as long as the
// test provides its own Storage shim before calling any store action.
const treasuryStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

const jsonStorage = createJSONStorage(() => treasuryStorage, {
  replacer: bigintReplacer,
  reviver: bigintReviver,
});

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export const useTreasuryStore = create<TreasuryStore>()(
  persist(
    (set, get) => ({
      treasuries: [],
      activeTreasuryId: null,
      setActiveTreasury: (id) => set({ activeTreasuryId: id }),
      addTreasury: (t) => {
        // Refusal invariant: refuse to add a treasury whose signer hash matches
        // the current comm-identity hash. Defense-in-depth alongside the
        // peer-book check.
        const commHash = getOwnIdentityHash();
        if (commHash && "pubkeyHashes" in t.multisig) {
          for (const hashHex of t.multisig.pubkeyHashes) {
            const signerBytes = hexToBytes(hashHex);
            assertNotMultisigSigner(signerBytes, () => [
              { treasuryId: "__comm_identity__", pubkeyHash: commHash },
            ]);
          }
        }
        set((s) => ({
          treasuries: [...s.treasuries, t],
          // Auto-select the first treasury added so single-treasury workflows
          // don't have to call setActiveTreasury manually.
          activeTreasuryId: s.activeTreasuryId ?? t.id,
        }));
      },
      removeTreasury: (id) =>
        set((s) => ({
          treasuries: s.treasuries.filter((t) => t.id !== id),
          activeTreasuryId: s.activeTreasuryId === id ? null : s.activeTreasuryId,
        })),
      findByMultisig: (cfg) =>
        get().treasuries.find(
          (t) => t.multisig.chain === cfg.chain && t.multisig.address === cfg.address,
        ),
    }),
    {
      name: "chain-pay:treasuries",
      storage: jsonStorage,
      version: 1,
      partialize: (state) => ({
        treasuries: state.treasuries,
        activeTreasuryId: state.activeTreasuryId,
      }),
    },
  ),
);
