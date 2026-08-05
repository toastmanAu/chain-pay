// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BitcoinBroadcastReviewV2, BitcoinFinalizedPaymentEvidence } from "@chain-pay/shared";
import { useBitcoinBroadcastStore, type BitcoinBroadcastRecord } from "@/stores/bitcoin-broadcast";

const postJournal = vi.fn();
vi.mock("./ipc", () => ({ postJournal: (...args: unknown[]) => postJournal(...args) }));

import { buildFinalizedBitcoinPaymentRecord, postFinalizedBitcoinPayment } from "./bitcoin-accounting";

const external = { vout: 0, address: "tb1qfm7m0et5az22ppyr8wz987qq5t5w6w863mpy0k", valueSats: "2099999999998000", scriptType: "p2wpkh" as const, watched: false, changeCandidate: false };
const change = { vout: 1, address: "tb1q3w0zcj5ys672jz5wx26w0jjwt5mznlk9ryzq7n", valueSats: "1000", scriptType: "p2wpkh" as const, watched: true, changeCandidate: true };

function finalized(): BitcoinBroadcastRecord {
  const review: BitcoinBroadcastReviewV2 = {
    reviewVersion: 2, digest: "a".repeat(64), rawTransactionHash: "b".repeat(64), treasuryId: "btc-1", chain: "btc:testnet",
    txid: "c".repeat(64), wtxid: "d".repeat(64), version: 2, lockTime: 0, sizeBytes: 120, weight: 480, vsize: 120,
    inputValueSats: "2100000000000000", outputValueSats: "2099999999999000", feeSats: "1000", feeRateSatsPerVbyte: "8.333",
    tipHeight: 100, tipHash: "e".repeat(64), watchSetHash: "f".repeat(64), inputs: [], outputs: [external, change], warnings: [],
    accounting: [{ vout: 0, destination: external.address, valueSats: external.valueSats, payeeId: "vendor-42", fiat: { currency: "USD", minor: "2599" } }],
  };
  const evidence: BitcoinFinalizedPaymentEvidence = {
    version: 1, chain: review.chain, reviewDigest: review.digest, txid: review.txid, wtxid: review.wtxid,
    rawTransactionHash: review.rawTransactionHash, blockHeight: "9007199254740995", blockHash: "1".repeat(64),
    blockTime: "2026-08-06T00:00:00.000Z", confirmations: 6, transactionVersion: review.version, lockTime: review.lockTime,
    inputValueSats: review.inputValueSats, outputValueSats: review.outputValueSats, feeSats: review.feeSats,
    feeRateSatsPerVbyte: review.feeRateSatsPerVbyte, feePayerPolicy: "transaction_inputs", outputs: review.outputs,
  };
  return {
    treasuryId: "btc-1", chain: review.chain, rawTxHex: "00", state: "submitted", review,
    receipt: { txid: review.txid, reviewDigest: review.digest, state: "submitted", submittedAt: "2026-08-06T00:00:00.000Z" },
    status: { state: "confirmed", confirmations: 6, blockHeight: 90, blockHash: evidence.blockHash }, reorged: false,
    finalizedEvidence: evidence, accountingState: "ready", accountingRecordName: null, journalEntryName: null,
    accountingError: null, reconciliationRequired: false, error: null, createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z",
  };
}

beforeEach(() => {
  postJournal.mockReset();
  useBitcoinBroadcastStore.setState({ records: { "btc-1": finalized() } });
});

describe("finalized Bitcoin accounting", () => {
  it("builds deterministic exact-satoshi lines and finalized Bitcoin metadata", () => {
    expect(buildFinalizedBitcoinPaymentRecord(finalized())).toEqual(expect.objectContaining({
      batchId: `bitcoin:${"a".repeat(64)}`, chain: "btc:testnet", txHash: "c".repeat(64),
      lines: [{ payeeId: "vendor-42", fiat: { currency: "USD", minor: 2599n }, crypto: { asset: "BTC", value: 2099999999998000n, decimals: 8 } }],
      bitcoin: expect.objectContaining({ blockHeight: "9007199254740995", confirmations: "6", feeSats: "1000", outputs: [{ vout: "0", destination: external.address, valueSats: external.valueSats }] }),
    }));
  });

  it("rejects legacy, five-confirmation, tampered, and reconciliation records", () => {
    const value = finalized();
    expect(() => buildFinalizedBitcoinPaymentRecord({ ...value, review: { ...value.review!, reviewVersion: undefined } as never })).toThrow(/legacy/);
    expect(() => buildFinalizedBitcoinPaymentRecord({ ...value, finalizedEvidence: { ...value.finalizedEvidence!, confirmations: 5 } })).toThrow(/evidence/);
    expect(() => buildFinalizedBitcoinPaymentRecord({ ...value, finalizedEvidence: { ...value.finalizedEvidence!, feeSats: "1" } })).toThrow(/evidence/);
    expect(() => buildFinalizedBitcoinPaymentRecord({ ...value, reconciliationRequired: true })).toThrow(/reconciliation/);
  });

  it("posts single-flight, retains both backend identities, and safely retries a lost response", async () => {
    let release!: () => void;
    postJournal.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ jeName: "JE-BTC-1", recordName: "BATCH-BTC-1", idempotent: false, recordIdempotent: false }); }));
    const first = postFinalizedBitcoinPayment("btc-1");
    const second = postFinalizedBitcoinPayment("btc-1");
    expect(postJournal).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(useBitcoinBroadcastStore.getState().records["btc-1"]).toMatchObject({ accountingState: "posted", journalEntryName: "JE-BTC-1", accountingRecordName: "BATCH-BTC-1" });

    useBitcoinBroadcastStore.setState({ records: { "btc-1": { ...finalized(), accountingState: "post_failed" } } });
    postJournal.mockResolvedValueOnce({ jeName: "JE-BTC-1", recordName: "BATCH-BTC-1", idempotent: true, recordIdempotent: true });
    await postFinalizedBitcoinPayment("btc-1");
    expect(postJournal).toHaveBeenCalledTimes(2);
  });
});
