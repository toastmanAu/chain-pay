// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BitcoinBroadcastReview } from "@chain-pay/shared";

const review: BitcoinBroadcastReview = {
  digest: "d".repeat(64), treasuryId: "btc-1", chain: "btc:testnet", txid: "a".repeat(64), wtxid: "b".repeat(64),
  version: 2, lockTime: 0, sizeBytes: 100, weight: 400, vsize: 100,
  inputValueSats: "10000", outputValueSats: "9000", feeSats: "1000", feeRateSatsPerVbyte: "10",
  tipHeight: 100, tipHash: "c".repeat(64), watchSetHash: "e".repeat(64), inputs: [], outputs: [], warnings: [],
};

describe("Bitcoin broadcast lifecycle store", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("persists a reviewed transaction and its idempotent receipt across restart", async () => {
    const first = await import("./bitcoin-broadcast");
    first.useBitcoinBroadcastStore.getState().beginReview("btc-1", "btc:testnet", "01000000");
    first.useBitcoinBroadcastStore.getState().acceptReview("btc-1", review);
    first.useBitcoinBroadcastStore.getState().beginSubmit("btc-1");
    first.useBitcoinBroadcastStore.getState().acceptReceipt("btc-1", {
      txid: review.txid, reviewDigest: review.digest, state: "submitted", submittedAt: "2026-08-03T00:00:00.000Z",
    });
    vi.resetModules();
    const second = await import("./bitcoin-broadcast");
    await second.useBitcoinBroadcastStore.persist.rehydrate();
    expect(second.useBitcoinBroadcastStore.getState().records["btc-1"]).toMatchObject({
      state: "submitted", rawTxHex: "01000000", receipt: { txid: review.txid },
    });
  });

  it("marks a previously confirmed receipt as reorged when it returns to pending", async () => {
    const { useBitcoinBroadcastStore } = await import("./bitcoin-broadcast");
    const store = useBitcoinBroadcastStore.getState();
    store.beginReview("btc-1", "btc:testnet", "00");
    store.acceptReview("btc-1", review);
    store.acceptReceipt("btc-1", { txid: review.txid, reviewDigest: review.digest, state: "submitted", submittedAt: "2026-08-03T00:00:00.000Z" });
    store.refreshStatus("btc-1", { state: "confirming", confirmations: 2, blockHeight: 99, blockHash: "e".repeat(64) });
    useBitcoinBroadcastStore.getState().refreshStatus("btc-1", { state: "pending", confirmations: 0, blockHeight: null, blockHash: null });
    expect(useBitcoinBroadcastStore.getState().records["btc-1"]?.reorged).toBe(true);
  });

  it("recovers an interrupted submit into an idempotently retryable reviewed state", async () => {
    const first = await import("./bitcoin-broadcast");
    first.useBitcoinBroadcastStore.getState().beginReview("btc-1", "btc:testnet", "00");
    first.useBitcoinBroadcastStore.getState().acceptReview("btc-1", review);
    first.useBitcoinBroadcastStore.getState().beginSubmit("btc-1");
    vi.resetModules();
    const second = await import("./bitcoin-broadcast");
    await second.useBitcoinBroadcastStore.persist.rehydrate();
    expect(second.useBitcoinBroadcastStore.getState().records["btc-1"]).toMatchObject({
      state: "reviewed",
      review: { digest: review.digest },
      error: { code: "provider_unavailable" },
    });
  });
});
