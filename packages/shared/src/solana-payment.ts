import type { Iso8601 } from "./types";
import type { SolanaChain, SolanaTransactionState } from "./treasury";

export type SolanaPaymentState =
  | "reviewed"
  | "collecting_signatures"
  | "ready"
  | "submitting"
  | "submitted"
  | "failed";

export interface SolanaPaymentInspection {
  chain: SolanaChain;
  source: string;
  nonceAccount: string;
  nonceAuthority: string;
  feePayer: string;
  sourceBalanceLamports: string;
  nonceBalanceLamports: string;
  nonceRentMinimumLamports: string;
  feePayerBalanceLamports: string;
  durableNonce: string;
  slot: string;
}

export interface SolanaPaymentAccountingIntent {
  payeeId: string;
  fiat: {
    currency: "USD";
    /** Canonical positive decimal minor-unit text. */
    minor: string;
  };
}

interface SolanaPaymentProposalBase extends SolanaPaymentInspection {
  treasuryId: string;
  destination: string;
  amountLamports: string;
  feeLamports: string;
  messageBase64: string;
  unsignedTransactionBase64: string;
  requiredSigners: string[];
  reviewDigest: string;
  createdAt: Iso8601;
}

/** B2A compatibility record. It remains signable/submittable but is never accounting-postable. */
export interface SolanaPaymentProposalV1 extends SolanaPaymentProposalBase {
  version: 1;
}

/** B2B proposal. Accounting intent is review-digest bound but not encoded into chain message bytes. */
export interface SolanaPaymentProposalV2 extends SolanaPaymentProposalBase {
  version: 2;
  accounting: SolanaPaymentAccountingIntent;
}

export type SolanaPaymentProposal = SolanaPaymentProposalV1 | SolanaPaymentProposalV2;

interface SolanaSignatureEnvelopeBase {
  chain: SolanaChain;
  treasuryId: string;
  reviewDigest: string;
  signer: string;
  /** Ed25519 signature over the immutable Solana transaction message bytes. */
  signature: string;
}

export interface SolanaSignatureEnvelopeV1 extends SolanaSignatureEnvelopeBase {
  format: "chainpay-solana-signature-v1";
}

export interface SolanaSignatureEnvelopeV2 extends SolanaSignatureEnvelopeBase {
  format: "chainpay-solana-signature-v2";
  /** Ed25519 signature over the domain-separated review digest, including accounting intent. */
  reviewSignature: string;
}

export type SolanaSignatureEnvelope = SolanaSignatureEnvelopeV1 | SolanaSignatureEnvelopeV2;

export interface SolanaPaymentReceipt {
  signature: string;
  reviewDigest: string;
  submittedAt: Iso8601;
  alreadySubmitted: boolean;
}

export interface SolanaFinalizedPaymentEvidence {
  version: 1;
  chain: SolanaChain;
  reviewDigest: string;
  signature: string;
  slot: string;
  finalizedAt: Iso8601;
  transactionVersion: "legacy";
  messageBase64: string;
  signedTransactionBase64: string;
  source: string;
  destination: string;
  amountLamports: string;
  feePayer: string;
  feeLamports: string;
  feePayerPolicy: "transaction_fee_payer";
  nonceAccount: string;
  nonceAuthority: string;
  durableNonce: string;
}

export type SolanaPaymentAccountingState =
  | "not_applicable"
  | "awaiting_finalization"
  | "ready"
  | "posting"
  | "posted"
  | "post_failed"
  | "reconciliation_required";

export interface SolanaPaymentRecord {
  treasuryId: string;
  state: SolanaPaymentState;
  proposal: SolanaPaymentProposal;
  signatures: SolanaSignatureEnvelope[];
  receipt: SolanaPaymentReceipt | null;
  transactionState: SolanaTransactionState | null;
  rollbackDetected: boolean;
  accountingState?: SolanaPaymentAccountingState;
  finalizedEvidence?: SolanaFinalizedPaymentEvidence | null;
  accountingRecordName?: string | null;
  journalEntryName?: string | null;
  accountingError?: string | null;
  reconciliationRequired?: boolean;
  error: string | null;
  updatedAt: Iso8601;
}
