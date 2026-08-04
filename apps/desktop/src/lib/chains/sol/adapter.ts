import type { SolanaChain } from "@chain-pay/shared";
import type { ChainAdapter, TransactionStatus } from "../types";
import { parseSolanaAddress } from "./address";
import { solanaBridge } from "./ipc";

const WATCH_ONLY_ERROR =
  "Solana support is watch-only; transaction construction, fee estimation, signing, and broadcasting are disabled";

export function solanaAdapter(chain: SolanaChain): ChainAdapter {
  return {
    chain,
    status: "ready",
    async getBalance(account) {
      const address = parseSolanaAddress(account, chain);
      const result = await solanaBridge().scan({ chain, address });
      return { asset: "SOL", value: BigInt(result.snapshot.balanceLamports), decimals: 9 };
    },
    validateAddress(address) {
      try {
        return { valid: true, normalized: parseSolanaAddress(address, chain) };
      } catch (error) {
        return { valid: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async estimateFee() { throw new Error(WATCH_ONLY_ERROR); },
    async createUnsignedTransaction() { throw new Error(WATCH_ONLY_ERROR); },
    async broadcastTransaction() { throw new Error(WATCH_ONLY_ERROR); },
    async getTransactionStatus(hash) {
      const result = await solanaBridge().transactionStatus({ chain, signature: hash });
      const state: TransactionStatus["state"] = result.state === "processed"
        ? "pending"
        : result.state === "confirmed"
          ? "confirming"
          : result.state === "finalized" ? "confirmed" : result.state;
      return {
        hash,
        state,
        confirmations: result.confirmations ?? 0,
        ...(result.slot !== null ? { blockNumber: BigInt(result.slot) } : {}),
      };
    },
  };
}
