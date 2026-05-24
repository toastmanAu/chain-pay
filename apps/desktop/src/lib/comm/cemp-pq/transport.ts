import { encodeEnvelope } from "../envelope";
import type {
  CommTransport,
  IncomingAckHandler,
  IncomingPacketHandler,
  IncomingSignatureHandler,
  OutgoingAck,
  OutgoingPacket,
  OutgoingSignature,
  PeerProfile,
  Unsubscribe,
} from "../types";
import { ProfileNotFoundError } from "../errors";
import { usePeerBookStore } from "../../../stores/peer-book";
import { createWatcher, type Watcher } from "./watcher";

interface ScriptLike {
  codeHash: string;
  hashType: "type" | "data" | "data1" | "data2";
  args: string;
}

export interface TransportDeps {
  getOwnLock(): Promise<ScriptLike>;
  getOwnAddrHash(): Promise<Uint8Array>;
  /** Resolves to the block number of the install's Profile Cell publish tx, or null if not published. */
  getProfilePublishBlock(): Promise<bigint | null>;
  ipc: {
    publishProfile(metadata: { displayName?: string }): Promise<{ txHash: string; txBytes: string }>;
    sendMessage(recipientAddress: string, envelopeBytesHex: string): Promise<{ txHash: string; txBytes: string }>;
    decryptIncoming(outPoint: { txHash: string; index: number }): Promise<string>;
    resolveProfile(address: string): Promise<{ address: string; mlDsaPubKey: string; mlKemPubKey: string; metadata: string }>;
  };
  broadcastTransaction(txBytesHex: string): Promise<string>;
  watchLockScript(script: ScriptLike, fromBlock: bigint): Promise<void>;
  listCellsForLock(script: ScriptLike): Promise<{ outPoint: { txHash: string; index: number }; outputData: string }[]>;
  parseMessagePointer(outputDataHex: string): { txHash: string; index: number };
}

const PROFILE_CACHE_TTL_MS = 60 * 60 * 1000;

export class CempPqCommTransport implements CommTransport {
  private watcher: Watcher | null = null;
  private readonly profileCache = new Map<string, { profile: PeerProfile; expiresAt: number }>();

  constructor(private readonly deps: TransportDeps) {}

  async start(): Promise<void> {
    if (this.watcher) return;
    const publishBlock = await this.deps.getProfilePublishBlock();
    if (publishBlock === null) {
      throw new Error("cannot start transport: no Profile Cell published yet");
    }
    const ownLock = await this.deps.getOwnLock();
    await this.deps.watchLockScript(ownLock, publishBlock);
    this.watcher = createWatcher({
      ownLock,
      listCellsForLock: this.deps.listCellsForLock,
      decryptIncoming: this.deps.ipc.decryptIncoming,
      parseMessagePointer: this.deps.parseMessagePointer,
      sendAck: async (senderAddrHashHex, body) => {
        // The watcher hands us the raw addrHash from the incoming envelope.
        // To send the ack we need a PeerProfile (address + ML-KEM key).
        // Resolution order:
        //   1. peer-book lookup by addrHash (fast, no chain hit)
        //   2. cached profile if present, else on-chain resolveProfile(address)
        // If no peer mapping exists, the sender is a stranger — skip the ack.
        const peer = usePeerBookStore
          .getState()
          .findByAddrHash(senderAddrHashHex as `0x${string}`);
        if (!peer) return;
        const profile = peer.cachedProfile ?? (await this.resolveProfile(peer.address));
        await this.sendAck(profile, body);
      },
    });
    await this.watcher.start();
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.stop();
    this.watcher = null;
  }

  isRunning(): boolean {
    return this.watcher !== null;
  }

  async publishProfile(metadata: { displayName?: string } = {}): Promise<string> {
    const { txHash, txBytes } = await this.deps.ipc.publishProfile(metadata);
    await this.deps.broadcastTransaction(txBytes);
    return txHash;
  }

  async resolveProfile(address: string): Promise<PeerProfile> {
    const cached = this.profileCache.get(address);
    if (cached && cached.expiresAt > Date.now()) return cached.profile;
    let result;
    try {
      result = await this.deps.ipc.resolveProfile(address);
    } catch (cause) {
      throw new ProfileNotFoundError(address, { cause });
    }
    const parsed = result.metadata ? safeParseMetadata(result.metadata) : undefined;
    const profile: PeerProfile = {
      address: result.address,
      mlDsaPubKey: hexToBytes(result.mlDsaPubKey),
      mlKemPubKey: hexToBytes(result.mlKemPubKey),
      ...(parsed !== undefined ? { metadata: parsed } : {}),
      fetchedAt: Date.now(),
    };
    this.profileCache.set(address, { profile, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS });
    return profile;
  }

  async sendPacket(peer: PeerProfile, body: OutgoingPacket): Promise<string> {
    return this.sendEnvelope(peer, "packet", body);
  }

  async sendSignature(peer: PeerProfile, body: OutgoingSignature): Promise<string> {
    return this.sendEnvelope(peer, "signature", body);
  }

  async sendAck(peer: PeerProfile, body: OutgoingAck): Promise<string> {
    return this.sendEnvelope(peer, "ack", body);
  }

  private async sendEnvelope(peer: PeerProfile, kind: "packet" | "signature" | "ack", payload: unknown): Promise<string> {
    const senderAddrHash = await this.deps.getOwnAddrHash();
    const envelope = encodeEnvelope({ kind, senderAddrHash, payload });
    const envelopeHex = "0x" + Buffer.from(envelope).toString("hex");
    const { txHash, txBytes } = await this.deps.ipc.sendMessage(peer.address, envelopeHex);
    await this.deps.broadcastTransaction(txBytes);
    return txHash;
  }

  onIncomingPacket(h: IncomingPacketHandler): Unsubscribe {
    if (!this.watcher) throw new Error("transport not started");
    return this.watcher.onIncomingPacket(h);
  }

  onIncomingSignature(h: IncomingSignatureHandler): Unsubscribe {
    if (!this.watcher) throw new Error("transport not started");
    return this.watcher.onIncomingSignature(h);
  }

  onIncomingAck(h: IncomingAckHandler): Unsubscribe {
    if (!this.watcher) throw new Error("transport not started");
    return this.watcher.onIncomingAck(h);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function safeParseMetadata(raw: string): { displayName?: string } | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.displayName === "string") return { displayName: parsed.displayName };
  } catch {
    /* fall through */
  }
  return undefined;
}
