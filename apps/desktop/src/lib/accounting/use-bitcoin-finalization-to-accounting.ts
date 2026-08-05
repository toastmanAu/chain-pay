import { useEffect } from "react";
import { bitcoinBridge } from "@/lib/chains/btc/ipc";
import { useBitcoinBroadcastStore } from "@/stores/bitcoin-broadcast";
import { postFinalizedBitcoinPayment } from "./bitcoin-accounting";

const checkingByTreasury = new Map<string, Promise<void>>();

async function runCheck(treasuryId: string): Promise<void> {
  let record = useBitcoinBroadcastStore.getState().records[treasuryId];
  if (!record?.receipt) return;
  try {
    const status = await bitcoinBridge().transactionStatus({ chain: record.chain, txid: record.receipt.txid });
    useBitcoinBroadcastStore.getState().refreshStatus(treasuryId, status);
  } catch {
    if (record.accountingState === "awaiting_finalization") useBitcoinBroadcastStore.getState().finalizationFailed(treasuryId, "Bitcoin status is temporarily unavailable; the last known state was preserved");
    return;
  }
  record = useBitcoinBroadcastStore.getState().records[treasuryId];
  if (!record?.receipt || record.reconciliationRequired) return;
  if (record.review?.reviewVersion === 2 && record.status?.state === "confirmed" && record.accountingState === "awaiting_finalization") {
    try {
      const response = await bitcoinBridge().finalizedEvidence({ chain: record.chain, treasuryId, review: record.review, receipt: record.receipt });
      useBitcoinBroadcastStore.getState().acceptFinalizedEvidence(treasuryId, response.evidence);
    } catch (error) {
      useBitcoinBroadcastStore.getState().finalizationFailed(treasuryId, message(error));
      return;
    }
  }
  record = useBitcoinBroadcastStore.getState().records[treasuryId];
  if (record?.accountingState === "ready") await postFinalizedBitcoinPayment(treasuryId);
}

export function checkBitcoinPaymentFinalization(treasuryId: string): Promise<void> {
  const active = checkingByTreasury.get(treasuryId);
  if (active) return active;
  const checking = runCheck(treasuryId).finally(() => {
    if (checkingByTreasury.get(treasuryId) === checking) checkingByTreasury.delete(treasuryId);
  });
  checkingByTreasury.set(treasuryId, checking);
  return checking;
}

export function syncBitcoinPaymentsToAccounting(): void {
  for (const [treasuryId, record] of Object.entries(useBitcoinBroadcastStore.getState().records)) {
    if (record.receipt) void checkBitcoinPaymentFinalization(treasuryId);
  }
}

export function useBitcoinFinalizationToAccounting(): void {
  useEffect(() => {
    syncBitcoinPaymentsToAccounting();
    const unsubscribe = useBitcoinBroadcastStore.subscribe(syncBitcoinPaymentsToAccounting);
    const interval = globalThis.setInterval(syncBitcoinPaymentsToAccounting, 30_000);
    return () => { unsubscribe(); globalThis.clearInterval(interval); };
  }, []);
}

function message(error: unknown): string { return error instanceof Error ? error.message : "Bitcoin finalization check failed"; }
