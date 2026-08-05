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
  type BitcoinFinalizedEvidenceResponse,
} from "@chain-pay/shared";
import {
  BitcoinProviderError,
  providerConfigFromEnvironment,
  scanBitcoinAddresses,
  getBitcoinTransactionStatus,
  confirmBitcoinBroadcast,
  reviewBitcoinBroadcast,
  getFinalizedBitcoinPaymentEvidence,
} from "./bitcoin-provider";
import { BitcoinBroadcastValidationError, validateBitcoinBroadcastReview } from "./bitcoin-broadcast";

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
  ipcMain.handle(
    BITCOIN_CHANNELS.finalizedEvidence,
    async (_event, request: unknown): Promise<BitcoinFinalizedEvidenceResponse> => {
      if (!validFinalizedEvidenceRequest(request)) {
        throw new BitcoinProviderError("invalid_request", "Bitcoin finalized-evidence request is invalid");
      }
      const config = providerConfigFromEnvironment(request.chain);
      if (!config) throw new BitcoinProviderError("not_configured", "Bitcoin provider is not configured");
      return getFinalizedBitcoinPaymentEvidence({ request: request as unknown as import("@chain-pay/shared").BitcoinFinalizedEvidenceRequest, config });
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
  const required = ["chain", "treasuryId", "watchedAddresses", "rawTxHex", ...(confirmation ? ["reviewDigest"] : [])];
  const allowed = new Set([...required, "accounting"]);
  const keys = Object.keys(request);
  if (keys.some((key) => !allowed.has(key)) || !required.every((key) => keys.includes(key)) || keys.length > required.length + 1) return false;
  return validChain(request.chain) &&
    typeof request.treasuryId === "string" && request.treasuryId.length > 0 && request.treasuryId.length <= 200 &&
    Array.isArray(request.watchedAddresses) &&
    request.watchedAddresses.length > 0 && request.watchedAddresses.length <= 1_000 &&
    request.watchedAddresses.every((address) => typeof address === "string" && address.length > 0 && address.length <= 100) &&
    typeof request.rawTxHex === "string" && validAccounting(request.accounting) &&
    (!confirmation || (typeof request.reviewDigest === "string" && /^[0-9a-f]{64}$/.test(request.reviewDigest)));
}

function validAccounting(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) return false;
  return value.every((item) => validExactRequest(item, ["vout", "destination", "valueSats", "payeeId", "fiat"]) &&
    typeof item.vout === "number" && Number.isSafeInteger(item.vout) && item.vout >= 0 &&
    typeof item.destination === "string" && item.destination.length > 0 && item.destination.length <= 100 &&
    typeof item.valueSats === "string" && /^[1-9]\d*$/.test(item.valueSats) &&
    typeof item.payeeId === "string" && item.payeeId.trim().length > 0 && item.payeeId.length <= 140 &&
    validExactRequest(item.fiat, ["currency", "minor"]) && item.fiat.currency === "USD" &&
    typeof item.fiat.minor === "string" && /^[1-9]\d*$/.test(item.fiat.minor));
}

function validFinalizedEvidenceRequest(value: unknown): value is import("@chain-pay/shared").BitcoinFinalizedEvidenceRequest {
  if (!validExactRequest(value, ["chain", "treasuryId", "review", "receipt"]) || !validChain(value.chain) || typeof value.treasuryId !== "string" || value.treasuryId.length === 0 || value.treasuryId.length > 200) return false;
  const review = value.review;
  const receipt = value.receipt;
  const reviewKeys = ["reviewVersion", "digest", "rawTransactionHash", "treasuryId", "chain", "txid", "wtxid", "version", "lockTime", "sizeBytes", "weight", "vsize", "inputValueSats", "outputValueSats", "feeSats", "feeRateSatsPerVbyte", "tipHeight", "tipHash", "watchSetHash", "inputs", "outputs", "warnings", "accounting"];
  if (!validExactRequest(review, reviewKeys) || review.reviewVersion !== 2 || review.chain !== value.chain || review.treasuryId !== value.treasuryId) return false;
  if (![review.digest, review.rawTransactionHash, review.txid, review.wtxid, review.tipHash, review.watchSetHash].every((item) => typeof item === "string" && /^[0-9a-f]{64}$/.test(item))) return false;
  if (![review.version, review.lockTime, review.sizeBytes, review.weight, review.vsize, review.tipHeight].every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)) return false;
  if (![review.inputValueSats, review.outputValueSats, review.feeSats].every((item) => typeof item === "string" && /^(0|[1-9]\d*)$/.test(item)) || typeof review.feeRateSatsPerVbyte !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(review.feeRateSatsPerVbyte)) return false;
  if (!validExactRequest(receipt, ["txid", "reviewDigest", "state", "submittedAt"]) || receipt.txid !== review.txid || receipt.reviewDigest !== review.digest || (receipt.state !== "submitted" && receipt.state !== "already_broadcast") || typeof receipt.submittedAt !== "string") return false;
  if (!Array.isArray(review.inputs) || review.inputs.length === 0 || review.inputs.length > 1_000 || !review.inputs.every((item) => validExactRequest(item, ["txid", "vout", "address", "valueSats", "scriptType", "watched"]) && typeof item.txid === "string" && /^[0-9a-f]{64}$/.test(item.txid) && typeof item.vout === "number" && Number.isSafeInteger(item.vout) && item.vout >= 0 && (item.address === null || typeof item.address === "string") && typeof item.valueSats === "string" && /^(0|[1-9]\d*)$/.test(item.valueSats) && typeof item.scriptType === "string" && typeof item.watched === "boolean")) return false;
  if (!Array.isArray(review.outputs) || review.outputs.length === 0 || review.outputs.length > 1_000 || !review.outputs.every((item) => validExactRequest(item, ["vout", "address", "valueSats", "scriptType", "watched", "changeCandidate"]) && typeof item.vout === "number" && Number.isSafeInteger(item.vout) && item.vout >= 0 && (item.address === null || typeof item.address === "string") && typeof item.valueSats === "string" && /^(0|[1-9]\d*)$/.test(item.valueSats) && typeof item.scriptType === "string" && typeof item.watched === "boolean" && typeof item.changeCandidate === "boolean")) return false;
  if (!Array.isArray(review.warnings) || review.warnings.length > 1_000 || !review.warnings.every((warning) => typeof warning === "string" && warning.length <= 500) || !validAccounting(review.accounting)) return false;
  try { validateBitcoinBroadcastReview(review as unknown as import("@chain-pay/shared").BitcoinBroadcastReview); }
  catch { return false; }
  return true;
}

function validExactRequest(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
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
