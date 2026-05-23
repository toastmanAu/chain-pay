import type { TransferPacket } from "@chain-pay/shared";

export interface PeerProfile {
  /** ckb-mldsa-lock address (ckt1q… on testnet, ckb1q… on mainnet). */
  address: string;
  /** 1952 bytes. */
  mlDsaPubKey: Uint8Array;
  /** 1184 bytes. */
  mlKemPubKey: Uint8Array;
  metadata?: { displayName?: string };
  /** epoch ms when this profile was last fetched. */
  fetchedAt: number;
}

export interface OutgoingPacket {
  /** Operator's batch id this packet relates to (becomes the multisig tx hash). */
  txHash: string;
  treasuryAddress: string;
  /** Epoch s. Receivers reject after this. */
  expiresAt: number;
  packet: TransferPacket;
}

export interface OutgoingSignature {
  /** Matches OutgoingPacket.txHash. */
  txHash: string;
  /** Signer slot in the multisig. */
  slotIndex: number;
  /** 0x-prefixed secp65 hex. */
  signature: string;
}

export type CommEnvelopeKind = "packet" | "signature" | "ack";

export interface IncomingPacketHandler {
  (from: string, body: OutgoingPacket): void;
}

export interface IncomingSignatureHandler {
  (from: string, body: OutgoingSignature): void;
}

export type Unsubscribe = () => void;

export interface CommTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;

  publishProfile(metadata?: { displayName?: string }): Promise<string>;
  resolveProfile(address: string): Promise<PeerProfile>;

  sendPacket(peer: PeerProfile, body: OutgoingPacket): Promise<string>;
  sendSignature(peer: PeerProfile, body: OutgoingSignature): Promise<string>;

  onIncomingPacket(handler: IncomingPacketHandler): Unsubscribe;
  onIncomingSignature(handler: IncomingSignatureHandler): Unsubscribe;
}

/** The 1-byte tag preceding the envelope kind in the encrypted payload. */
export const ENVELOPE_VERSION = 0x01 as const;
