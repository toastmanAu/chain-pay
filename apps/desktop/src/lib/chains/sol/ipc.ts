import type {
  SolanaChain,
  SolanaProviderStatus,
  SolanaScanRequest,
  SolanaScanResponse,
  SolanaTransactionStatusRequest,
  SolanaTransactionStatusResponse,
} from "@chain-pay/shared";

export interface SolanaBridge {
  status(chain: SolanaChain): Promise<SolanaProviderStatus>;
  scan(request: SolanaScanRequest): Promise<SolanaScanResponse>;
  transactionStatus(request: SolanaTransactionStatusRequest): Promise<SolanaTransactionStatusResponse>;
}

export function solanaBridge(): SolanaBridge {
  const api = globalThis.window?.chainpay?.solana;
  if (!api) throw new Error("Solana desktop bridge is unavailable");
  return api;
}
