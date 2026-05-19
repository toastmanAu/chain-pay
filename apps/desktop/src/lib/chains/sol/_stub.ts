import type { ChainAdapter } from "../types";

export const solAdapterStub: ChainAdapter = {
  chain: "sol:mainnet",
  status: "unavailable",
  async getBalance() {
    throw new Error("SOL adapter is Phase 5");
  },
  validateAddress() {
    return { valid: false, reason: "SOL adapter is Phase 5" };
  },
  async estimateFee() {
    throw new Error("SOL adapter is Phase 5");
  },
  async createUnsignedTransaction() {
    throw new Error("SOL adapter is Phase 5");
  },
  async broadcastTransaction() {
    throw new Error("SOL adapter is Phase 5");
  },
  async getTransactionStatus() {
    throw new Error("SOL adapter is Phase 5");
  },
};
