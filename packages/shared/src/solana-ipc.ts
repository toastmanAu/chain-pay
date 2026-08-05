import type {
  SolanaChain,
  SolanaSlotText,
  SolanaTransactionState,
  SolanaWatchSnapshot,
} from "./treasury";
import type {
  SolanaPaymentInspection,
  SolanaPaymentProposal,
  SolanaPaymentReceipt,
  SolanaSignatureEnvelope,
} from "./solana-payment";

export const SOLANA_CHANNELS = {
  status: "solana:status",
  scan: "solana:scan",
  transactionStatus: "solana:transaction-status",
  paymentInspect: "solana:payment-inspect",
  paymentPrepare: "solana:payment-prepare",
  paymentValidateProposal: "solana:payment-validate-proposal",
  paymentSubmit: "solana:payment-submit",
  paymentVerifySignature: "solana:payment-verify-signature",
} as const;

export interface SolanaProviderStatus {
  configured: boolean;
}

export interface SolanaPaymentInspectRequest {
  chain: SolanaChain;
  source: string;
  nonceAccount: string;
  nonceAuthority: string;
  feePayer: string;
}

export interface SolanaPaymentInspectResponse {
  inspection: SolanaPaymentInspection;
}

export interface SolanaPaymentPrepareRequest extends SolanaPaymentInspectRequest {
  treasuryId: string;
  destination: string;
  amountLamports: string;
}

export interface SolanaPaymentPrepareResponse {
  proposal: SolanaPaymentProposal;
}

export interface SolanaPaymentValidateProposalRequest {
  proposal: SolanaPaymentProposal;
}

export interface SolanaPaymentValidateProposalResponse {
  proposal: SolanaPaymentProposal;
}

export interface SolanaPaymentSubmitRequest {
  chain: SolanaChain;
  treasuryId: string;
  proposal: SolanaPaymentProposal;
  signatures: SolanaSignatureEnvelope[];
}

export interface SolanaPaymentSubmitResponse {
  receipt: SolanaPaymentReceipt;
}

export interface SolanaPaymentVerifySignatureRequest {
  proposal: SolanaPaymentProposal;
  envelope: SolanaSignatureEnvelope;
}

export interface SolanaPaymentVerifySignatureResponse {
  envelope: SolanaSignatureEnvelope;
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
