import { useEffect } from "react";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { postBatchJournal } from "./post-batch-journal";

/**
 * Side-effect: for every payroll batch in `confirmed` state, post its journal
 * entry. Non-payroll (vendor) batches are skipped here and also inside
 * postBatchJournal (belt-and-suspenders kind guard).
 *
 * Idempotent — the confirmed→posting transition inside postBatchJournal is the
 * re-entry guard, so a re-fire (React 19 double-effect, store churn) is a no-op.
 */
export function syncConfirmedToAccounting(): void {
  const batches = usePayrollBatchesStore.getState().batches;
  for (const b of batches) {
    if (b.state !== "confirmed" || b.kind !== "payroll") continue;
    void postBatchJournal(b.id);
  }
}

/** React hook: run on mount and whenever the batches store changes. */
export function useBatchConfirmationToAccounting(): void {
  useEffect(() => {
    syncConfirmedToAccounting();
    const unsub = usePayrollBatchesStore.subscribe(() => syncConfirmedToAccounting());
    return unsub;
  }, []);
}
