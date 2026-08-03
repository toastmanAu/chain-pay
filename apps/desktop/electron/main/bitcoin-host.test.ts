import { beforeEach, describe, expect, it, vi } from "vitest";
import { BITCOIN_CHANNELS } from "@chain-pay/shared";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  review: vi.fn(),
  confirm: vi.fn(),
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
}));

import { registerBitcoinIpc } from "./bitcoin-host";

describe("Bitcoin broadcast IPC boundary", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.review.mockReset();
    mocks.confirm.mockReset();
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
});
