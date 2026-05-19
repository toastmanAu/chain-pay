import type { Identified, PayeeAddress, Timestamped, TransactionHash } from "./types";
import type { ChainId } from "./chainIds";
import type { FiatAmount, FxQuote, Money } from "./money";

export interface PayeeProfile extends Identified, Timestamped {
  displayName: string;
  /** ERPNext employee/contractor id, set when synced from Frappe. */
  frappeRef?: string;
  /** Salary amount denominated in fiat. */
  salaryFiat: FiatAmount;
  preferredChain: ChainId;
  preferredAsset: string;
  walletAddress: PayeeAddress;
  /** Optional split — sum of percentages must equal 100. */
  splits?: Array<{ chain: ChainId; asset: string; walletAddress: PayeeAddress; percent: number }>;
  active: boolean;
}

export interface PayrollBatch extends Identified, Timestamped {
  label: string;
  treasuryId: string;
  cycleStart: string;
  cycleEnd: string;
  /** Snapshot of FX rates used at calculation time — locks in compliance values. */
  fxSnapshot: FxQuote[];
  /** One per payee per output (split-aware). */
  lines: PayrollBatchLine[];
  state: PayrollBatchState;
  /** Pending tx id once the batch produces a single multisig tx. */
  pendingTxId?: string;
}

export type PayrollBatchState =
  | "draft"
  | "calculated"
  | "approved"
  | "broadcasted"
  | "confirmed"
  | "failed"
  | "cancelled";

export interface PayrollBatchLine {
  payeeId: string;
  fiat: FiatAmount;
  crypto: Money;
  fxRate: string;
  /** Network fee allocated to this line (proportional, for accounting). */
  feeAllocated: Money;
}

export interface AccountingJournalPreview {
  batchId: string;
  entries: JournalEntry[];
}

export interface JournalEntry {
  account: string;
  debit?: FiatAmount;
  credit?: FiatAmount;
  /** Reference to crypto tx hash that triggered the entry. */
  crypto?: {
    chain: ChainId;
    asset: string;
    amount: string;
    txHash: TransactionHash;
  };
  memo?: string;
}
