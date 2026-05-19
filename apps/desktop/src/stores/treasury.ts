import { create } from "zustand";
import type { MultisigConfig, Treasury } from "@chain-pay/shared";

interface TreasuryStore {
  treasuries: Treasury[];
  addTreasury: (t: Treasury) => void;
  removeTreasury: (id: string) => void;
  findByMultisig: (cfg: MultisigConfig) => Treasury | undefined;
}

export const useTreasuryStore = create<TreasuryStore>((set, get) => ({
  treasuries: [],
  addTreasury: (t) => set((s) => ({ treasuries: [...s.treasuries, t] })),
  removeTreasury: (id) => set((s) => ({ treasuries: s.treasuries.filter((t) => t.id !== id) })),
  findByMultisig: (cfg) =>
    get().treasuries.find(
      (t) => t.multisig.chain === cfg.chain && t.multisig.address === cfg.address,
    ),
}));
