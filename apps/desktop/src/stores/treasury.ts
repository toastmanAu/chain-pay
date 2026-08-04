import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import {
  isBitcoinWatchTreasury,
  isMultisigTreasury,
  isSolanaWatchTreasury,
  type BitcoinWatchConfig,
  type MultisigConfig,
  type SolanaWatchConfig,
  type Treasury,
} from "@chain-pay/shared";
import { bitcoinWatchIdentity } from "../lib/chains/btc/watch-source";
import { useBitcoinWatchStore } from "./bitcoin-watch";
import { solanaWatchIdentity } from "../lib/chains/sol/address";
import { useSolanaWatchStore } from "./solana-watch";
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
  findByBitcoinWatch: (cfg: BitcoinWatchConfig) => Treasury | undefined;
  findBySolanaWatch: (cfg: SolanaWatchConfig) => Treasury | undefined;
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
        const duplicate = get().treasuries.some((existing) => {
          if (isBitcoinWatchTreasury(t)) {
            return (
              isBitcoinWatchTreasury(existing) &&
              bitcoinWatchIdentity(existing.watch) === bitcoinWatchIdentity(t.watch)
            );
          }
          if (isSolanaWatchTreasury(t)) {
            return isSolanaWatchTreasury(existing) &&
              solanaWatchIdentity(existing.watch.chain, existing.watch.address) ===
                solanaWatchIdentity(t.watch.chain, t.watch.address);
          }
          return (
            isMultisigTreasury(existing) &&
            isMultisigTreasury(t) &&
            existing.multisig.chain === t.multisig.chain &&
            existing.multisig.address.toLowerCase() === t.multisig.address.toLowerCase()
          );
        });
        if (duplicate) throw new Error("A treasury with this watch source already exists");

        // Refusal invariant: refuse to add a treasury whose signer hash matches
        // the current comm-identity hash. Defense-in-depth alongside the
        // peer-book check.
        const commHash = getOwnIdentityHash();
        if (commHash && isMultisigTreasury(t) && "pubkeyHashes" in t.multisig) {
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
      removeTreasury: (id) => {
        useBitcoinWatchStore.getState().remove(id);
        useSolanaWatchStore.getState().remove(id);
        set((s) => ({
          treasuries: s.treasuries.filter((t) => t.id !== id),
          activeTreasuryId: s.activeTreasuryId === id ? null : s.activeTreasuryId,
        }));
      },
      findByMultisig: (cfg) =>
        get().treasuries.find(
          (t) =>
            isMultisigTreasury(t) &&
            t.multisig.chain === cfg.chain &&
            t.multisig.address === cfg.address,
        ),
      findByBitcoinWatch: (cfg) =>
        get().treasuries.find(
          (t) =>
            isBitcoinWatchTreasury(t) &&
            bitcoinWatchIdentity(t.watch) === bitcoinWatchIdentity(cfg),
        ),
      findBySolanaWatch: (cfg) =>
        get().treasuries.find(
          (t) => isSolanaWatchTreasury(t) &&
            solanaWatchIdentity(t.watch.chain, t.watch.address) ===
              solanaWatchIdentity(cfg.chain, cfg.address),
        ),
    }),
    {
      name: "chain-pay:treasuries",
      storage: jsonStorage,
      version: 4,
      partialize: (state) => ({
        treasuries: state.treasuries,
        activeTreasuryId: state.activeTreasuryId,
      }),
      // v1 → v2: backfill activeTreasuryId for users who added treasuries before
      // the field existed. Pick the first treasury so single-treasury workflows
      // (the only Phase-3a-supported shape) just work. Always returns an
      // explicit activeTreasuryId so rehydrate's shallow merge can't leak stale
      // in-memory state.
      migrate: (persisted, fromVersion) => {
        const state = persisted as Partial<TreasuryStore> | undefined;
        if (!state) return state;
        if (fromVersion >= 2) return state;
        const treasuries = state.treasuries ?? [];
        const activeTreasuryId = state.activeTreasuryId ?? treasuries[0]?.id ?? null;
        return { ...state, activeTreasuryId };
      },
    },
  ),
);
