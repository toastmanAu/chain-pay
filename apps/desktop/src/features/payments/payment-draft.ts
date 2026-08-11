import type { PayeeProfile, PayrollBatchLine } from "@chain-pay/shared";
import { ckbToShannons } from "@/lib/chains/ckb/units";

export interface RecipientRow {
  address: string;
  amountCkb: string;
  /** Set when the row came from PayeePicker; lets FX recomputation re-fill amountCkb. */
  payeeId?: string;
  /** FX rate used to compute amountCkb, captured per-row so PayrollBatchLine has lineage. */
  fxRate?: string;
}

export function buildBatchLinesFromRecipients(
  rows: RecipientRow[],
  findPayee: (id: string) => PayeeProfile | undefined,
): PayrollBatchLine[] {
  const lines: PayrollBatchLine[] = [];
  for (const row of rows) {
    if (!row.payeeId || !row.fxRate) continue;
    const payee = findPayee(row.payeeId);
    if (!payee) continue;
    const shannons = ckbToShannons(row.amountCkb);
    if (shannons === null) continue;
    lines.push({
      payeeId: row.payeeId,
      fiat: payee.salaryFiat,
      crypto: { asset: "CKB", value: shannons, decimals: 8 },
      fxRate: row.fxRate,
      // Per-line fee allocation is a polish concern; tx-level fee is on the
      // skeleton already. Start at 0; a follow-up can pro-rate the actual
      // skeleton.fee across lines.
      feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
    });
  }
  return lines;
}

export function autoLabel(now: Date = new Date()): string {
  return `Batch ${now.toISOString().slice(0, 10)}`;
}

export function monthStart(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

export function monthEnd(now: Date = new Date()): string {
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}
