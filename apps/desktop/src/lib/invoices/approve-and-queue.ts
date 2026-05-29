import type { InvoiceRecord, Treasury } from "@chain-pay/shared";
import { useInvoicesStore } from "@/stores/invoices";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { routeInvoiceToBatch } from "./route-to-batch";

export interface ApproveAndQueueResult {
  batchId: string;
}

/**
 * Promote an `in-review` invoice to `queued-for-signing` and create the linked
 * batch. Safe-ordered writes:
 *
 *   1. Build the batch (pure, throws on routing errors → no state changes).
 *   2. Persist the batch (write FIRST).
 *   3. Transition the invoice (writes the backlink batchId).
 *
 * If step 3 throws (rare — localStorage quota only), the batch is an orphan in
 * the payroll list and the invoice remains in `in-review`. Operator can cancel
 * the orphan or re-approve the invoice. Either outcome is recoverable.
 *
 * If we wrote the invoice first and step 2 failed, the invoice would point at
 * a non-existent batch — strictly worse, hence the ordering.
 */
export function approveAndQueue(
  invoice: InvoiceRecord,
  treasury: Treasury,
  reviewerId: string,
): ApproveAndQueueResult {
  if (!treasury) throw new Error("treasury required for approve-and-queue");

  const batch = routeInvoiceToBatch(invoice, treasury);
  usePayrollBatchesStore.getState().addBatch(batch);
  useInvoicesStore.getState().markQueuedForSigning(invoice.id, batch.id, reviewerId);

  return { batchId: batch.id };
}
