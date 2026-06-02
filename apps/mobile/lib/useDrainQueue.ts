import { useEffect, useRef } from "react";
import NetInfo from "@react-native-community/netinfo";
import { File, Paths } from "expo-file-system";
import { Buffer } from "buffer";
import { IMAGE_CHUNK_BYTES, type MobileInvoicePayload } from "@chain-pay/shared";
import { useSyncQueue, backoffMs, type QueueItem } from "@/stores/sync-queue";
import { usePairingStore } from "@/stores/pairing";
import { runDrainOnce } from "@/lib/transport";

async function buildPayload(item: QueueItem): Promise<MobileInvoicePayload> {
  const file = new File(Paths.cache, item.imageRef);
  const b64 = await file.base64();
  const buf = Buffer.from(b64, "base64");
  const chunks: string[] = [];
  for (let off = 0; off < buf.length; off += IMAGE_CHUNK_BYTES) {
    chunks.push(buf.subarray(off, off + IMAGE_CHUNK_BYTES).toString("base64"));
  }
  return {
    id: item.id,
    capturedAt: item.capturedAt,
    extraction: item.extraction,
    image_chunks: chunks,
    image_mime: "image/jpeg",
  };
}

export function useDrainQueue(): void {
  const items = useSyncQueue((s) => s.items);
  const pairing = usePairingStore((s) => s.pairing);
  const queue = useSyncQueue;
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
