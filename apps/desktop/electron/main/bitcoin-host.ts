import { ipcMain } from "electron";
import {
  BITCOIN_CHANNELS,
  type BitcoinChain,
  type BitcoinScanRequest,
  type BitcoinScanResponse,
  type BitcoinProviderStatus,
  type BitcoinTransactionStatusRequest,
  type BitcoinTransactionStatusResponse,
  type BitcoinBroadcastConfirmRequest,
  type BitcoinBroadcastConfirmResponse,
  type BitcoinBroadcastReviewRequest,
  type BitcoinBroadcastReviewResponse,
} from "@chain-pay/shared";
import {
  BitcoinProviderError,
  providerConfigFromEnvironment,
  scanBitcoinAddresses,
  getBitcoinTransactionStatus,
  confirmBitcoinBroadcast,
  reviewBitcoinBroadcast,
} from "./bitcoin-provider";
import { BitcoinBroadcastValidationError } from "./bitcoin-broadcast";

export function registerBitcoinIpc(): void {
  ipcMain.handle(
    BITCOIN_CHANNELS.status,
    (_event, chain: BitcoinChain): BitcoinProviderStatus => ({
      configured: validChain(chain) && providerConfigFromEnvironment(chain) !== null,
    }),
  );
  ipcMain.handle(
    BITCOIN_CHANNELS.scan,
    async (_event, request: BitcoinScanRequest): Promise<BitcoinScanResponse> => {
      if (!request || !validChain(request.chain)) {
        throw new BitcoinProviderError("invalid_request", "Bitcoin network is invalid");
      }
      const config = providerConfigFromEnvironment(request.chain);
      if (!config) {
        throw new BitcoinProviderError("not_configured", "Bitcoin provider is not configured");
      }
      return scanBitcoinAddresses({ chain: request.chain, addresses: request.addresses, config });
    },
  );
  ipcMain.handle(
    BITCOIN_CHANNELS.transactionStatus,
    async (_event, request: BitcoinTransactionStatusRequest): Promise<BitcoinTransactionStatusResponse> => {
      if (!request || !validChain(request.chain)) {
        throw new BitcoinProviderError("invalid_request", "Bitcoin network is invalid");
      }
      const config = providerConfigFromEnvironment(request.chain);
      if (!config) throw new BitcoinProviderError("not_configured", "Bitcoin provider is not configured");
      return getBitcoinTransactionStatus({ txid: request.txid, config });
    },
  );
  ipcMain.handle(
    BITCOIN_CHANNELS.reviewBroadcast,
    async (_event, request: BitcoinBroadcastReviewRequest): Promise<BitcoinBroadcastReviewResponse> => {
      if (!validBroadcastRequest(request, false)) {
        return { ok: false, error: { code: "invalid_request", message: "Bitcoin broadcast review request is invalid" } };
      }
      const config = providerConfigFromEnvironment(request.chain);
      if (!config) return { ok: false, error: { code: "provider_unavailable", message: "Bitcoin provider is not configured" } };
      try {
        return { ok: true, review: await reviewBitcoinBroadcast({ request, config }) };
      } catch (error) {
        return { ok: false, error: sanitizeBroadcastError(error) };
      }
    },
  );
  ipcMain.handle(
    BITCOIN_CHANNELS.confirmBroadcast,
    async (_event, request: BitcoinBroadcastConfirmRequest): Promise<BitcoinBroadcastConfirmResponse> => {
      if (!validBroadcastRequest(request, true)) {
        return { ok: false, error: { code: "invalid_request", message: "Bitcoin broadcast confirmation request is invalid" } };
      }
      const config = providerConfigFromEnvironment(request.chain);
      if (!config) return { ok: false, error: { code: "provider_unavailable", message: "Bitcoin provider is not configured" } };
      try {
        return await confirmBitcoinBroadcast({ request, config });
      } catch (error) {
        return { ok: false, error: sanitizeBroadcastError(error) };
      }
    },
  );
}

function validChain(value: unknown): value is BitcoinChain {
  return value === "btc:mainnet" || value === "btc:testnet";
}

function validBroadcastRequest(value: unknown, confirmation: false): value is BitcoinBroadcastReviewRequest;
function validBroadcastRequest(value: unknown, confirmation: true): value is BitcoinBroadcastConfirmRequest;
function validBroadcastRequest(value: unknown, confirmation: boolean): value is BitcoinBroadcastReviewRequest | BitcoinBroadcastConfirmRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  const allowed = new Set(["chain", "treasuryId", "watchedAddresses", "rawTxHex", ...(confirmation ? ["reviewDigest"] : [])]);
  if (Object.keys(request).some((key) => !allowed.has(key)) || Object.keys(request).length !== allowed.size) return false;
  return validChain(request.chain) &&
    typeof request.treasuryId === "string" && request.treasuryId.length > 0 && request.treasuryId.length <= 200 &&
    Array.isArray(request.watchedAddresses) &&
    typeof request.rawTxHex === "string" &&
    (!confirmation || (typeof request.reviewDigest === "string" && /^[0-9a-f]{64}$/.test(request.reviewDigest)));
}

function sanitizeBroadcastError(error: unknown): { code: import("@chain-pay/shared").BitcoinBroadcastErrorCode; message: string } {
  if (error instanceof BitcoinBroadcastValidationError) return { code: error.code, message: error.message };
  if (error instanceof BitcoinProviderError) {
    if (error.code === "rejected") return { code: "provider_rejected", message: "Bitcoin provider rejected the transaction" };
    if (error.code === "txid_mismatch") return { code: "txid_mismatch", message: "Bitcoin provider returned a mismatched transaction id" };
    if (error.code === "invalid_request") return { code: "invalid_request", message: "Bitcoin broadcast request is invalid" };
  }
  return { code: "provider_unavailable", message: "Bitcoin provider is unavailable" };
}
