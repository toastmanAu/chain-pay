import { useEffect, useRef } from "react";
import NetInfo from "@react-native-community/netinfo";
import { File, Directory, Paths } from "expo-file-system";
import { Buffer } from "buffer";
import { IMAGE_CHUNK_BYTES, type MobileInvoicePayload } from "@chain-pay/shared";
import { useSyncQueue, backoffMs, type QueueItem } from "@/stores/sync-queue";
import { usePairingStore } from "@/stores/pairing";
import { runDrainOnce } from "@/lib/transport";

const IMAGE_CACHE_RETENTION_MS = 24 * 3600 * 1000;
const IMAGE_CACHE_LIMIT_BYTES = 500 * 1024 * 1024;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

async function buildPayload(item: QueueItem): Promise<MobileInvoicePayload> {
  const file = new File(Paths.cache, item.imageRef);
  const b64 = await file.base64();
  const buf = Buffer.from(b64, "base64");
  const chunks: string[] = [];
  for (let off = 0; off < buf.length; off += IMAGE_CHUNK_BYTES) {
    // RN's `buffer` polyfill returns a Uint8Array from `subarray`, not a Buffer,
    // so .toString("base64") silently falls through to Uint8Array.toString()
    // which returns comma-joined decimal byte values. Wrap in Buffer.from to fix.
    chunks.push(Buffer.from(buf.subarray(off, off + IMAGE_CHUNK_BYTES)).toString("base64"));
  }
  return {
    id: item.id,
    capturedAt: item.capturedAt,
    extraction: item.extraction,
    image_chunks: chunks,
    image_mime: "image/jpeg",
  };
}

export function deleteImagesFromCache(filenames: string[]): void {
  for (const name of filenames) {
    try {
      new File(Paths.cache, name).delete();
    } catch {
      // Best-effort; missing files are fine.
    }
  }
}

function cacheBytes(): number {
  try {
    const info = new Directory(Paths.cache).info();
    return info.size ?? 0;
  } catch {
    return 0;
  }
}

export function useDrainQueue(): void {
  const items = useSyncQueue((s) => s.items);
  const pairing = usePairingStore((s) => s.pairing);
  const queue = useSyncQueue;
  const pairingStore = usePairingStore;
  const running = useRef(false);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    void NetInfo.fetch().then(() => {
      unsub = NetInfo.addEventListener(() => {
        void tick();
      });
    });
    return () => {
      if (unsub) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void tick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, pairing?.auth_token]);

  // Periodic + capacity-driven cache purge.
  useEffect(() => {
    const purge = (): void => {
      const refs = queue.getState().removeSynced(IMAGE_CACHE_RETENTION_MS);
      deleteImagesFromCache(refs);
      if (cacheBytes() > IMAGE_CACHE_LIMIT_BYTES) {
        // Force-evict everything else that's synced regardless of age.
        const allSynced = queue.getState().items.filter((i) => i.status === "synced");
        if (allSynced.length > 0) {
          const moreRefs = queue.getState().removeSynced(0);
          deleteImagesFromCache(moreRefs);
        }
      }
    };
    purge();
    const id = setInterval(purge, PURGE_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function tick(): Promise<void> {
    if (running.current || !pairing) return;
    const item = queue.getState().nextDrainCandidate();
    if (!item) return;
    running.current = true;
    queue.getState().markSyncing(item.id);
    try {
      const outcome = await runDrainOnce({ item, pairing, buildPayload });
      if (outcome.kind === "synced") {
        queue.getState().markSynced(item.id, outcome.invoiceId);
      } else if (outcome.kind === "rejected") {
        queue.getState().markRejected(item.id, outcome.error);
      } else if (outcome.kind === "unauthorized") {
        queue.getState().markRejected(item.id, "unauthorized - re-pair required");
      } else if (outcome.kind === "tls-mismatch") {
        queue.getState().markRejected(item.id, "tls-mismatch - re-pair required");
        await pairingStore.getState().clearPairing("tls-mismatch");
      } else {
        queue.getState().markFailed(item.id, outcome.error);
      }
    } finally {
      running.current = false;
      setTimeout(() => {
        void tick();
      }, backoffMs(item.attempts));
    }
  }
}
