import {
  buildBatchJournal,
  type AccountingJournalPreview,
  type PaymentJournalInput,
  type SendRecord,
  type TransactionHash,
} from "@chain-pay/shared";
import { useSendsStore } from "@/stores/sends";
import { postJournal } from "@/lib/accounting/ipc";

export interface SendAccountMap {
  expense: string;
  treasury: string;
  networkFeeExpense: string;
  fxGainLoss: string;
}

/**
 * Defaults to the four seeded ERPNext accounts. `expense` is the seeded salary
 * account because that's the only expense account the seed creates; proper
 * vendor/AP accounts are a backend (Slice E/F) follow-up.
 */
export const DEFAULT_SEND_ACCOUNT_MAP: SendAccountMap = {
  expense: "Salary or Wage Expense",
  treasury: "Crypto Treasury Asset",
  networkFeeExpense: "Network Fee Expense",
  fxGainLoss: "FX Gain/Loss",
};

export function buildSendJournal(send: SendRecord, map: SendAccountMap): AccountingJournalPreview {
  if (!send.txHash) throw new Error(`send ${send.id} has no txHash; cannot build journal`);
  const txHash = send.txHash as TransactionHash;
  const payments: PaymentJournalInput[] = send.outputs.map((o) => ({
    payeeId: o.payeeId,
    obligation: { ...o.fiat },
    feeFiat: { currency: o.fiat.currency, minor: 0n },
    carryingCost: { ...o.fiat }, // zero-FX
    crypto: { ...o.amount },
    chain: send.chain,
    txHash,
    salaryAccount: map.expense,
    treasuryAccount: map.treasury,
  }));
  return buildBatchJournal(send.id, payments, {
    networkFeeExpense: map.networkFeeExpense,
    fxGainLoss: map.fxGainLoss,
    memoLabel: "Send",
  });
}

/**
 * Post a confirmed send's JE. Mirrors postBatchJournal: confirmed|post_failed →
 * posting → posted|post_failed. Never throws — failures land as post_failed.
 */
export async function postSendJournal(sendId: string): Promise<void> {
  const store = useSendsStore.getState();
  const send = store.sends.find((s) => s.id === sendId);
  if (!send) return;
  if (send.state !== "confirmed" && send.state !== "post_failed") return; // double-fire guard

  store.markPosting(sendId);
  try {
    const preview = buildSendJournal(send, DEFAULT_SEND_ACCOUNT_MAP);
    const { jeName } = await postJournal(sendId, preview);
    useSendsStore.getState().markPosted(sendId, jeName);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown posting error";
    useSendsStore.getState().markPostFailed(sendId, message);
  }
}
