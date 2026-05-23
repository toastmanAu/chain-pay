// Hand-written TypeScript surface for the vendored CEMP-PQ package.
// Covers only the symbols ChainPay's 2.7a integration consumes.

import type { ccc } from "@ckb-ccc/core";

// Flat property names match the runtime object in index.js.
export const ML_DSA_TESTNET: {
  CODE_HASH: string;
  HASH_TYPE: "data" | "type" | "data1" | "data2";
  TX_HASH: string;
  INDEX: number;
};

export const CEMP_PQ_PROFILE_CODE_HASH: string;
export const CEMP_PQ_PROFILE_HASH_TYPE: "data" | "type" | "data1" | "data2";

export function serializeProfile(
  dsaPubKey: Uint8Array,
  kemPubKey: Uint8Array,
  metadata?: Uint8Array,
): Uint8Array;

export function serializeEncryptedMessage(
  kem: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array;

export function serializeMessagePointer(txHash: string, index: number): Uint8Array;

export function ckbBlake2b(data: Uint8Array): Uint8Array;

export class MLDSASigner extends ccc.Signer {
  // Pass a 32-byte seed (keygen is run internally) or a pre-expanded secretKey +
  // publicKey pair. The 2.7a integration always passes a 32-byte seed.
  constructor(client: ccc.Client, seedOrSecretKey: Uint8Array, publicKey?: Uint8Array);
  getAddressObjs(): Promise<ccc.Address[]>;
  getRecommendedAddressObj(): Promise<ccc.Address>;
  isConnected(): Promise<boolean>;
  connect(): Promise<void>;
  prepareTransaction(tx: ccc.Transaction): Promise<ccc.Transaction>;
  signOnlyTransaction(tx: ccc.Transaction): Promise<ccc.Transaction>;
}

export interface ProfileFetchResult {
  mlDsaPubKey: Uint8Array;
  mlKemPubKey: Uint8Array;
  metadata: Uint8Array;
}

export class CEMPTransactionBuilder {
  constructor(client: ccc.Client);
  fetchRecipientProfile(recipientLock: ccc.Script): Promise<ProfileFetchResult | null>;
  buildCreateProfileTx(
    signer: MLDSASigner,
    mlDSAPubKey: Uint8Array,
    mlKEMPubKey: Uint8Array,
    metadata?: string | Uint8Array,
    feeRate?: bigint,
  ): Promise<ccc.Transaction>;
  buildSendMessageTx(
    senderSigner: MLDSASigner,
    recipientLock: ccc.Script,
    // Runtime calls TextEncoder().encode(message) — pass a string for text, NOT Uint8Array.
    // For pre-serialised binary envelopes use CEMPPQ.encrypt + a manual tx instead.
    message: string,
    feeRate?: bigint,
    recipientMLKEMPubKey?: Uint8Array | null,
  ): Promise<ccc.Transaction>;
}

export class CEMPPQ {
  /** Encrypt raw bytes for a recipient: encapsulate KEM, AES-GCM, serialize. */
  static encrypt(message: Uint8Array, recipientPublicKey: Uint8Array): Promise<Uint8Array>;
  /** Decrypt using the recipient's ML-KEM secret key. */
  static decrypt(encryptedData: Uint8Array, recipientSecretKey: Uint8Array): Promise<Uint8Array>;
}
