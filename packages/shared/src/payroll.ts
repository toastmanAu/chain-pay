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
  /**
   * Frozen skeleton — hex of the CCC Transaction's serialized bytes at build
   * time. Required so PayPanel can resume from step 5/6 across navigation +
   * window reloads without re-running buildPaymentSkeleton (which would
   * re-fetch FX and shift output capacities → break already-collected sigs).
   */
  txBytes?: string;
  /** Sighash digest computed once at build — what co-signers sign against. */
  sighashDigest?: string;
  /** Summary fields cached so we can re-encode the transfer packet on resume. */
  totals?: PayrollBatchTotals;
  /** Partial signatures collected so far. Cleared on successful broadcast. */
  partialSigs?: PartialSigEntry[];
}

export interface PayrollBatchTotals {
  totalIn: bigint;
  totalOut: bigint;
  fee: bigint;
  change: bigint;
}

export interface PartialSigEntry {
  slotIndex: number;
  signature: string;
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
