import type { ChainId } from "@chain-pay/shared";

export type SignerKind = "joyid" | "ledger-ckb" | "ckb-cli-keystore" | "metamask" | "walletconnect" | "ledger-evm";

export interface SignerCapabilities {
  /** Chains this transport can sign for. */
  chains: ChainId[];
  /** Whether the transport requires user confirmation per signature. */
  interactive: boolean;
  /** Whether the transport supports EIP-712 typed data (EVM only). */
  typedData?: boolean;
}

export interface SignRequest {
  chain: ChainId;
  /** Stable signing digest from the unsigned tx, or raw EIP-712 payload for EVM. */
  digest: string;
  /** Adapter-specific metadata the signer needs (multisig_script for CKB, SafeTx for EVM). */
  context?: unknown;
}

export interface Signature {
  /** Public key hash of the signing party. Used for partial-sig de-duplication. */
  signerHash: string;
  /** Raw signature bytes. CKB: 65 bytes (sig + recid). EVM: 65 bytes (r,s,v). */
  bytes: Uint8Array;
}

export interface SignerTransport {
  readonly kind: SignerKind;
  readonly capabilities: SignerCapabilities;
  isAvailable(): Promise<boolean>;
  sign(req: SignRequest): Promise<Signature>;
}
