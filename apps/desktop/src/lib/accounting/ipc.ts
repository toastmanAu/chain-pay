import type { AccountingJournalPreview } from "@chain-pay/shared";

export interface PostJournalResult {
  jeName: string;
  idempotent: boolean;
}

/** Thin renderer wrapper over the typed IPC bridge. Throws on failure. */
export function postJournal(
  batchId: string,
  preview: AccountingJournalPreview,
): Promise<PostJournalResult> {
  return window.chainpay.accounting.postJournal(batchId, preview);
}
