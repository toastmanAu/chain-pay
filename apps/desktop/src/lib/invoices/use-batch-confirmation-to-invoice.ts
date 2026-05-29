import { useEffect } from "react";
import { useInvoicesStore } from "@/stores/invoices";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";

/**
 * Pure side-effect: for every batch in `confirmed` state whose linked invoice
 * is still in `queued-for-signing`, transition the invoice to `signed` and
 * populate chainpay_link from the batch's tx hash.
 *
 * Idempotent — already-signed invoices are skipped (the state-machine guards).
 */
export function syncBatchConfirmedToInvoice(): void {
  const batches = usePayrollBatchesStore.getState().batches;
  const invoices = useInvoicesStore.getState().invoices;
  for (const b of batches) {
    if (b.state !== "confirmed" || !b.pendingTxId) continue;
    const linked = invoices.find((i) => i.batchId === b.id);
    if (!linked || linked.approval.status !== "queued-for-signing") continue;
    useInvoicesStore
      .getState()
      .markSigned(linked.id, { txHash: b.pendingTxId, chain: "ckb" });
  }
}

/** React hook: subscribe to batch store and run sync whenever it changes. */
export function useBatchConfirmationSync(): void {
  useEffect(() => {
    syncBatchConfirmedToInvoice();
    const unsub = usePayrollBatchesStore.subscribe(() =>
      syncBatchConfirmedToInvoice(),
    );
    return unsub;
  }, []);
}
