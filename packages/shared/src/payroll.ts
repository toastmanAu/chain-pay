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
  /** Cleartext TransferPacket string, persisted at build time so the retry
   *  scheduler can rebroadcast even after PayPanel unmounts. Same string the
   *  signer would have pasted; not sensitive (already encrypted per-peer on chain). */
  commPacket?: string;
  /** Partial signatures collected so far. Cleared on successful broadcast. */
  partialSigs?: PartialSigEntry[];
  /**
   * Per-slot send status for the operator's comm-channel dispatch (2.7b-2).
   * Keyed by multisig slotIndex. Absent when comm send hasn't been attempted.
   */
  commSendStatus?: Record<number, CommSendSlotStatus>;
}

export interface CommSendSlotStatus {
  status: "idle" | "sending" | "sent" | "acked" | "error";
  /** Tx hash of the operator's notification cell on the signer's lock. */
  txHash?: string;
  /** Human-readable failure reason for status === "error". */
  error?: string;
  /** Epoch ms of the last status change. */
  updatedAt: number;
  /** Number of auto-retries completed for this slot (0..3). Reset to 0 on
   *  manual Retry. Used by useCommSendRetry to decide next-delay + stop. */
  retryCount?: number;
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
  /** The multisig signer pubkey hash this signature verified against.
   *  Populated by the comm-channel auto-match path; the paste flow may
   *  leave it undefined. Audit-only — the canonical mapping of slot to
   *  signer lives on the treasury config. */
  signerPubkeyHash?: `0x${string}`;
  /** If the signature arrived via the comm channel, the tx hash of the
   *  signer's notification cell. Audit trail; undefined for pasted sigs. */
  sourceCommTx?: string;
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

/**
 * Chain-agnostic opaque string carrying a serialised transfer packet.
 * CKB adapter: JSON produced by encodeTransferPacket (transfer-packet.ts).
 * EVM adapter: JSON of a Safe-protocol SafeTx skeleton (Phase 3+).
 * Travels encrypted over the CommTransport channel.
 */
export type TransferPacket = string & { readonly __brand: "TransferPacket" };

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
