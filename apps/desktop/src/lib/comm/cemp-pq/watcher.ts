import { decodeEnvelope } from "../envelope";
import { isExpired } from "../expires-at";
import type {
  CommEnvelopeKind,
  IncomingAckHandler,
  IncomingPacketHandler,
  IncomingSignatureHandler,
  OutgoingAck,
  OutgoingPacket,
  OutgoingSignature,
  Unsubscribe,
} from "../types";

interface CellLike {
  outPoint: { txHash: string; index: number };
  outputData: string; // 0x-prefixed hex of MessagePointer
}

interface ScriptLike {
  codeHash: string;
  hashType: "type" | "data" | "data1" | "data2";
  args: string;
}

export interface WatcherDeps {
  ownLock: ScriptLike;
  listCellsForLock(script: ScriptLike): Promise<CellLike[]>;
  decryptIncoming(outPoint: { txHash: string; index: number }): Promise<string>;
  parseMessagePointer(outputDataHex: string): { txHash: string; index: number };
  /**
   * Auto-ack emitter. Called when a non-expired packet is dispatched.
   *
   * Keyed by `senderAddrHash` (0x-prefixed 20-byte hex) — the transport
   * resolves this to a PeerProfile internally (via peer-book / on-chain
   * lookup) before emitting the ack envelope. Errors are caught and logged
   * by the watcher; they must never block packet dispatch.
   *
   * Optional so legacy / non-transport-backed watchers (e.g. in tests for
   * older behavior) keep compiling. When absent, auto-ack is skipped.
   */
  sendAck?(senderAddrHashHex: string, body: OutgoingAck): Promise<unknown>;
  pollIntervalMs?: number;
}

export interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  poll(): Promise<void>;
  isRunning(): boolean;
  onIncomingPacket(h: IncomingPacketHandler): Unsubscribe;
  onIncomingSignature(h: IncomingSignatureHandler): Unsubscribe;
  onIncomingAck(h: IncomingAckHandler): Unsubscribe;
}

const DEFAULT_POLL_MS = 5000;

export function createWatcher(deps: WatcherDeps): Watcher {
  const processed = new Set<string>();
  const packetHandlers = new Set<IncomingPacketHandler>();
  const signatureHandlers = new Set<IncomingSignatureHandler>();
  const ackHandlers = new Set<IncomingAckHandler>();
  let timer: ReturnType<typeof setInterval> | null = null;

  if (!deps.sendAck && process.env["NODE_ENV"] !== "test") {
    // eslint-disable-next-line no-console
    console.warn(
      "[comm] watcher: sendAck dep not wired — auto-ack will be skipped for incoming packets",
    );
  }

  function cellKey(outPoint: { txHash: string; index: number }): string {
    return `${outPoint.txHash}:${outPoint.index}`;
  }

  async function poll(): Promise<void> {
    let cells: CellLike[];
    try {
      cells = await deps.listCellsForLock(deps.ownLock);
    } catch {
      return; // network errors are transient; next tick retries
    }
    for (const cell of cells) {
      const key = cellKey(cell.outPoint);
      if (processed.has(key)) continue;
      processed.add(key);
      try {
        const messagePtr = deps.parseMessagePointer(cell.outputData);
        const envelopeHex = await deps.decryptIncoming(messagePtr);
        const envelopeBytes = Uint8Array.from(Buffer.from(envelopeHex.slice(2), "hex"));
        const decoded = decodeEnvelope(envelopeBytes);
        dispatch(decoded.kind, hexFromBytes(decoded.senderAddrHash), decoded.payload);
      } catch {
        // silently drop — junk/encrypted-to-someone-else/version-mismatch
      }
    }
  }

  function dispatch(kind: CommEnvelopeKind, senderHashHex: string, payload: unknown): void {
    if (kind === "packet") {
      const body = payload as OutgoingPacket;
      // Expired packets are silently dropped: operator's deadline is intent.
      // No handler dispatch, no auto-ack.
      if (isExpired(body.expiresAt)) return;
      for (const h of packetHandlers) h(senderHashHex, body);
      // Auto-ack: fire-and-forget. Failures must not block packet dispatch.
      if (deps.sendAck) {
        void deps.sendAck(senderHashHex, { txHash: body.txHash }).catch(
          (err: unknown) => {
            // eslint-disable-next-line no-console
            console.warn(
              "[comm] auto-ack emission failed",
              { senderHashHex, txHash: body.txHash },
              err,
            );
          },
        );
      }
    } else if (kind === "signature") {
      for (const h of signatureHandlers) h(senderHashHex, payload as OutgoingSignature);
    } else if (kind === "ack") {
      for (const h of ackHandlers) h(senderHashHex, payload as OutgoingAck);
    }
  }

  return {
    isRunning: () => timer !== null,
    async start() {
      if (timer !== null) return;
      await poll();
      timer = setInterval(() => void poll(), deps.pollIntervalMs ?? DEFAULT_POLL_MS);
    },
    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    poll,
    onIncomingPacket(h) {
      packetHandlers.add(h);
      return () => packetHandlers.delete(h);
    },
    onIncomingSignature(h) {
      signatureHandlers.add(h);
      return () => signatureHandlers.delete(h);
    },
    onIncomingAck(h) {
      ackHandlers.add(h);
      return () => ackHandlers.delete(h);
    },
  };
}

function hexFromBytes(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
