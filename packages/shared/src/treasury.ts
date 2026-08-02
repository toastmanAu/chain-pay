import type { EvmAddress, Hex20, Identified, Iso8601, PayeeAddress, Timestamped, TransactionHash } from "./types";
import type { ChainId } from "./chainIds";
import type { FiatAmount } from "./money";

export interface CkbMultisig {
  chain: "ckb:mainnet" | "ckb:testnet";
  /** S | R | M | N | pubkey hashes — encoded as bytes inside the witness lock. */
  s: 0;
  r: number;
  m: number;
  n: number;
  pubkeyHashes: Hex20[];
  /** Optional 8-byte since (RFC 0017) for time-locked spends. */
  since?: bigint;
  /** Derived CKB address (ckb1.../ckt1...). */
  address: string;
}

export interface EvmMultisig {
  chain: `evm:${number}`;
  /** Safe contract address. */
  address: EvmAddress;
  owners: EvmAddress[];
  threshold: number;
  /** Safe contract version. */
  version: string;
}

export type MultisigConfig = CkbMultisig | EvmMultisig;

export interface Treasury extends Identified, Timestamped {
  label: string;
  multisig: MultisigConfig;
  /** Optional human notes — purpose, controlling org, signer rotation policy. */
  notes?: string;
}

export interface PartialSignature {
  /** signer pubkey hash (CKB) or signer address (EVM). */
  signerHash: string;
  bytes: Uint8Array;
  signedAt: number;
}

export type PendingTxState =
  | "draft"
  | "calculated"
  | "pending_approval"
  | "approved"
  | "awaiting_signature"
  | "ready_to_broadcast"
  | "broadcasted"
  | "confirming"
  | "confirmed"
  | "posting"
  | "posted"
  | "post_failed"
  | "failed"
  | "cancelled";

export interface PendingTx extends Identified, Timestamped {
  treasuryId: string;
  chain: ChainId;
  state: PendingTxState;
  /** Sighash digest (CKB) or SafeTx hash (EVM). */
  signingDigest: string;
  /** Outputs for UI preview. */
  outputs: { to: PayeeAddress; amount: { asset: string; value: string; decimals: number } }[];
  /** Adapter-opaque transaction payload (CKB tx skeleton or SafeTx). Serialised string. */
  payloadJson: string;
  signatures: PartialSignature[];
  broadcastedHash?: TransactionHash;
  /** EVM/chain receipt block, stored as decimal text for lossless persistence. */
  confirmedBlockNumber?: string;
  confirmedAt?: Iso8601;
  /** User-reviewed accounting identity and fiat valuation, committed before signing. */
  accounting?: { payeeId: string; fiat: FiatAmount };
  /** Receipt evidence for an EVM execution; all integer values are decimal text. */
  executorAddress?: EvmAddress;
  receiptGasUsed?: string;
  receiptEffectiveGasPriceWei?: string;
  receiptGasFeeWei?: string;
  accountingRecordName?: string;
  journalEntryName?: string;
  postError?: string | undefined;
  failureReason?: string;
}

export interface ApprovalQueueItem {
  pendingTxId: string;
  /** Whether the current user is an authorized signer for this treasury. */
  canSign: boolean;
  /** Signatures collected vs threshold. */
  collected: number;
  threshold: number;
}
