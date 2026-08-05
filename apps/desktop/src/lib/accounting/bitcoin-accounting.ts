import type { ConfirmedPaymentRecord } from "@chain-pay/shared";
import { useBitcoinBroadcastStore, type BitcoinBroadcastRecord } from "@/stores/bitcoin-broadcast";
import { postJournal } from "./ipc";

const postingByTreasury = new Map<string, Promise<void>>();

export function buildFinalizedBitcoinPaymentRecord(record: BitcoinBroadcastRecord): ConfirmedPaymentRecord {
  const { review, receipt, finalizedEvidence: evidence } = record;
  if (review?.reviewVersion !== 2) throw new Error("legacy Bitcoin broadcasts have no committed accounting intent");
  if (!receipt || !evidence || record.status?.state !== "confirmed") throw new Error("Bitcoin payment is missing finalized evidence");
  if (record.reconciliationRequired || record.accountingState === "reconciliation_required") throw new Error("Bitcoin payment requires reconciliation before accounting can continue");
  if (record.accountingState !== "ready" && record.accountingState !== "post_failed") throw new Error("Bitcoin payment accounting is not ready to post");
  const pairs: Array<[unknown, unknown]> = [
    [evidence.chain, review.chain], [evidence.reviewDigest, review.digest], [evidence.txid, receipt.txid],
    [evidence.wtxid, review.wtxid], [evidence.rawTransactionHash, review.rawTransactionHash],
    [evidence.transactionVersion, review.version], [evidence.lockTime, review.lockTime],
    [evidence.inputValueSats, review.inputValueSats], [evidence.outputValueSats, review.outputValueSats],
    [evidence.feeSats, review.feeSats], [evidence.feeRateSatsPerVbyte, review.feeRateSatsPerVbyte],
    [JSON.stringify(evidence.outputs), JSON.stringify(review.outputs)],
  ];
  if (evidence.version !== 1 || evidence.confirmations < 6 || evidence.feePayerPolicy !== "transaction_inputs" || pairs.some(([actual, expected]) => actual !== expected)) {
    throw new Error("finalized Bitcoin evidence no longer matches the immutable review");
  }
  canonicalSats(evidence.inputValueSats, false, "input total");
  canonicalSats(evidence.outputValueSats, false, "output total");
  canonicalSats(evidence.feeSats, false, "fee");

  return {
    batchId: `bitcoin:${review.digest}`,
    sourceType: "send",
    label: `Bitcoin payment ${review.digest.slice(0, 12)}`,
    chain: review.chain,
    txHash: review.txid,
    confirmedAt: evidence.blockTime,
    lines: review.accounting.map((line) => ({
      payeeId: line.payeeId,
      fiat: { currency: "USD", minor: canonicalMinor(line.fiat.minor) },
      crypto: { asset: "BTC", value: canonicalSats(line.valueSats, true, "payment output"), decimals: 8 },
    })),
    bitcoin: {
      reviewDigest: review.digest,
      wtxid: review.wtxid,
      rawTransactionHash: review.rawTransactionHash,
      blockHeight: evidence.blockHeight,
      blockHash: evidence.blockHash,
      confirmations: String(evidence.confirmations),
      inputValueSats: evidence.inputValueSats,
      outputValueSats: evidence.outputValueSats,
      feeSats: evidence.feeSats,
      feeRateSatsPerVbyte: evidence.feeRateSatsPerVbyte,
      feePayerPolicy: evidence.feePayerPolicy,
      outputs: review.accounting.map((line) => ({ vout: String(line.vout), destination: line.destination, valueSats: line.valueSats })),
    },
  };
}

async function runPost(treasuryId: string): Promise<void> {
  const store = useBitcoinBroadcastStore.getState();
  const record = store.records[treasuryId];
  if (!record || (record.accountingState !== "ready" && record.accountingState !== "post_failed")) return;
  let source: ConfirmedPaymentRecord;
  try {
    source = buildFinalizedBitcoinPaymentRecord(record);
    store.beginAccountingPost(treasuryId);
  } catch (error) {
    try {
      store.beginAccountingPost(treasuryId);
      useBitcoinBroadcastStore.getState().markAccountingPostFailed(treasuryId, message(error));
    } catch { /* A reconciliation transition won the race. */ }
    return;
  }
  try {
    const result = await postJournal(source);
    useBitcoinBroadcastStore.getState().markAccountingPosted(treasuryId, result.jeName, result.recordName);
  } catch (error) {
    useBitcoinBroadcastStore.getState().markAccountingPostFailed(treasuryId, message(error));
  }
}

export function postFinalizedBitcoinPayment(treasuryId: string): Promise<void> {
  const active = postingByTreasury.get(treasuryId);
  if (active) return active;
  const posting = runPost(treasuryId).finally(() => {
    if (postingByTreasury.get(treasuryId) === posting) postingByTreasury.delete(treasuryId);
  });
  postingByTreasury.set(treasuryId, posting);
  return posting;
}

function canonicalSats(value: string, positive: boolean, label: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Bitcoin ${label} is not canonical`);
  const parsed = BigInt(value);
  if (parsed > 2_100_000_000_000_000n || (positive ? parsed <= 0n : parsed < 0n)) throw new Error(`Bitcoin ${label} is outside the money range`);
  return parsed;
}
function canonicalMinor(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Bitcoin accounting value is not canonical and positive");
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) throw new Error("Bitcoin accounting value is outside the supported range");
  return parsed;
}
function message(error: unknown): string { return error instanceof Error ? error.message : "unknown Bitcoin accounting error"; }
