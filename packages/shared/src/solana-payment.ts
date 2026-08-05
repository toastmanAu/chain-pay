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

export interface SolanaPaymentProposal extends SolanaPaymentInspection {
  version: 1;
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

export interface SolanaSignatureEnvelope {
  format: "chainpay-solana-signature-v1";
  chain: SolanaChain;
  treasuryId: string;
  reviewDigest: string;
  signer: string;
  signature: string;
}

export interface SolanaPaymentReceipt {
  signature: string;
  reviewDigest: string;
  submittedAt: Iso8601;
  alreadySubmitted: boolean;
}

export interface SolanaPaymentRecord {
  treasuryId: string;
  state: SolanaPaymentState;
  proposal: SolanaPaymentProposal;
  signatures: SolanaSignatureEnvelope[];
  receipt: SolanaPaymentReceipt | null;
  transactionState: SolanaTransactionState | null;
  rollbackDetected: boolean;
  error: string | null;
  updatedAt: Iso8601;
}
