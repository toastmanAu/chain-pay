import { ipcMain } from "electron";
import {
  SOLANA_CHANNELS,
  type SolanaChain,
  type SolanaProviderStatus,
  type SolanaScanResponse,
  type SolanaTransactionStatusResponse,
  type SolanaPaymentInspectResponse,
  type SolanaPaymentPrepareResponse,
  type SolanaPaymentValidateProposalResponse,
  type SolanaPaymentFinalizedEvidenceResponse,
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
  getFinalizedSolanaPaymentEvidence,
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
      const requiredKeys = ["chain", "treasuryId", "source", "destination", "amountLamports", "nonceAccount", "nonceAuthority", "feePayer"];
      const keys = Object.keys(request && typeof request === "object" && !Array.isArray(request) ? request : {});
      const exactKeys = keys.length === requiredKeys.length || (keys.length === requiredKeys.length + 1 && keys.includes("accounting"));
      if (!exactKeys || !requiredKeys.every((key) => keys.includes(key)) || !validChain((request as Record<string, unknown>).chain) || !requiredKeys.slice(1).every((key) => typeof (request as Record<string, unknown>)[key] === "string") || (keys.includes("accounting") && !validAccountingIntent((request as Record<string, unknown>).accounting))) {
        throw invalidRequest("Solana payment preparation request is invalid");
      }
      const typed = request as unknown as import("@chain-pay/shared").SolanaPaymentPrepareRequest;
      return prepareSolanaPayment({ request: typed, config: requiredConfig(typed.chain) });
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
    SOLANA_CHANNELS.paymentFinalizedEvidence,
    async (_event, request: unknown): Promise<SolanaPaymentFinalizedEvidenceResponse> => {
      if (!validExactRequest(request, ["chain", "treasuryId", "proposal", "receipt", "signatures"]) || !validChain(request.chain) || typeof request.treasuryId !== "string" || !Array.isArray(request.signatures)) {
        throw invalidRequest("Solana finalized payment evidence request is invalid");
      }
      return getFinalizedSolanaPaymentEvidence({ request: request as unknown as import("@chain-pay/shared").SolanaPaymentFinalizedEvidenceRequest, config: requiredConfig(request.chain) });
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

function validAccountingIntent(value: unknown): boolean {
  if (!validExactRequest(value, ["payeeId", "fiat"]) || typeof value.payeeId !== "string") return false;
  return validExactRequest(value.fiat, ["currency", "minor"]) && value.fiat.currency === "USD" && typeof value.fiat.minor === "string";
}

function requiredConfig(chain: SolanaChain) {
  const config = solanaProviderConfigFromEnvironment(chain);
  if (!config) throw new SolanaProviderError("not_configured", "Solana provider is not configured");
  return config;
}
