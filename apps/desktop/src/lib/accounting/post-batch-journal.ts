import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { DEFAULT_ACCOUNT_MAP } from "./account-map";
import { buildBatchJournalForBatch } from "./batch-to-journal-inputs";
import { postJournal } from "./ipc";

/**
 * Single execution path shared by the confirmation reactor (Task 10) and the
 * Retry button (Task 11).
 *
 * Guards:
 * - batch must exist
 * - batch.kind must be "payroll" (vendor batches are never accounting-posted;
 *   the kind check also narrows AnyBatch → PayrollBatch for TypeScript)
 * - batch.state must be "confirmed" or "post_failed" (the double-fire guard:
 *   a batch already in "posting" or "posted" is skipped)
 *
 * Transitions confirmed|post_failed → posting, POSTs to Frappe, then records
 * the result. Never throws — failures land as post_failed.
 */
export async function postBatchJournal(batchId: string): Promise<void> {
  const store = usePayrollBatchesStore.getState();
  const batch = store.batches.find((b) => b.id === batchId);
  if (!batch) return;
  if (batch.kind !== "payroll") return; // kind guard: vendor batches are never posted
  if (batch.state !== "confirmed" && batch.state !== "post_failed") return; // double-fire guard

  store.markPosting(batchId);
  try {
    const preview = buildBatchJournalForBatch(batch, DEFAULT_ACCOUNT_MAP);
    const { jeName } = await postJournal(batchId, preview);
    usePayrollBatchesStore.getState().markPosted(batchId, jeName);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown posting error";
    usePayrollBatchesStore.getState().markPostFailed(batchId, message);
  }
}
