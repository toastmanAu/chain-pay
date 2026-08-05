import { ipcMain } from "electron";
import {
  SOLANA_CHANNELS,
  type SolanaChain,
  type SolanaProviderStatus,
  type SolanaScanRequest,
  type SolanaScanResponse,
  type SolanaTransactionStatusRequest,
  type SolanaTransactionStatusResponse,
  type SolanaPaymentInspectResponse,
  type SolanaPaymentPrepareResponse,
  type SolanaPaymentValidateProposalResponse,
  type SolanaPaymentSubmitResponse,
  type SolanaPaymentVerifySignatureResponse,
} from "@chain-pay/shared";
import {
  SolanaProviderError,
  getSolanaTransactionStatus,
  scanSolanaAddress,
  solanaProviderConfigFromEnvironment,
  inspectSolanaPayment,
  prepareSolanaPayment,
  submitSolanaPayment,
} from "./solana-provider";
import { validateSolanaPaymentProposal, verifySolanaSignatureEnvelope } from "./solana-payment-transaction";

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
  ipcMain.handle(
    SOLANA_CHANNELS.paymentInspect,
    async (_event, request: unknown): Promise<SolanaPaymentInspectResponse> => {
      const keys = ["chain", "source", "nonceAccount", "nonceAuthority", "feePayer"];
      if (!validExactRequest(request, keys) || !validChain(request.chain) || !keys.slice(1).every((key) => typeof request[key] === "string")) {
        throw invalidRequest("Solana payment inspection request is invalid");
      }
      const config = requiredConfig(request.chain);
      return { inspection: await inspectSolanaPayment({
        chain: request.chain,
        source: request.source as string,
        nonceAccount: request.nonceAccount as string,
        nonceAuthority: request.nonceAuthority as string,
        feePayer: request.feePayer as string,
        config,
      }) };
    },
  );
  ipcMain.handle(
    SOLANA_CHANNELS.paymentPrepare,
    async (_event, request: unknown): Promise<SolanaPaymentPrepareResponse> => {
      const keys = ["chain", "treasuryId", "source", "destination", "amountLamports", "nonceAccount", "nonceAuthority", "feePayer"];
      if (!validExactRequest(request, keys) || !validChain(request.chain) || !keys.slice(1).every((key) => typeof request[key] === "string")) {
        throw invalidRequest("Solana payment preparation request is invalid");
      }
      return prepareSolanaPayment({ request: request as unknown as import("@chain-pay/shared").SolanaPaymentPrepareRequest, config: requiredConfig(request.chain) });
    },
  );
  ipcMain.handle(
    SOLANA_CHANNELS.paymentValidateProposal,
    (_event, request: unknown): SolanaPaymentValidateProposalResponse => {
      if (!validExactRequest(request, ["proposal"])) throw invalidRequest("Solana payment proposal validation request is invalid");
      return { proposal: validateSolanaPaymentProposal(request.proposal) };
    },
  );
  ipcMain.handle(
    SOLANA_CHANNELS.paymentSubmit,
    async (_event, request: unknown): Promise<SolanaPaymentSubmitResponse> => {
      if (!validExactRequest(request, ["chain", "treasuryId", "proposal", "signatures"]) || !validChain(request.chain) || typeof request.treasuryId !== "string" || !Array.isArray(request.signatures)) {
        throw invalidRequest("Solana payment submission request is invalid");
      }
      return submitSolanaPayment({ request: request as unknown as import("@chain-pay/shared").SolanaPaymentSubmitRequest, config: requiredConfig(request.chain) });
    },
  );
  ipcMain.handle(
    SOLANA_CHANNELS.paymentVerifySignature,
    (_event, request: unknown): SolanaPaymentVerifySignatureResponse => {
      if (!validExactRequest(request, ["proposal", "envelope"])) throw invalidRequest("Solana signature verification request is invalid");
      return { envelope: verifySolanaSignatureEnvelope(request.proposal, request.envelope) };
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

function requiredConfig(chain: SolanaChain) {
  const config = solanaProviderConfigFromEnvironment(chain);
  if (!config) throw new SolanaProviderError("not_configured", "Solana provider is not configured");
  return config;
}
