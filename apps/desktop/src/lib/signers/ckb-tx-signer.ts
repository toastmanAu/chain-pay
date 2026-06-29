import type { Transaction } from "@ckb-ccc/core";

/**
 * Whole-transaction signer for single-sig CKB sends. Distinct from
 * SignerTransport (digest→65 bytes), which serves the multisig partial-sig flow.
 * JoyID signs the entire tx and returns a broadcast-ready Transaction.
 */
export interface CkbTxSigner {
  readonly kind: "joyid";
  connect(): Promise<{ address: string; lockArgs: string }>;
  signTransaction(unsigned: Transaction): Promise<Transaction>;
}
