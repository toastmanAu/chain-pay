import { useEffect, useRef } from "react";
import type { OutgoingPacket } from "@/lib/comm/types";
import type { MultisigRouting } from "./useCommSendDispatch";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { usePeerBookStore } from "@/stores/peer-book";
import { createCommTransport } from "@/lib/comm";

const RETRY_SCHEDULE_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000] as const;
const RETRY_CAP = 3;

interface UseCommSendRetryParams {
  packetForBatch: (batchId: string) => OutgoingPacket | null;
  multisigForBatch: (batchId: string) => MultisigRouting | null;
}

/**
 * App-level retry scheduler. Mounted once in App.tsx; survives PayPanel unmount.
 *
 * Subscribes to payroll-batches commSendStatus changes. For each (batchId,
 * slotIndex) entry whose status === "sent" and retryCount < RETRY_CAP,
 * schedules a re-send at the appropriate exponential delay from updatedAt.
 * Cancels timers when status leaves "sent" or retryCount caps.
 *
 * Callers MUST memoize `packetForBatch` and `multisigForBatch` (e.g., with
 * useCallback) to avoid thrashing the subscription on every render.
 */
export function useCommSendRetry({
  packetForBatch,
  multisigForBatch,
}: UseCommSendRetryParams): void {
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    function scheduleAll(): void {
      const state = usePayrollBatchesStore.getState();
      for (const b of state.batches) {
        const status = b.commSendStatus;
        if (!status) continue;
        for (const [slot, slotStatus] of Object.entries(status)) {
          const key = `${b.id}:${slot}`;
          const existing = timersRef.current.get(key);
          if (existing) clearTimeout(existing);
          timersRef.current.delete(key);

          if (slotStatus.status !== "sent") continue;
          const count = slotStatus.retryCount ?? 0;
          if (count >= RETRY_CAP) continue;

          const nextDelay = RETRY_SCHEDULE_MS[count];
          if (nextDelay === undefined) continue;
          const elapsed = Date.now() - slotStatus.updatedAt;
          const remaining = Math.max(0, nextDelay - elapsed);

          const timer = setTimeout(() => {
            void fireRetry(b.id, Number(slot), count + 1);
            timersRef.current.delete(key);
          }, remaining);
          timersRef.current.set(key, timer);
        }
      }
    }

    async function fireRetry(batchId: string, slotIndex: number, nextCount: number): Promise<void> {
      const packet = packetForBatch(batchId);
      const multisig = multisigForBatch(batchId);
      if (!packet || !multisig) return;

      const hash = multisig.pubkeyHashes[slotIndex];
      if (!hash) return;
      const peer = usePeerBookStore.getState().findByAssociatedSignerHash(hash);
      const rec = usePayrollBatchesStore.getState().recordCommSendStatus;
      if (!peer) {
        rec(batchId, slotIndex, "error", { error: `no peer mapped to signer ${hash}` });
        return;
      }

      // Bump retryCount BEFORE the send so a successful send doesn't lose it.
      rec(batchId, slotIndex, "sent", { retryCount: nextCount });

      const transport = createCommTransport();
      if (!transport) {
        rec(batchId, slotIndex, "error", { error: "comm channel not started" });
        return;
      }

      try {
        const profile = peer.cachedProfile ?? (await transport.resolveProfile(peer.address));
        const txHash = await transport.sendPacket(profile, packet);
        rec(batchId, slotIndex, "sent", { txHash, retryCount: nextCount });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        rec(batchId, slotIndex, "error", { error });
      }
    }

    scheduleAll();
    const unsub = usePayrollBatchesStore.subscribe(scheduleAll);

    return () => {
      unsub();
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, [packetForBatch, multisigForBatch]);
}
