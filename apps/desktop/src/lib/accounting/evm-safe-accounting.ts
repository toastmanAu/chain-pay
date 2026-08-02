import { getAddress, isAddress } from "viem";
import type { ConfirmedPaymentRecord, PendingTx, TransactionHash } from "@chain-pay/shared";
import { usePendingTransactionsStore } from "@/stores/pending-transactions";
import { canonicalSafeTxHash, parseSafePayment } from "@/lib/chains/evm/safe";
import { postJournal } from "./ipc";

const postingByTransaction = new Map<string, Promise<void>>();

export function buildConfirmedSafePaymentRecord(pending: PendingTx): ConfirmedPaymentRecord {
  if (pending.chain !== "evm:11155111") throw new Error("only Sepolia Safe accounting is enabled");
  if (!pending.broadcastedHash) throw new Error("confirmed Safe payment has no outer transaction hash");
  if (!pending.confirmedAt || !pending.confirmedBlockNumber) {
    throw new Error("confirmed Safe payment is missing block evidence");
  }
  if (!pending.executorAddress || !isAddress(pending.executorAddress, { strict: false })) {
    throw new Error("confirmed Safe payment is missing its executor address");
  }
  if (!pending.receiptGasUsed || !pending.receiptEffectiveGasPriceWei || !pending.receiptGasFeeWei) {
    throw new Error("confirmed Safe payment is missing receipt gas evidence");
  }
  if (!pending.accounting?.payeeId.trim() || pending.accounting.fiat.minor <= 0n) {
    throw new Error("confirmed Safe payment is missing a positive accounting value");
  }

  const payload = parseSafePayment(pending.payloadJson);
  const safeTxHash = canonicalSafeTxHash(payload);
  if (safeTxHash.toLowerCase() !== pending.signingDigest.toLowerCase()) {
    throw new Error("saved SafeTx hash does not match the immutable payment payload");
  }
  const gasUsed = BigInt(pending.receiptGasUsed);
  const gasPrice = BigInt(pending.receiptEffectiveGasPriceWei);
  const gasFee = BigInt(pending.receiptGasFeeWei);
  if (gasUsed <= 0n || gasPrice <= 0n || gasFee !== gasUsed * gasPrice) {
    throw new Error("receipt gas evidence is inconsistent");
  }

  return {
    batchId: pending.id,
    sourceType: "send",
    label: `Safe payment ${pending.id}`,
    chain: pending.chain,
    txHash: pending.broadcastedHash,
    confirmedAt: pending.confirmedAt,
    lines: [
      {
        payeeId: pending.accounting.payeeId.trim(),
        fiat: { ...pending.accounting.fiat },
        crypto: { asset: "ETH", value: BigInt(payload.tx.value), decimals: 18 },
      },
    ],
    evm: {
      safeAddress: getAddress(payload.safeAddress),
      safeTxHash: safeTxHash as TransactionHash,
      outerTxHash: pending.broadcastedHash,
      executorAddress: getAddress(pending.executorAddress),
      recipientAddress: getAddress(payload.tx.to),
      confirmedBlockNumber: pending.confirmedBlockNumber,
      gasUsed: pending.receiptGasUsed,
      effectiveGasPriceWei: pending.receiptEffectiveGasPriceWei,
      gasFeeWei: pending.receiptGasFeeWei,
      gasPayer: "executor",
    },
  };
}

async function runPostSafePayment(pendingId: string): Promise<void> {
  const store = usePendingTransactionsStore.getState();
  const pending = store.findById(pendingId);
  if (!pending || (pending.state !== "confirmed" && pending.state !== "post_failed")) return;

  store.markPosting(pendingId);
  try {
    const result = await postJournal(buildConfirmedSafePaymentRecord(pending));
    usePendingTransactionsStore.getState().markPosted(pendingId, result.jeName, result.recordName);
  } catch (error) {
    usePendingTransactionsStore
      .getState()
      .markPostFailed(pendingId, error instanceof Error ? error.message : "unknown posting error");
  }
}

/** Retry-safe and single-flight: this path never re-executes the Safe transaction. */
export function postConfirmedSafePayment(pendingId: string): Promise<void> {
  const existing = postingByTransaction.get(pendingId);
  if (existing) return existing;
  const posting = runPostSafePayment(pendingId).finally(() => {
    if (postingByTransaction.get(pendingId) === posting) postingByTransaction.delete(pendingId);
  });
  postingByTransaction.set(pendingId, posting);
  return posting;
}
