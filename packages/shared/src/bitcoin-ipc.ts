import type { BitcoinChain, BitcoinWatchSnapshot } from "./treasury";

export const BITCOIN_CHANNELS = {
  status: "bitcoin:status",
  scan: "bitcoin:scan",
  transactionStatus: "bitcoin:transaction-status",
  reviewBroadcast: "bitcoin:review-broadcast",
  confirmBroadcast: "bitcoin:confirm-broadcast",
  finalizedEvidence: "bitcoin:finalized-evidence",
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

export type BitcoinBroadcastErrorCode =
  | "invalid_request"
  | "malformed"
  | "unsigned"
  | "unsupported"
  | "wrong_network"
  | "not_watched"
  | "duplicate_input"
  | "already_known"
  | "non_final"
  | "policy"
  | "oversized"
  | "review_changed"
  | "provider_unavailable"
  | "provider_rejected"
  | "txid_mismatch";

export interface BitcoinBroadcastError {
  code: BitcoinBroadcastErrorCode;
  message: string;
}

export interface BitcoinBroadcastReviewRequest {
  chain: BitcoinChain;
  treasuryId: string;
  /** Public addresses already derived for the selected watch-only treasury. */
  watchedAddresses: string[];
  /** A final raw transaction only. PSBTs and signing material are never accepted. */
  rawTxHex: string;
  /** Omit only for output inspection or legacy-A2 compatibility. */
  accounting?: BitcoinPaymentAccountingLine[];
}

export interface BitcoinPaymentAccountingLine {
  vout: number;
  destination: string;
  valueSats: string;
  payeeId: string;
  fiat: { currency: "USD"; minor: string };
}

export interface BitcoinBroadcastReviewInput {
  txid: string;
  vout: number;
  address: string | null;
  valueSats: string;
  scriptType: "p2pkh" | "p2wpkh" | "p2sh-p2wpkh" | "p2tr-keypath";
  watched: boolean;
}

export interface BitcoinBroadcastReviewOutput {
  vout: number;
  address: string | null;
  valueSats: string;
  scriptType: "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr" | "op_return";
  watched: boolean;
  /** A watched destination is a change candidate, not a claim about signer intent. */
  changeCandidate: boolean;
}

interface BitcoinBroadcastReviewBase {
  digest: string;
  treasuryId: string;
  chain: BitcoinChain;
  txid: string;
  wtxid: string;
  version: number;
  lockTime: number;
  sizeBytes: number;
  weight: number;
  vsize: number;
  inputValueSats: string;
  outputValueSats: string;
  feeSats: string;
  feeRateSatsPerVbyte: string;
  tipHeight: number;
  tipHash: string;
  watchSetHash: string;
  inputs: BitcoinBroadcastReviewInput[];
  outputs: BitcoinBroadcastReviewOutput[];
  warnings: string[];
}

/** Persisted A2 shape. It remains broadcast/status compatible but is never accounting-postable. */
export interface BitcoinBroadcastReviewV1 extends BitcoinBroadcastReviewBase {
  reviewVersion?: undefined;
}

export interface BitcoinBroadcastReviewV2 extends BitcoinBroadcastReviewBase {
  reviewVersion: 2;
  rawTransactionHash: string;
  accounting: BitcoinPaymentAccountingLine[];
}

export type BitcoinBroadcastReview = BitcoinBroadcastReviewV1 | BitcoinBroadcastReviewV2;

export type BitcoinBroadcastReviewResponse =
  | { ok: true; review: BitcoinBroadcastReview }
  | { ok: false; error: BitcoinBroadcastError };

export interface BitcoinBroadcastConfirmRequest extends BitcoinBroadcastReviewRequest {
  /** Digest displayed to and explicitly approved by the operator. */
  reviewDigest: string;
}

export interface BitcoinBroadcastReceipt {
  txid: string;
  reviewDigest: string;
  state: "submitted" | "already_broadcast";
  submittedAt: string;
}

export type BitcoinBroadcastConfirmResponse =
  | { ok: true; receipt: BitcoinBroadcastReceipt }
  | { ok: false; error: BitcoinBroadcastError; review?: BitcoinBroadcastReview };

export interface BitcoinFinalizedPaymentEvidence {
  version: 1;
  chain: BitcoinChain;
  reviewDigest: string;
  txid: string;
  wtxid: string;
  rawTransactionHash: string;
  blockHeight: string;
  blockHash: string;
  blockTime: string;
  confirmations: number;
  transactionVersion: number;
  lockTime: number;
  inputValueSats: string;
  outputValueSats: string;
  feeSats: string;
  feeRateSatsPerVbyte: string;
  feePayerPolicy: "transaction_inputs";
  outputs: BitcoinBroadcastReviewOutput[];
}

export interface BitcoinFinalizedEvidenceRequest {
  chain: BitcoinChain;
  treasuryId: string;
  review: BitcoinBroadcastReview;
  receipt: BitcoinBroadcastReceipt;
}

export interface BitcoinFinalizedEvidenceResponse {
  evidence: BitcoinFinalizedPaymentEvidence;
}

export type BitcoinAccountingState =
  | "not_applicable"
  | "awaiting_finalization"
  | "ready"
  | "posting"
  | "posted"
  | "post_failed"
  | "reconciliation_required";
