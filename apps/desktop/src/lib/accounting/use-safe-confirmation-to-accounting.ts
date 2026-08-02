import { useEffect } from "react";
import { usePendingTransactionsStore } from "@/stores/pending-transactions";
import { postConfirmedSafePayment } from "./evm-safe-accounting";

export function syncConfirmedSafePaymentsToAccounting(): void {
  for (const pending of usePendingTransactionsStore.getState().transactions) {
    if (pending.chain === "evm:11155111" && pending.state === "confirmed") {
      void postConfirmedSafePayment(pending.id);
    }
  }
}

export function useSafeConfirmationToAccounting(): void {
  useEffect(() => {
    syncConfirmedSafePaymentsToAccounting();
    return usePendingTransactionsStore.subscribe(syncConfirmedSafePaymentsToAccounting);
  }, []);
}
