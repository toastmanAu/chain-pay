import { beforeEach, describe, expect, it, vi } from "vitest";
import { BITCOIN_CHANNELS } from "@chain-pay/shared";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  review: vi.fn(),
  confirm: vi.fn(),
  evidence: vi.fn(),
  validate: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler)),
  },
}));

vi.mock("./bitcoin-provider", () => ({
  BitcoinProviderError: class BitcoinProviderError extends Error {},
  providerConfigFromEnvironment: vi.fn(() => ({ baseUrl: "https://private.example", bearerToken: "top-secret" })),
  scanBitcoinAddresses: vi.fn(),
  getBitcoinTransactionStatus: vi.fn(),
  reviewBitcoinBroadcast: mocks.review,
  confirmBitcoinBroadcast: mocks.confirm,
  getFinalizedBitcoinPaymentEvidence: mocks.evidence,
}));

vi.mock("./bitcoin-broadcast", () => ({
  BitcoinBroadcastValidationError: class BitcoinBroadcastValidationError extends Error {},
  validateBitcoinBroadcastReview: mocks.validate,
}));

import { registerBitcoinIpc } from "./bitcoin-host";

describe("Bitcoin broadcast IPC boundary", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.review.mockReset();
    mocks.confirm.mockReset();
    mocks.evidence.mockReset();
    mocks.validate.mockReset();
    registerBitcoinIpc();
  });

  it.each(["seed", "privateKey", "psbt", "outputs", "feeRate", "signingRequest"])(
    "rejects an out-of-contract %s field before it reaches the provider",
    async (field) => {
      const handler = mocks.handlers.get(BITCOIN_CHANNELS.reviewBroadcast)!;
      const response = await handler({}, {
        chain: "btc:testnet",
        treasuryId: "btc-1",
        watchedAddresses: ["tb1qfm4w4trj4g5du3zpmz58fkxk3vnvsq4wq7wc9f"],
        rawTxHex: "00",
        [field]: "must-not-cross-ipc",
      });
      expect(response).toEqual({ ok: false, error: { code: "invalid_request", message: "Bitcoin broadcast review request is invalid" } });
      expect(mocks.review).not.toHaveBeenCalled();
      expect(JSON.stringify(response)).not.toContain("top-secret");
      expect(JSON.stringify(response)).not.toContain("private.example");
    },
  );

  it("allows only the digest-bearing confirmation contract", async () => {
    mocks.confirm.mockResolvedValue({
      ok: true,
      receipt: { txid: "a".repeat(64), reviewDigest: "b".repeat(64), state: "submitted", submittedAt: "2026-08-03T00:00:00.000Z" },
    });
    const handler = mocks.handlers.get(BITCOIN_CHANNELS.confirmBroadcast)!;
    const request = {
      chain: "btc:testnet",
      treasuryId: "btc-1",
      watchedAddresses: ["tb1qfm4w4trj4g5du3zpmz58fkxk3vnvsq4wq7wc9f"],
      rawTxHex: "00",
      reviewDigest: "b".repeat(64),
    };
    await expect(handler({}, request)).resolves.toMatchObject({ ok: true, receipt: { state: "submitted" } });
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ request }));
  });

  it("allows only exact accounting-bound reviews through the finalized-evidence boundary", async () => {
    const output = { vout: 0, address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", valueSats: "9000", scriptType: "p2pkh", watched: false, changeCandidate: false };
    const review = {
      reviewVersion: 2, digest: "a".repeat(64), rawTransactionHash: "b".repeat(64), treasuryId: "btc-1", chain: "btc:testnet",
      txid: "c".repeat(64), wtxid: "d".repeat(64), version: 2, lockTime: 0, sizeBytes: 100, weight: 400, vsize: 100,
      inputValueSats: "10000", outputValueSats: "9000", feeSats: "1000", feeRateSatsPerVbyte: "10", tipHeight: 100,
      tipHash: "e".repeat(64), watchSetHash: "f".repeat(64), inputs: [{ txid: "2".repeat(64), vout: 0, address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", valueSats: "10000", scriptType: "p2pkh", watched: true }], outputs: [output], warnings: [],
      accounting: [{ vout: 0, destination: output.address, valueSats: output.valueSats, payeeId: "vendor", fiat: { currency: "USD", minor: "100" } }],
    };
    const receipt = { txid: review.txid, reviewDigest: review.digest, state: "submitted", submittedAt: "2026-08-06T00:00:00.000Z" };
    mocks.evidence.mockResolvedValue({ evidence: { confirmations: 6 } });
    const handler = mocks.handlers.get(BITCOIN_CHANNELS.finalizedEvidence)!;
    await expect(handler({}, { chain: review.chain, treasuryId: review.treasuryId, review, receipt })).resolves.toEqual({ evidence: { confirmations: 6 } });
    expect(mocks.evidence).toHaveBeenCalledTimes(1);

    await expect(handler({}, { chain: review.chain, treasuryId: review.treasuryId, review: { ...review, accounting: [{ ...review.accounting[0], fiat: { ...review.accounting[0]!.fiat, token: "secret" } }] }, receipt })).rejects.toThrow(/invalid/i);
    expect(mocks.evidence).toHaveBeenCalledTimes(1);
  });
});
