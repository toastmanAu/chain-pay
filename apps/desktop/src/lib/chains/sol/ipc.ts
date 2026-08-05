import type {
  SolanaChain,
  SolanaProviderStatus,
  SolanaScanRequest,
  SolanaScanResponse,
  SolanaTransactionStatusRequest,
  SolanaTransactionStatusResponse,
  SolanaPaymentInspectRequest,
  SolanaPaymentInspectResponse,
  SolanaPaymentPrepareRequest,
  SolanaPaymentPrepareResponse,
  SolanaPaymentValidateProposalRequest,
  SolanaPaymentValidateProposalResponse,
  SolanaPaymentFinalizedEvidenceRequest,
  SolanaPaymentFinalizedEvidenceResponse,
  SolanaPaymentSubmitRequest,
  SolanaPaymentSubmitResponse,
  SolanaPaymentVerifySignatureRequest,
  SolanaPaymentVerifySignatureResponse,
} from "@chain-pay/shared";

export interface SolanaBridge {
  status(chain: SolanaChain): Promise<SolanaProviderStatus>;
  scan(request: SolanaScanRequest): Promise<SolanaScanResponse>;
  transactionStatus(request: SolanaTransactionStatusRequest): Promise<SolanaTransactionStatusResponse>;
  paymentInspect(request: SolanaPaymentInspectRequest): Promise<SolanaPaymentInspectResponse>;
  paymentPrepare(request: SolanaPaymentPrepareRequest): Promise<SolanaPaymentPrepareResponse>;
  paymentValidateProposal(request: SolanaPaymentValidateProposalRequest): Promise<SolanaPaymentValidateProposalResponse>;
  paymentFinalizedEvidence(request: SolanaPaymentFinalizedEvidenceRequest): Promise<SolanaPaymentFinalizedEvidenceResponse>;
  paymentSubmit(request: SolanaPaymentSubmitRequest): Promise<SolanaPaymentSubmitResponse>;
  paymentVerifySignature(request: SolanaPaymentVerifySignatureRequest): Promise<SolanaPaymentVerifySignatureResponse>;
}

export function solanaBridge(): SolanaBridge {
  const api = globalThis.window?.chainpay?.solana;
  if (!api) throw new Error("Solana desktop bridge is unavailable");
  return api;
}
