import type { BitcoinChain } from "@chain-pay/shared";
import type { ChainAdapter } from "../types";
import { bitcoinBridge } from "./ipc";
import { parseBitcoinAddress } from "./watch-source";

const WATCH_ONLY_ERROR =
  "Bitcoin support is watch-only; transaction construction, signing, PSBT, and broadcast are disabled";

export function bitcoinAdapter(chain: BitcoinChain): ChainAdapter {
  return {
    chain,
    status: "ready",
    async getBalance(account) {
      const parsed = parseBitcoinAddress(account, chain);
      const result = await bitcoinBridge().scan({ chain, addresses: [parsed.address] });
      return { asset: "BTC", value: BigInt(result.snapshot.balanceSats), decimals: 8 };
    },
    validateAddress(address) {
      try {
        const parsed = parseBitcoinAddress(address, chain);
        return { valid: true, normalized: parsed.address };
      } catch (caught) {
        return { valid: false, reason: caught instanceof Error ? caught.message : String(caught) };
      }
    },
    async estimateFee() {
      throw new Error(WATCH_ONLY_ERROR);
    },
    async createUnsignedTransaction() {
      throw new Error(WATCH_ONLY_ERROR);
    },
    async broadcastTransaction() {
      throw new Error(WATCH_ONLY_ERROR);
    },
    async getTransactionStatus(hash) {
      const txid = hash.startsWith("0x") ? hash.slice(2) : hash;
      const result = await bitcoinBridge().transactionStatus({ chain, txid });
      return {
        hash,
        state: result.state,
        confirmations: result.confirmations,
        ...(result.blockHeight !== null ? { blockNumber: BigInt(result.blockHeight) } : {}),
      };
    },
  };
}
