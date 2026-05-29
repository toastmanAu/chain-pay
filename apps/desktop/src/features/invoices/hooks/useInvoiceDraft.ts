import { useCallback, useEffect, useRef } from "react";
import type { InvoiceRecord } from "@chain-pay/shared";
import { useInvoiceDraftsStore } from "@/stores/invoice-drafts";

const DEBOUNCE_MS = 500;

export interface UseInvoiceDraftReturn {
  draft: Partial<InvoiceRecord> | undefined;
  update: (partial: Partial<InvoiceRecord>) => void;
  clear: () => void;
}

export function useInvoiceDraft(invoiceId: string): UseInvoiceDraftReturn {
  const draft = useInvoiceDraftsStore((s) => s.drafts[invoiceId]);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<InvoiceRecord> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const update = useCallback(
    (partial: Partial<InvoiceRecord>) => {
      pendingRef.current = { ...(pendingRef.current ?? {}), ...partial };
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        if (pendingRef.current) {
          useInvoiceDraftsStore.getState().upsertDraft(invoiceId, pendingRef.current);
          pendingRef.current = null;
        }
      }, DEBOUNCE_MS);
    },
    [invoiceId],
  );

  const clear = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pendingRef.current = null;
    useInvoiceDraftsStore.getState().clearDraft(invoiceId);
  }, [invoiceId]);

  return { draft, update, clear };
}
