import type { ConfirmedPaymentRecord } from "@chain-pay/shared";

export interface PostJournalResult {
  jeName: string;
  idempotent: boolean;
  recordName: string;
  recordIdempotent: boolean;
}

export interface ComplianceFilters {
  fromDate?: string;
  toDate?: string;
  chain?: "ckb:mainnet" | "ckb:testnet" | "evm:11155111" | "sol:devnet" | "sol:mainnet";
}

export interface ComplianceSaveResult {
  canceled: boolean;
  filePath?: string;
  rowCount?: number;
  sha256?: string;
}

/** Thin renderer wrapper over the typed IPC bridge. Throws on failure. */
export function postJournal(record: ConfirmedPaymentRecord): Promise<PostJournalResult> {
  return window.chainpay.accounting.postJournal(record);
}

export function exportCompliance(
  filters: ComplianceFilters,
  format: "csv" | "pdf",
): Promise<ComplianceSaveResult> {
  return window.chainpay.accounting.exportCompliance(filters, format);
}
