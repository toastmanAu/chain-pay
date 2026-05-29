import type { InvoiceApprovalStatus } from "@chain-pay/shared";

/**
 * Invoice approval lifecycle. Separate from PayrollBatchState — invoices live
 * upstream of batches. Once an invoice transitions to `queued-for-signing`,
 * the linked batch's state machine takes over; on batch.state === "confirmed",
 * the linked invoice transitions to "signed".
 *
 *   draft ───► in-review ───► queued-for-signing ───► signed
 *                  │
 *                  └────► rejected
 *
 * signed, rejected, auto-rejected are terminal.
 * auto-rejected is reserved for Phase 3b (OCR confidence below threshold).
 */
const TRANSITIONS: Record<InvoiceApprovalStatus, InvoiceApprovalStatus[]> = {
  draft: ["in-review"],
  "in-review": ["queued-for-signing", "rejected"],
  "queued-for-signing": ["signed"],
  signed: [],
  rejected: [],
  "auto-rejected": [],
};

export const terminalInvoiceStates: readonly InvoiceApprovalStatus[] = ["signed", "rejected", "auto-rejected"];

export function canTransitionInvoice(from: InvoiceApprovalStatus, to: InvoiceApprovalStatus): boolean {
  if (from === to) return false;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertCanTransitionInvoice(from: InvoiceApprovalStatus, to: InvoiceApprovalStatus): void {
  if (!canTransitionInvoice(from, to)) {
    throw new Error(
      `invalid invoice transition: ${from} → ${to} (allowed from '${from}': ${TRANSITIONS[from]?.join(", ") || "none"})`,
    );
  }
}

export function isTerminalInvoice(state: InvoiceApprovalStatus): boolean {
  return terminalInvoiceStates.includes(state);
}

export function nextInvoiceStates(from: InvoiceApprovalStatus): InvoiceApprovalStatus[] {
  return TRANSITIONS[from] ?? [];
}
