import type { ChainId } from "./chainIds";
import type { TransactionHash } from "./types";
import type { FiatAmount, Money } from "./money";
import type { JournalEntry, AccountingJournalPreview } from "./payroll";

export interface ConfirmedPaymentLine {
  payeeId: string;
  fiat: FiatAmount;
  crypto: Money;
}

export interface EvmConfirmedPaymentMetadata {
  safeAddress: string;
  safeTxHash: TransactionHash;
  outerTxHash: TransactionHash;
  executorAddress: string;
  recipientAddress: string;
  confirmedBlockNumber: string;
  gasUsed: string;
  effectiveGasPriceWei: string;
  gasFeeWei: string;
  /** Safe executions in this slice are submitted and paid by an owner wallet. */
  gasPayer: "executor";
}

/**
 * Immutable accounting source record sent to Frappe after chain confirmation.
 * Ledger accounts are deliberately absent: account selection belongs to the
 * trusted backend, not the renderer or Electron client.
 */
export interface ConfirmedPaymentRecord {
  batchId: string;
  sourceType: "send" | "payroll";
  label: string;
  chain: ChainId;
  txHash: TransactionHash;
  confirmedAt: string;
  lines: ConfirmedPaymentLine[];
  /** Required by the backend when chain is evm:11155111; absent for CKB records. */
  evm?: EvmConfirmedPaymentMetadata;
}

export interface PaymentJournalInput {
  payeeId: string;
  /** F — salary fiat recognized as expense. */
  obligation: FiatAmount;
  /** Network fee in fiat at confirmation. */
  feeFiat: FiatAmount;
  /** Basis (carrying cost) of ALL crypto disposed (salary + fee). Explicit input. */
  carryingCost: FiatAmount;
  /** Total native crypto out, for the treasury asset-line reference. */
  crypto: Money;
  chain: ChainId;
  txHash: TransactionHash;
  /** Expense account, resolved by the caller per payee department. */
  salaryAccount: string;
  /** Treasury asset (sub-)account, resolved by the caller per chain. */
  treasuryAccount: string;
}

export interface JournalAccounts {
  networkFeeExpense: string;
  fxGainLoss: string;
  memoLabel?: string;
}

function memoFor(p: PaymentJournalInput, label: string = "Payroll"): string {
  return `${label} ${p.payeeId} · ${p.txHash.slice(0, 10)}…`;
}

/**
 * Maps one confirmed payment to its balanced journal lines. FX gain/loss is the
 * balancing plug: (obligation + feeFiat) - carryingCost. Fee and FX lines are
 * omitted when zero. Throws on within-payment mixed currency or negative crypto.
 */
export function buildPaymentLines(
  p: PaymentJournalInput,
  accounts: JournalAccounts,
): JournalEntry[] {
  const currency = p.obligation.currency;
  if (p.feeFiat.currency !== currency || p.carryingCost.currency !== currency) {
    throw new Error(
      `buildPaymentLines: mixed fiat currencies for payee ${p.payeeId} ` +
        `(obligation ${currency}, fee ${p.feeFiat.currency}, basis ${p.carryingCost.currency})`,
    );
  }
  if (p.crypto.value < 0n) {
    throw new Error(`buildPaymentLines: negative crypto amount for payee ${p.payeeId}`);
  }

  const memo = memoFor(p, accounts.memoLabel ?? "Payroll");
  const lines: JournalEntry[] = [
    { account: p.salaryAccount, debit: { ...p.obligation }, memo },
    {
      account: p.treasuryAccount,
      credit: { ...p.carryingCost },
      crypto: {
        chain: p.chain,
        asset: p.crypto.asset,
        amount: p.crypto.value.toString(),
        txHash: p.txHash,
      },
      memo,
    },
  ];

  if (p.feeFiat.minor !== 0n) {
    lines.push({ account: accounts.networkFeeExpense, debit: { ...p.feeFiat }, memo });
  }

  const gainLoss = p.obligation.minor + p.feeFiat.minor - p.carryingCost.minor;
  if (gainLoss > 0n) {
    lines.push({ account: accounts.fxGainLoss, credit: { currency, minor: gainLoss }, memo });
  } else if (gainLoss < 0n) {
    lines.push({ account: accounts.fxGainLoss, debit: { currency, minor: -gainLoss }, memo });
  }

  return lines;
}

/**
 * Maps a confirmed batch's payments to a flat, balanced set of journal lines
 * (per-payment groups in input order). Throws if payments disagree on fiat
 * currency. An empty batch returns no entries.
 */
export function buildBatchJournal(
  batchId: string,
  payments: PaymentJournalInput[],
  accounts: JournalAccounts,
): AccountingJournalPreview {
  if (payments.length > 0) {
    const currency = payments[0]!.obligation.currency;
    for (const p of payments) {
      if (p.obligation.currency !== currency) {
        throw new Error(
          `buildBatchJournal: batch mixes fiat currencies ` +
            `(${currency} vs ${p.obligation.currency} for payee ${p.payeeId})`,
        );
      }
    }
  }
  const entries = payments.flatMap((p) => buildPaymentLines(p, accounts));
  return { batchId, entries };
}
