import type { ChainAdapter } from "../types";
import type { ChainId } from "@chain-pay/shared";
import { isAddress } from "viem";

/**
 * EVM chain adapter. Treasury is a Safe contract; transactions are EIP-712
 * SafeTx typed messages signed by N-of-M owners.
 */
export function evmAdapter(chainId: number): ChainAdapter {
  const chain: ChainId = `evm:${chainId}`;
  return {
    chain,
    status: "stub",

    async getBalance() {
      throw new Error("evmAdapter.getBalance — Phase 3 (viem publicClient.getBalance)");
    },

    validateAddress(address) {
      const ok = isAddress(address, { strict: false });
      return ok ? { valid: true, normalized: address.toLowerCase() } : { valid: false, reason: "invalid EVM address" };
    },

    async estimateFee() {
      throw new Error("evmAdapter.estimateFee — Phase 3");
    },

    async createUnsignedTransaction() {
      throw new Error("evmAdapter.createUnsignedTransaction — Phase 3 (Safe protocol-kit)");
    },

    async broadcastTransaction() {
      throw new Error("evmAdapter.broadcastTransaction — Phase 3 (Safe execTransaction)");
    },

    async getTransactionStatus() {
      throw new Error("evmAdapter.getTransactionStatus — Phase 3");
    },
  };
}
