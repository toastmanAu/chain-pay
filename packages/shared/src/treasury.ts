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

export type BitcoinChain = "btc:mainnet" | "btc:testnet";

export type BitcoinAddressScriptType = "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr";
export type BitcoinDerivedScriptType = "p2pkh" | "p2sh-p2wpkh" | "p2wpkh" | "p2tr";

export interface BitcoinAddressWatchSource {
  kind: "address";
  /** Canonical network-specific address. */
  address: string;
  scriptType: BitcoinAddressScriptType;
}

export interface BitcoinDescriptorWatchSource {
  kind: "descriptor";
  /** Canonical descriptor including its BIP-380 checksum. */
  descriptor: string;
  scriptType: BitcoinDerivedScriptType;
  /** Public extended key only. Private extended keys are never accepted or persisted. */
  extendedPublicKey: string;
  /** Non-hardened path components applied after the imported extended public key. */
  derivationPath: number[];
  /** Optional BIP-380 key origin, without square brackets. */
  keyOrigin?: string;
}

export type BitcoinWatchSource = BitcoinAddressWatchSource | BitcoinDescriptorWatchSource;

export interface BitcoinWatchConfig {
  chain: BitcoinChain;
  source: BitcoinWatchSource;
  /** Consecutive unused derived addresses that terminate a discovery scan. */
  gapLimit: number;
}

export interface BitcoinWatchSyncState {
  treasuryId: string;
  status: "idle" | "syncing" | "ready" | "error";
  nextReceiveIndex: number;
  /** Next derived index to inspect when resuming an interrupted discovery pass. */
  nextScanIndex: number;
  lastUsedIndex: number | null;
  scannedThrough: number;
  consecutiveUnused: number;
  tipHeight: number | null;
  tipHash: string | null;
  lastSyncedAt: Iso8601 | null;
  error: string | null;
  snapshot: BitcoinWatchSnapshot | null;
}

/** Decimal integer text is used at persistence and IPC boundaries to preserve exact satoshis. */
export type BitcoinSatoshiText = string;

export interface BitcoinWatchUtxo {
  txid: string;
  vout: number;
  address: string;
  valueSats: BitcoinSatoshiText;
  confirmed: boolean;
  blockHeight: number | null;
  blockHash: string | null;
  confirmations: number;
}

export interface BitcoinWatchTransaction {
  txid: string;
  /** Net value across all watched inputs and outputs; may be negative. */
  netValueSats: BitcoinSatoshiText;
  confirmed: boolean;
  blockHeight: number | null;
  blockHash: string | null;
  blockTime: number | null;
  confirmations: number;
}

export interface BitcoinWatchSnapshot {
  tipHeight: number;
  tipHash: string;
  balanceSats: BitcoinSatoshiText;
  addresses: string[];
  utxos: BitcoinWatchUtxo[];
  transactions: BitcoinWatchTransaction[];
}

export type SolanaChain = "sol:mainnet" | "sol:devnet";
export type SolanaLamportText = string;
export type SolanaSlotText = string;

export interface SolanaWatchConfig {
  chain: SolanaChain;
  /** Canonical base58 encoding of exactly one 32-byte public key. */
  address: string;
}

export interface SolanaPaymentConfig {
  /** Existing initialized System Program nonce account. */
  nonceAccount: string;
  /** Single authority decoded from the nonce account; this is not an M-of-N policy. */
  nonceAuthority: string;
  /** External public key that pays the transaction fee. */
  feePayer: string;
}

export type SolanaTransactionState = "processed" | "confirmed" | "finalized" | "failed" | "unknown";

export interface SolanaWatchTransaction {
  signature: string;
  slot: SolanaSlotText;
  blockTime: number | null;
  state: SolanaTransactionState;
  /** Exact watched-account balance delta, or null when transaction details are unavailable. */
  netLamports: SolanaLamportText | null;
  /** Whole transaction fee; ownership is described separately. */
  feeLamports: SolanaLamportText | null;
  feePaidByWatched: boolean | null;
}

export interface SolanaWatchSnapshot {
  address: string;
  slot: SolanaSlotText;
  blockhash: string;
  lastValidBlockHeight: SolanaSlotText;
  balanceLamports: SolanaLamportText;
  transactions: SolanaWatchTransaction[];
  /** Oldest fetched signature; persisted so bounded history can resume safely. */
  historyCursor: string | null;
  historyTruncated: boolean;
}

export interface SolanaWatchSyncState {
  treasuryId: string;
  status: "idle" | "syncing" | "ready" | "error";
  slot: SolanaSlotText | null;
  blockhash: string | null;
  lastSyncedAt: Iso8601 | null;
  error: string | null;
  rollbackDetected: boolean;
  rollbackSignatures: string[];
  snapshot: SolanaWatchSnapshot | null;
}

interface TreasuryBase extends Identified, Timestamped {
  label: string;
  /** Optional human notes — purpose, controlling org, signer rotation policy. */
  notes?: string;
}

/** Existing CKB and EVM treasury shape. `kind` is optional for persisted v1/v2 compatibility. */
export interface MultisigTreasury extends TreasuryBase {
  kind?: "multisig";
  multisig: MultisigConfig;
}

export interface BitcoinWatchTreasury extends TreasuryBase {
  kind: "bitcoin-watch";
  watch: BitcoinWatchConfig;
}

export interface SolanaWatchTreasury extends TreasuryBase {
  kind: "solana-watch";
  watch: SolanaWatchConfig;
  payment?: SolanaPaymentConfig;
}

export type Treasury = MultisigTreasury | BitcoinWatchTreasury | SolanaWatchTreasury;

export function isMultisigTreasury(treasury: Treasury): treasury is MultisigTreasury {
  return "multisig" in treasury;
}

export function isBitcoinWatchTreasury(treasury: Treasury): treasury is BitcoinWatchTreasury {
  return "watch" in treasury && treasury.kind === "bitcoin-watch";
}

export function isSolanaWatchTreasury(treasury: Treasury): treasury is SolanaWatchTreasury {
  return "watch" in treasury && treasury.kind === "solana-watch";
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
