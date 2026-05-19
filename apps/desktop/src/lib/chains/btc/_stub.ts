import type { ChainAdapter } from "../types";

export const btcAdapterStub: ChainAdapter = {
  chain: "btc:mainnet",
  status: "unavailable",
  async getBalance() {
    throw new Error("BTC adapter is Phase 5");
  },
  validateAddress() {
    return { valid: false, reason: "BTC adapter is Phase 5" };
  },
  async estimateFee() {
    throw new Error("BTC adapter is Phase 5");
  },
  async createUnsignedTransaction() {
    throw new Error("BTC adapter is Phase 5");
  },
  async broadcastTransaction() {
    throw new Error("BTC adapter is Phase 5");
  },
  async getTransactionStatus() {
    throw new Error("BTC adapter is Phase 5");
  },
};
