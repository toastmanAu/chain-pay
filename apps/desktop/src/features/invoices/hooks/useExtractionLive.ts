import { useCallback } from "react";
import type { Invoice } from "@chain-pay/shared";
import { useInvoicesStore } from "@/stores/invoices";
import type { ExtractionStatus } from "@/stores/invoices";

export interface ExtractionLive {
  status: ExtractionStatus | null;
  error: string | undefined;
  confidences: Record<string, number>;
  warnings: NonNullable<Invoice["extraction"]["warnings"]>;
}

// Stable fallback references — never recreated, so Object.is stays true.
const EMPTY_CONFIDENCES: Record<string, number> = {};
const EMPTY_WARNINGS: NonNullable<Invoice["extraction"]["warnings"]> = [];

export function useExtractionLive(invoiceId: string): ExtractionLive {
  const status = useInvoicesStore(
    useCallback(
      (s) => s.invoices.find((i) => i.id === invoiceId)?.extractionStatus ?? null,
      [invoiceId],
    ),
  );
  const error = useInvoicesStore(
    useCallback(
      (s) => s.invoices.find((i) => i.id === invoiceId)?.extractionError,
      [invoiceId],
    ),
  );
  const confidences = useInvoicesStore(
    useCallback(
      (s) =>
        s.invoices.find((i) => i.id === invoiceId)?.extraction.field_confidences ??
        EMPTY_CONFIDENCES,
      [invoiceId],
    ),
  );
  const warnings = useInvoicesStore(
    useCallback(
      (s) =>
        s.invoices.find((i) => i.id === invoiceId)?.extraction.warnings ??
        EMPTY_WARNINGS,
      [invoiceId],
    ),
  );
  return { status, error, confidences, warnings };
}
