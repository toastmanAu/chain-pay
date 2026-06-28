import type { Transaction } from "@ckb-ccc/core";
import type { SignPreview } from "./joyid-relay/types";

/**
 * Whole-transaction signer for single-sig CKB sends. Distinct from
 * SignerTransport (digest→65 bytes), which serves the multisig partial-sig flow.
 * JoyID signs the entire tx and returns a broadcast-ready Transaction.
 */
export interface CkbTxSigner {
  readonly kind: "joyid" | "local-keystore";
  connect(): Promise<{ address: string; lockArgs: string }>;
  /**
   * @param preview human-readable recipient/amount/fee shown to the approver on
   *   the signing device. Optional so non-interactive callers can omit it.
   */
  signTransaction(unsigned: Transaction, preview?: SignPreview): Promise<Transaction>;
}
