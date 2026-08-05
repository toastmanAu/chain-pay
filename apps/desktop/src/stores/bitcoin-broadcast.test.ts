// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BitcoinBroadcastReview, BitcoinBroadcastReviewV2, BitcoinFinalizedPaymentEvidence } from "@chain-pay/shared";

const review: BitcoinBroadcastReview = {
  digest: "d".repeat(64), treasuryId: "btc-1", chain: "btc:testnet", txid: "a".repeat(64), wtxid: "b".repeat(64),
  version: 2, lockTime: 0, sizeBytes: 100, weight: 400, vsize: 100,
  inputValueSats: "10000", outputValueSats: "9000", feeSats: "1000", feeRateSatsPerVbyte: "10",
  tipHeight: 100, tipHash: "c".repeat(64), watchSetHash: "e".repeat(64), inputs: [], outputs: [], warnings: [],
};

const reviewV2: BitcoinBroadcastReviewV2 = {
  ...review, reviewVersion: 2, rawTransactionHash: "f".repeat(64),
  outputs: [{ vout: 0, address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", valueSats: "9000", scriptType: "p2pkh", watched: false, changeCandidate: false }],
  accounting: [{ vout: 0, destination: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", valueSats: "9000", payeeId: "vendor", fiat: { currency: "USD", minor: "100" } }],
};

function evidence(confirmations = 6): BitcoinFinalizedPaymentEvidence {
  return { version: 1, chain: reviewV2.chain, reviewDigest: reviewV2.digest, txid: reviewV2.txid, wtxid: reviewV2.wtxid, rawTransactionHash: reviewV2.rawTransactionHash, blockHeight: "95", blockHash: "1".repeat(64), blockTime: "2026-08-06T00:00:00.000Z", confirmations, transactionVersion: reviewV2.version, lockTime: reviewV2.lockTime, inputValueSats: reviewV2.inputValueSats, outputValueSats: reviewV2.outputValueSats, feeSats: reviewV2.feeSats, feeRateSatsPerVbyte: reviewV2.feeRateSatsPerVbyte, feePayerPolicy: "transaction_inputs", outputs: reviewV2.outputs };
}

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

  it("requires exact six-confirmation evidence before making v2 accounting ready", async () => {
    const { useBitcoinBroadcastStore } = await import("./bitcoin-broadcast");
    const store = useBitcoinBroadcastStore.getState();
    store.beginReview("btc-1", "btc:testnet", "00"); store.acceptReview("btc-1", reviewV2);
    store.acceptReceipt("btc-1", { txid: reviewV2.txid, reviewDigest: reviewV2.digest, state: "submitted", submittedAt: "2026-08-06T00:00:00.000Z" });
    store.refreshStatus("btc-1", { state: "confirming", confirmations: 5, blockHeight: 96, blockHash: "1".repeat(64) });
    expect(() => useBitcoinBroadcastStore.getState().acceptFinalizedEvidence("btc-1", evidence(5))).toThrow(/eligible/);
    useBitcoinBroadcastStore.getState().refreshStatus("btc-1", { state: "confirmed", confirmations: 6, blockHeight: 95, blockHash: "1".repeat(64) });
    expect(() => useBitcoinBroadcastStore.getState().acceptFinalizedEvidence("btc-1", { ...evidence(), feeSats: "1" })).toThrow(/immutable review/);
    useBitcoinBroadcastStore.getState().acceptFinalizedEvidence("btc-1", evidence());
    expect(useBitcoinBroadcastStore.getState().records["btc-1"]).toMatchObject({ accountingState: "ready", finalizedEvidence: { confirmations: 6 } });
  });

  it("recovers interrupted posting as retryable without changing immutable transaction data", async () => {
    const first = await import("./bitcoin-broadcast");
    const store = first.useBitcoinBroadcastStore.getState();
    store.beginReview("btc-1", "btc:testnet", "00"); store.acceptReview("btc-1", reviewV2);
    store.acceptReceipt("btc-1", { txid: reviewV2.txid, reviewDigest: reviewV2.digest, state: "submitted", submittedAt: "2026-08-06T00:00:00.000Z" });
    store.refreshStatus("btc-1", { state: "confirmed", confirmations: 6, blockHeight: 95, blockHash: "1".repeat(64) });
    store.acceptFinalizedEvidence("btc-1", evidence()); store.beginAccountingPost("btc-1");
    vi.resetModules();
    const second = await import("./bitcoin-broadcast"); await second.useBitcoinBroadcastStore.persist.rehydrate();
    expect(second.useBitcoinBroadcastStore.getState().records["btc-1"]).toMatchObject({ rawTxHex: "00", review: { digest: reviewV2.digest }, receipt: { txid: reviewV2.txid }, accountingState: "post_failed" });
  });

  it("retains backend IDs when a late post response races a finalized reorg", async () => {
    const { useBitcoinBroadcastStore } = await import("./bitcoin-broadcast");
    const store = useBitcoinBroadcastStore.getState();
    store.beginReview("btc-1", "btc:testnet", "00"); store.acceptReview("btc-1", reviewV2);
    store.acceptReceipt("btc-1", { txid: reviewV2.txid, reviewDigest: reviewV2.digest, state: "submitted", submittedAt: "2026-08-06T00:00:00.000Z" });
    store.refreshStatus("btc-1", { state: "confirmed", confirmations: 6, blockHeight: 95, blockHash: "1".repeat(64) });
    store.acceptFinalizedEvidence("btc-1", evidence()); store.beginAccountingPost("btc-1");
    useBitcoinBroadcastStore.getState().refreshStatus("btc-1", { state: "unknown", confirmations: 0, blockHeight: null, blockHash: null });
    useBitcoinBroadcastStore.getState().markAccountingPosted("btc-1", "JE-1", "BATCH-1");
    expect(useBitcoinBroadcastStore.getState().records["btc-1"]).toMatchObject({ accountingState: "reconciliation_required", reconciliationRequired: true, journalEntryName: "JE-1", accountingRecordName: "BATCH-1", receipt: { txid: reviewV2.txid } });
  });
});
