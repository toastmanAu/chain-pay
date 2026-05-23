import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { MultisigConfig, Treasury } from "@chain-pay/shared";

interface TreasuryStore {
  treasuries: Treasury[];
  addTreasury: (t: Treasury) => void;
  removeTreasury: (id: string) => void;
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

export const useTreasuryStore = create<TreasuryStore>()(
  persist(
    (set, get) => ({
      treasuries: [],
      addTreasury: (t) => set((s) => ({ treasuries: [...s.treasuries, t] })),
      removeTreasury: (id) =>
        set((s) => ({ treasuries: s.treasuries.filter((t) => t.id !== id) })),
      findByMultisig: (cfg) =>
        get().treasuries.find(
          (t) => t.multisig.chain === cfg.chain && t.multisig.address === cfg.address,
        ),
    }),
    {
      name: "chain-pay:treasuries",
      storage: jsonStorage,
      version: 1,
      partialize: (state) => ({ treasuries: state.treasuries }),
    },
  ),
);
