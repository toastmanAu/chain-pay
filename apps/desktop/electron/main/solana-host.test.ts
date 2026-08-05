import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOLANA_CHANNELS } from "@chain-pay/shared";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  scan: vi.fn(),
  status: vi.fn(),
  inspect: vi.fn(),
  prepare: vi.fn(),
  submit: vi.fn(),
  verify: vi.fn(),
  validate: vi.fn(),
  finalizedEvidence: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler)) } }));
vi.mock("./solana-provider", () => ({
  SolanaProviderError: class SolanaProviderError extends Error { constructor(readonly code: string, message: string) { super(message); } },
  solanaProviderConfigFromEnvironment: vi.fn(() => ({ rpcUrl: "https://private.example", bearerToken: "top-secret" })),
  scanSolanaAddress: mocks.scan,
  getSolanaTransactionStatus: mocks.status,
  inspectSolanaPayment: mocks.inspect,
  prepareSolanaPayment: mocks.prepare,
  submitSolanaPayment: mocks.submit,
  getFinalizedSolanaPaymentEvidence: mocks.finalizedEvidence,
}));
vi.mock("./solana-payment-transaction", () => ({ verifySolanaSignatureEnvelope: mocks.verify, validateSolanaPaymentProposal: mocks.validate }));

import { registerSolanaIpc } from "./solana-host";

describe("Solana IPC boundary", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    for (const mock of [mocks.scan, mocks.status, mocks.inspect, mocks.prepare, mocks.submit, mocks.verify, mocks.validate, mocks.finalizedEvidence]) mock.mockReset();
    registerSolanaIpc();
  });

  it.each(["seed", "privateKey", "keypair", "secretKey", "mnemonic", "rpcUrl", "bearerToken"])(
    "rejects an out-of-contract %s field before provider access",
    async (field) => {
      const handler = mocks.handlers.get(SOLANA_CHANNELS.scan)!;
      await expect(handler({}, { chain: "sol:devnet", address: "public", [field]: "must-not-cross" }))
        .rejects.toMatchObject({ code: "invalid_request", message: "Solana scan request is invalid" });
      expect(mocks.scan).not.toHaveBeenCalled();
    },
  );

  it("passes only the exact public scan contract to the main-process provider", async () => {
    mocks.scan.mockResolvedValue({ snapshot: { balanceLamports: "0" } });
    const request = { chain: "sol:devnet", address: "public-address" };
    await mocks.handlers.get(SOLANA_CHANNELS.scan)!({}, request);
    expect(mocks.scan).toHaveBeenCalledWith({
      chain: "sol:devnet",
      address: "public-address",
      config: { rpcUrl: "https://private.example", bearerToken: "top-secret" },
    });
  });

  it.each([
    [SOLANA_CHANNELS.transactionStatus, { chain: "sol:devnet", signature: "public-signature" }],
    [SOLANA_CHANNELS.paymentInspect, { chain: "sol:devnet", source: "source", nonceAccount: "nonce", nonceAuthority: "authority", feePayer: "fee" }],
    [SOLANA_CHANNELS.paymentPrepare, { chain: "sol:devnet", treasuryId: "sol-1", source: "source", destination: "destination", amountLamports: "1", nonceAccount: "nonce", nonceAuthority: "authority", feePayer: "fee" }],
    [SOLANA_CHANNELS.paymentValidateProposal, { proposal: {} }],
    [SOLANA_CHANNELS.paymentFinalizedEvidence, { chain: "sol:devnet", treasuryId: "sol-1", proposal: {}, receipt: {}, signatures: [] }],
    [SOLANA_CHANNELS.paymentSubmit, { chain: "sol:devnet", treasuryId: "sol-1", proposal: {}, signatures: [] }],
    [SOLANA_CHANNELS.paymentVerifySignature, { proposal: {}, envelope: {} }],
  ])("rejects secret and endpoint fields on %s", async (channel, request) => {
    for (const field of ["seed", "privateKey", "mnemonic", "rpcUrl", "bearerToken", "authorization"]) {
      await expect(Promise.resolve().then(() => mocks.handlers.get(channel)!({}, { ...request, [field]: "must-not-cross" })))
        .rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.finalizedEvidence).not.toHaveBeenCalled();
  });

  it("passes only fixed public payment contracts to provider operations", async () => {
    mocks.inspect.mockResolvedValue({ chain: "sol:devnet" });
    mocks.prepare.mockResolvedValue({ proposal: {} });
    mocks.submit.mockResolvedValue({ receipt: {} });
    const inspect = { chain: "sol:devnet", source: "source", nonceAccount: "nonce", nonceAuthority: "authority", feePayer: "fee" } as const;
    await mocks.handlers.get(SOLANA_CHANNELS.paymentInspect)!({}, inspect);
    expect(mocks.inspect).toHaveBeenCalledWith({ ...inspect, config: { rpcUrl: "https://private.example", bearerToken: "top-secret" } });

    const prepare = { ...inspect, treasuryId: "sol-1", destination: "destination", amountLamports: "1" };
    await mocks.handlers.get(SOLANA_CHANNELS.paymentPrepare)!({}, prepare);
    expect(mocks.prepare).toHaveBeenCalledWith({ request: prepare, config: { rpcUrl: "https://private.example", bearerToken: "top-secret" } });

    const accountingPrepare = { ...prepare, accounting: { payeeId: "vendor-17", fiat: { currency: "USD", minor: "2500" } } };
    await mocks.handlers.get(SOLANA_CHANNELS.paymentPrepare)!({}, accountingPrepare);
    expect(mocks.prepare).toHaveBeenLastCalledWith({ request: accountingPrepare, config: { rpcUrl: "https://private.example", bearerToken: "top-secret" } });
    await expect(mocks.handlers.get(SOLANA_CHANNELS.paymentPrepare)!({}, { ...accountingPrepare, accounting: { ...accountingPrepare.accounting, privateKey: "no" } }))
      .rejects.toMatchObject({ code: "invalid_request" });

    const submit = { chain: "sol:devnet", treasuryId: "sol-1", proposal: {}, signatures: [] } as const;
    await mocks.handlers.get(SOLANA_CHANNELS.paymentSubmit)!({}, submit);
    expect(mocks.submit).toHaveBeenCalledWith({ request: submit, config: { rpcUrl: "https://private.example", bearerToken: "top-secret" } });

    mocks.validate.mockReturnValue({ version: 1 });
    expect(mocks.handlers.get(SOLANA_CHANNELS.paymentValidateProposal)!({}, { proposal: { version: 1 } }))
      .toEqual({ proposal: { version: 1 } });
    expect(mocks.validate).toHaveBeenCalledWith({ version: 1 });

    mocks.finalizedEvidence.mockResolvedValue({ evidence: {} });
    const finalized = { chain: "sol:devnet", treasuryId: "sol-1", proposal: {}, receipt: {}, signatures: [] } as const;
    await mocks.handlers.get(SOLANA_CHANNELS.paymentFinalizedEvidence)!({}, finalized);
    expect(mocks.finalizedEvidence).toHaveBeenCalledWith({ request: finalized, config: { rpcUrl: "https://private.example", bearerToken: "top-secret" } });
  });
});
