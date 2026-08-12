import { useEffect, useRef } from "react";
import type { OutgoingPacket } from "@/lib/comm/types";
import type { MultisigRouting } from "./useCommSendDispatch";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { usePeerBookStore } from "@/stores/peer-book";
import { createCommTransport } from "@/lib/comm";

/** Lifecycle-bound backoff. Attempt 0 = initial send (handled by dispatcher).
 *  Attempts 1..3 escalate; from attempt 4 onward we cap at 30 minutes so the
 *  schedule remains responsive when a signer comes back online late. */
export function nextDelayMs(attempt: number): number {
  if (attempt <= 0) return 0;
  if (attempt === 1) return 5 * 60_000;
  if (attempt === 2) return 10 * 60_000;
  if (attempt === 3) return 20 * 60_000;
  return 30 * 60_000;
}

const TERMINAL_BATCH_STATES = new Set([
  "broadcasted", "confirmed", "failed", "cancelled",
  "broadcast_failed",
]);

interface UseCommSendRetryParams {
  packetForBatch: (batchId: string) => OutgoingPacket | null;
  multisigForBatch: (batchId: string) => MultisigRouting | null;
}

/**
 * App-level retry scheduler. Mounted once in App.tsx; survives PayPanel unmount.
 *
 * Subscribes to payroll-batches commSendStatus changes. For each (batchId,
 * slotIndex) entry whose status === "sent", schedules a re-send at the
 * lifecycle-bound delay from updatedAt (or persisted nextRetryAt if present).
 * Stops when batch reaches a terminal state, expiresAt passes, or
 * slot.dismissed is true.
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
          if (slotStatus.dismissed) continue;
          if (TERMINAL_BATCH_STATES.has(b.state)) continue;
          if (b.expiresAt !== undefined && Date.now() > b.expiresAt) continue;

          const count = slotStatus.retryCount ?? 0;
          const targetDelay = nextDelayMs(count + 1);

          // Restart-safe: prefer persisted nextRetryAt if present.
          const remaining =
            slotStatus.nextRetryAt !== undefined
              ? Math.max(0, slotStatus.nextRetryAt - Date.now())
              : Math.max(0, targetDelay - (Date.now() - slotStatus.updatedAt));

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
      // Persist nextRetryAt for restart-safe scheduling.
      const next = Date.now() + nextDelayMs(nextCount + 1);
      rec(batchId, slotIndex, "sent", { retryCount: nextCount, nextRetryAt: next });

      const transport = createCommTransport();
      if (!transport) {
        rec(batchId, slotIndex, "error", { error: "comm channel not started" });
        return;
      }

      try {
        const profile = peer.cachedProfile ?? (await transport.resolveProfile(peer.address));
        const txHash = await transport.sendPacket(profile, packet);
        rec(batchId, slotIndex, "sent", { txHash, retryCount: nextCount, nextRetryAt: next });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        rec(batchId, slotIndex, "error", { error });
      }
    }

    scheduleAll();
    const unsub = usePayrollBatchesStore.subscribe(scheduleAll);

    return () => {
      unsub();
      // The lint rule guards against a ref whose `.current` is REASSIGNED between
      // effect setup and cleanup, leaving the cleanup holding a stale value. That
      // cannot happen here: `timersRef.current` is the one Map allocated by
      // useRef, never reassigned — scheduleAll only mutates it in place via
      // set/delete. Reading it live and capturing it into a local at setup would
      // therefore be equivalent, so the warning is a false positive and clearing
      // the live map is correct.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, [packetForBatch, multisigForBatch]);
}
