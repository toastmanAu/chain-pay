/** 20-byte hex string with 0x prefix, e.g. blake160 hash or EVM address (when normalised lowercase). */
export type Hex20 = `0x${string}`;

/** EVM checksum-cased or lowercase 0x-prefixed address. */
export type EvmAddress = `0x${string}`;

/** CKB encoded address (bech32m, starting ckb1/ckt1). */
export type CkbAddress = string;

/** Generic payee address — adapter-validated. */
export type PayeeAddress = string;

/** Transaction hash, chain-agnostic 0x-prefixed hex. */
export type TransactionHash = `0x${string}`;

/** ISO-8601 UTC timestamp string. */
export type Iso8601 = string;

export interface Identified {
  id: string;
}

export interface Timestamped {
  createdAt: Iso8601;
  updatedAt: Iso8601;
}
