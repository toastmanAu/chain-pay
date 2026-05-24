import { decodeEnvelope } from "../envelope";
import type {
  CommEnvelopeKind,
  IncomingPacketHandler,
  IncomingSignatureHandler,
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
  pollIntervalMs?: number;
}

export interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  poll(): Promise<void>;
  isRunning(): boolean;
  onIncomingPacket(h: IncomingPacketHandler): Unsubscribe;
  onIncomingSignature(h: IncomingSignatureHandler): Unsubscribe;
}

const DEFAULT_POLL_MS = 5000;

export function createWatcher(deps: WatcherDeps): Watcher {
  const processed = new Set<string>();
  const packetHandlers = new Set<IncomingPacketHandler>();
  const signatureHandlers = new Set<IncomingSignatureHandler>();
  let timer: ReturnType<typeof setInterval> | null = null;

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
      for (const h of packetHandlers) h(senderHashHex, payload as OutgoingPacket);
    } else if (kind === "signature") {
      for (const h of signatureHandlers) h(senderHashHex, payload as OutgoingSignature);
    }
    // ack handling lands in 2.7b
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
  };
}

function hexFromBytes(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
