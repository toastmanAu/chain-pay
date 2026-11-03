import { useEffect } from "react";
import { useInvoicesStore } from "@/stores/invoices";
import { invoiceFromMobileInbox } from "./mobile-inbox";

/** Reconcile the durable main-process inbox on startup and after every arrival. */
export async function importMobileInbox(): Promise<number> {
  const entries = await window.chainpay.pair.listMobileInbox();
  let imported = 0;
  for (const entry of entries) {
    const store = useInvoicesStore.getState();
    if (store.findById(entry.invoiceId)) continue;
    store.addInvoice(invoiceFromMobileInbox(entry), "extracted");
    imported += 1;
  }
  return imported;
}

export function useMobileInvoiceIntake(): void {
  useEffect(() => {
    const reconcile = (): void => {
      void importMobileInbox().catch((error: unknown) => {
        console.error("Mobile invoice intake failed:", error);
      });
    };
    const unsubscribe = window.chainpay.pair.onInvoiceReceived(reconcile);
    reconcile();
    return unsubscribe;
  }, []);
}
