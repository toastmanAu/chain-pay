import { ipcMain } from "electron";
import {
  SOLANA_CHANNELS,
  type SolanaChain,
  type SolanaProviderStatus,
  type SolanaScanRequest,
  type SolanaScanResponse,
  type SolanaTransactionStatusRequest,
  type SolanaTransactionStatusResponse,
} from "@chain-pay/shared";
import {
  SolanaProviderError,
  getSolanaTransactionStatus,
  scanSolanaAddress,
  solanaProviderConfigFromEnvironment,
} from "./solana-provider";

export function registerSolanaIpc(): void {
  ipcMain.handle(
    SOLANA_CHANNELS.status,
    (_event, chain: unknown): SolanaProviderStatus => ({
      configured: validChain(chain) && solanaProviderConfigFromEnvironment(chain) !== null,
    }),
  );
  ipcMain.handle(
    SOLANA_CHANNELS.scan,
    async (_event, request: unknown): Promise<SolanaScanResponse> => {
      if (!validExactRequest(request, ["chain", "address"]) ||
          !validChain(request.chain) || typeof request.address !== "string") {
        throw invalidRequest("Solana scan request is invalid");
      }
      const config = solanaProviderConfigFromEnvironment(request.chain);
      if (!config) throw new SolanaProviderError("not_configured", "Solana provider is not configured");
      return scanSolanaAddress({ chain: request.chain, address: request.address, config });
    },
  );
  ipcMain.handle(
    SOLANA_CHANNELS.transactionStatus,
    async (_event, request: unknown): Promise<SolanaTransactionStatusResponse> => {
      if (!validExactRequest(request, ["chain", "signature"]) ||
          !validChain(request.chain) || typeof request.signature !== "string") {
        throw invalidRequest("Solana transaction status request is invalid");
      }
      const config = solanaProviderConfigFromEnvironment(request.chain);
      if (!config) throw new SolanaProviderError("not_configured", "Solana provider is not configured");
      return getSolanaTransactionStatus({ signature: request.signature, config });
    },
  );
}

function validChain(value: unknown): value is SolanaChain {
  return value === "sol:mainnet" || value === "sol:devnet";
}

function validExactRequest(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function invalidRequest(message: string): SolanaProviderError {
  return new SolanaProviderError("invalid_request", message);
}
