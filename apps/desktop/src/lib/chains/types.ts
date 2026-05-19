import type { ChainId, Money, PayeeAddress, TransactionHash } from "@chain-pay/shared";

export type AdapterStatus = "ready" | "stub" | "unavailable";

export interface AddressValidation {
  valid: boolean;
  reason?: string;
  normalized?: PayeeAddress;
}

export interface FeeEstimate {
  fee: Money;
  feeRateUnit: string;
  meta?: Record<string, unknown>;
}

export interface UnsignedTransaction {
  chain: ChainId;
  /** Adapter-defined opaque payload. Treat as black box outside the adapter. */
  payload: unknown;
  /** Stable hash that signers attach signatures to. */
  signingDigest: string;
  /** Human-readable summary for approval UI. */
  summary: {
    from: PayeeAddress;
    outputs: { to: PayeeAddress; amount: Money }[];
    fee: Money;
    networkInfo: string;
  };
}

export interface BroadcastResult {
  hash: TransactionHash;
  broadcastedAt: number;
}

export interface TransactionStatus {
  hash: TransactionHash;
  state: "pending" | "confirming" | "confirmed" | "failed" | "unknown";
  confirmations: number;
  blockNumber?: bigint;
}

export interface PaymentRequest {
  from: PayeeAddress;
  outputs: { to: PayeeAddress; amount: Money }[];
  /** Adapter-specific fee preference (rate, priority, ...). */
  feeHint?: unknown;
}

/**
 * Stable surface for every chain integration. CKB and EVM are real in MVP;
 * BTC and SOL are stubs that throw on call.
 */
export interface ChainAdapter {
  readonly chain: ChainId;
  readonly status: AdapterStatus;

  getBalance(account: PayeeAddress): Promise<Money>;
  validateAddress(address: string): AddressValidation;
  estimateFee(request: PaymentRequest): Promise<FeeEstimate>;
  createUnsignedTransaction(request: PaymentRequest): Promise<UnsignedTransaction>;
  broadcastTransaction(signed: { payload: unknown }): Promise<BroadcastResult>;
  getTransactionStatus(hash: TransactionHash): Promise<TransactionStatus>;
}
