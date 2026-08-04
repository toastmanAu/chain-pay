import type {
  SolanaChain,
  SolanaSlotText,
  SolanaTransactionState,
  SolanaWatchSnapshot,
} from "./treasury";

export const SOLANA_CHANNELS = {
  status: "solana:status",
  scan: "solana:scan",
  transactionStatus: "solana:transaction-status",
} as const;

export interface SolanaProviderStatus {
  configured: boolean;
}

export interface SolanaScanRequest {
  chain: SolanaChain;
  address: string;
}

export interface SolanaScanResponse {
  snapshot: SolanaWatchSnapshot;
}

export interface SolanaTransactionStatusRequest {
  chain: SolanaChain;
  signature: string;
}

export interface SolanaTransactionStatusResponse {
  state: SolanaTransactionState;
  slot: SolanaSlotText | null;
  confirmations: number | null;
}
