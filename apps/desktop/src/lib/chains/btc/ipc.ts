import type {
  BitcoinChain,
  BitcoinProviderStatus,
  BitcoinScanRequest,
  BitcoinScanResponse,
  BitcoinTransactionStatusRequest,
  BitcoinTransactionStatusResponse,
  BitcoinBroadcastConfirmRequest,
  BitcoinBroadcastConfirmResponse,
  BitcoinBroadcastReviewRequest,
  BitcoinBroadcastReviewResponse,
} from "@chain-pay/shared";

export interface BitcoinBridge {
  status(chain: BitcoinChain): Promise<BitcoinProviderStatus>;
  scan(request: BitcoinScanRequest): Promise<BitcoinScanResponse>;
  transactionStatus(request: BitcoinTransactionStatusRequest): Promise<BitcoinTransactionStatusResponse>;
  reviewBroadcast(request: BitcoinBroadcastReviewRequest): Promise<BitcoinBroadcastReviewResponse>;
  confirmBroadcast(request: BitcoinBroadcastConfirmRequest): Promise<BitcoinBroadcastConfirmResponse>;
}

export function bitcoinBridge(): BitcoinBridge {
  const api = globalThis.window?.chainpay?.bitcoin;
  if (!api) throw new Error("Bitcoin provider bridge is unavailable");
  return api;
}
