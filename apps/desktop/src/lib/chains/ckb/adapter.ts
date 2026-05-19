import type { ChainAdapter } from "../types";
import type { ChainId } from "@chain-pay/shared";

/**
 * CKB chain adapter — backed by the embedded WASM light client (Phase 1)
 * and `@ckb-ccc/core` for transaction construction (Phase 2).
 */
export function ckbAdapter(network: "mainnet" | "testnet"): ChainAdapter {
  const chain: ChainId = `ckb:${network}`;
  return {
    chain,
    status: "stub",

    async getBalance(account) {
      void account;
      throw new Error("ckbAdapter.getBalance — Phase 1 wires this through window.ckb.getCellsCapacity");
    },

    validateAddress(address) {
      const looksLikeCkb = address.startsWith(network === "mainnet" ? "ckb1" : "ckt1");
      return looksLikeCkb
        ? { valid: true, normalized: address }
        : { valid: false, reason: `expected ${network} address prefix` };
    },

    async estimateFee() {
      throw new Error("ckbAdapter.estimateFee — Phase 2");
    },

    async createUnsignedTransaction() {
      throw new Error("ckbAdapter.createUnsignedTransaction — Phase 2 (multisig builder in ./multisig.ts)");
    },

    async broadcastTransaction() {
      throw new Error("ckbAdapter.broadcastTransaction — Phase 2");
    },

    async getTransactionStatus() {
      throw new Error("ckbAdapter.getTransactionStatus — Phase 2");
    },
  };
}
