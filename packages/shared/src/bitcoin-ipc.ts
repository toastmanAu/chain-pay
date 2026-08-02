import type { BitcoinChain, BitcoinWatchSnapshot } from "./treasury";

export const BITCOIN_CHANNELS = {
  status: "bitcoin:status",
  scan: "bitcoin:scan",
  transactionStatus: "bitcoin:transaction-status",
} as const;

export interface BitcoinProviderStatus {
  configured: boolean;
}

export interface BitcoinAddressActivity {
  address: string;
  used: boolean;
}

export interface BitcoinScanRequest {
  chain: BitcoinChain;
  /** Canonical addresses derived and validated by the renderer. */
  addresses: string[];
}

export interface BitcoinScanResponse {
  snapshot: BitcoinWatchSnapshot;
  activity: BitcoinAddressActivity[];
}

export interface BitcoinTransactionStatusRequest {
  chain: BitcoinChain;
  txid: string;
}

export interface BitcoinTransactionStatusResponse {
  state: "pending" | "confirming" | "confirmed" | "unknown";
  confirmations: number;
  blockHeight: number | null;
  blockHash: string | null;
}
