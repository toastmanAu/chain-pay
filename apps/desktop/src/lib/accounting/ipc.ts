import type { ConfirmedPaymentRecord } from "@chain-pay/shared";

export interface PostJournalResult {
  jeName: string;
  idempotent: boolean;
  recordName: string;
  recordIdempotent: boolean;
}

/** Thin renderer wrapper over the typed IPC bridge. Throws on failure. */
export function postJournal(record: ConfirmedPaymentRecord): Promise<PostJournalResult> {
  return window.chainpay.accounting.postJournal(record);
}
