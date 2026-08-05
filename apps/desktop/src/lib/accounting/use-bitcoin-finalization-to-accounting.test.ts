// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BitcoinBroadcastReviewV2, BitcoinFinalizedPaymentEvidence } from "@chain-pay/shared";
import { useBitcoinBroadcastStore, type BitcoinBroadcastRecord } from "@/stores/bitcoin-broadcast";

const postFinalized = vi.fn();
vi.mock("./bitcoin-accounting", () => ({ postFinalizedBitcoinPayment: (...args: unknown[]) => postFinalized(...args) }));
import { checkBitcoinPaymentFinalization } from "./use-bitcoin-finalization-to-accounting";

const transactionStatus = vi.fn();
const finalizedEvidence = vi.fn();

function record(): BitcoinBroadcastRecord {
  const output = { vout: 0, address: "tb1qfm7m0et5az22ppyr8wz987qq5t5w6w863mpy0k", valueSats: "9000", scriptType: "p2wpkh" as const, watched: false, changeCandidate: false };
  const review: BitcoinBroadcastReviewV2 = { reviewVersion: 2, digest: "a".repeat(64), rawTransactionHash: "b".repeat(64), treasuryId: "btc-1", chain: "btc:testnet", txid: "c".repeat(64), wtxid: "d".repeat(64), version: 2, lockTime: 0, sizeBytes: 100, weight: 400, vsize: 100, inputValueSats: "10000", outputValueSats: "9000", feeSats: "1000", feeRateSatsPerVbyte: "10", tipHeight: 100, tipHash: "e".repeat(64), watchSetHash: "f".repeat(64), inputs: [], outputs: [output], warnings: [], accounting: [{ vout: 0, destination: output.address, valueSats: output.valueSats, payeeId: "vendor", fiat: { currency: "USD", minor: "100" } }] };
  return { treasuryId: "btc-1", chain: review.chain, rawTxHex: "00", state: "submitted", review, receipt: { txid: review.txid, reviewDigest: review.digest, state: "submitted", submittedAt: "2026-08-06T00:00:00.000Z" }, status: null, reorged: false, finalizedEvidence: null, accountingState: "awaiting_finalization", accountingRecordName: null, journalEntryName: null, accountingError: null, reconciliationRequired: false, error: null, createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" };
}

function evidence(value: BitcoinBroadcastRecord): BitcoinFinalizedPaymentEvidence {
  const review = value.review as BitcoinBroadcastReviewV2;
  return { version: 1, chain: review.chain, reviewDigest: review.digest, txid: review.txid, wtxid: review.wtxid, rawTransactionHash: review.rawTransactionHash, blockHeight: "95", blockHash: "1".repeat(64), blockTime: "2026-08-06T00:00:00.000Z", confirmations: 6, transactionVersion: review.version, lockTime: review.lockTime, inputValueSats: review.inputValueSats, outputValueSats: review.outputValueSats, feeSats: review.feeSats, feeRateSatsPerVbyte: review.feeRateSatsPerVbyte, feePayerPolicy: "transaction_inputs", outputs: review.outputs };
}

beforeEach(() => {
  postFinalized.mockReset().mockResolvedValue(undefined);
  transactionStatus.mockReset(); finalizedEvidence.mockReset();
  useBitcoinBroadcastStore.setState({ records: { "btc-1": record() } });
  (window as unknown as { chainpay: { bitcoin: unknown } }).chainpay = { bitcoin: { transactionStatus, finalizedEvidence } };
});

describe("Bitcoin finalization recovery", () => {
  it.each([
    { state: "pending", confirmations: 0, blockHeight: null, blockHash: null },
    { state: "confirming", confirmations: 5, blockHeight: 96, blockHash: "1".repeat(64) },
  ] as const)("does not fetch evidence or post before six confirmations", async (status) => {
    transactionStatus.mockResolvedValue(status);
    await checkBitcoinPaymentFinalization("btc-1");
    expect(finalizedEvidence).not.toHaveBeenCalled(); expect(postFinalized).not.toHaveBeenCalled();
  });

  it("accepts exact six-confirmation evidence and queues accounting", async () => {
    const value = record(); const final = evidence(value);
    transactionStatus.mockResolvedValue({ state: "confirmed", confirmations: 6, blockHeight: 95, blockHash: final.blockHash });
    finalizedEvidence.mockResolvedValue({ evidence: final });
    await checkBitcoinPaymentFinalization("btc-1");
    expect(finalizedEvidence).toHaveBeenCalledWith(expect.objectContaining({ treasuryId: "btc-1", receipt: value.receipt }));
    expect(useBitcoinBroadcastStore.getState().records["btc-1"]).toMatchObject({ accountingState: "ready", finalizedEvidence: { confirmations: 6 } });
    expect(postFinalized).toHaveBeenCalledWith("btc-1");
  });

  it("turns a later finalized regression into reconciliation without reposting", async () => {
    const value = record();
    useBitcoinBroadcastStore.setState({ records: { "btc-1": { ...value, status: { state: "confirmed", confirmations: 6, blockHeight: 95, blockHash: "1".repeat(64) }, finalizedEvidence: evidence(value), accountingState: "posted", accountingRecordName: "BATCH-1", journalEntryName: "JE-1" } } });
    transactionStatus.mockResolvedValue({ state: "unknown", confirmations: 0, blockHeight: null, blockHash: null });
    await checkBitcoinPaymentFinalization("btc-1");
    expect(useBitcoinBroadcastStore.getState().records["btc-1"]).toMatchObject({ accountingState: "reconciliation_required", accountingRecordName: "BATCH-1", journalEntryName: "JE-1" });
    expect(postFinalized).not.toHaveBeenCalled();
  });
});
