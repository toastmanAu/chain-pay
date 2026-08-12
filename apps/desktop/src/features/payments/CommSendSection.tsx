import { useMemo } from "react";
import type { CommSendSlotStatus } from "@chain-pay/shared";
import type { OutgoingPacket } from "@/lib/comm/types";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { usePeerBookStore } from "@/stores/peer-book";
import { useNetworkConfigStore } from "@/stores/network-config";
import { useCommSendDispatch, type MultisigRouting } from "./useCommSendDispatch";

interface CommSendSectionProps {
  batchId: string;
  packet: OutgoingPacket;
  multisig: MultisigRouting;
  /** Optional: when true, the section is read-only (offline / no transport). */
  disabled?: boolean;
  disabledReason?: string;
}

function statusGlyph(status: CommSendSlotStatus["status"] | undefined): string {
  switch (status) {
    case "sending":
      return "…";
    case "sent":
      return "✓";
    case "acked":
      return "✓✓";
    case "error":
      return "⚠";
    default:
      return "○";
  }
}

function shortHash(hash: string): string {
  if (hash.length < 14) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-4)}`;
}

export function CommSendSection({
  batchId,
  packet,
  multisig,
  disabled,
  disabledReason,
}: CommSendSectionProps) {
  const network = useNetworkConfigStore((s) => s.network);
  const { sendAll } = useCommSendDispatch();
  // Subscribe to the batch's commSendStatus directly so pills re-render on writes.
  const batch = usePayrollBatchesStore((s) => s.batches.find((b) => b.id === batchId));
  const peers = usePeerBookStore((s) => s.peers);

  const rows = useMemo(
    () =>
      multisig.pubkeyHashes.map((hash, slotIndex) => {
        const peer = peers.find((p) => p.associatedSignerHash === hash);
        const status = batch?.commSendStatus?.[slotIndex];
        return { slotIndex, hash, peer, status };
      }),
    [multisig.pubkeyHashes, peers, batch?.commSendStatus],
  );

  // On mainnet, replace with a simple fallback message.
  if (network === "mainnet") {
    return (
      <p className="text-xs text-neutral-500 italic">
        Comm channel unavailable; use clipboard.
      </p>
    );
  }

  const mappedCount = rows.filter((r) => r.peer !== undefined).length;
  const canSend = !disabled && mappedCount > 0;

  return (
    <section
      className="space-y-3 rounded-lg border border-surface-hi bg-surface p-5"
      aria-label="Send to signers via comm"
    >
      <header>
        <div className="text-xs uppercase tracking-wide text-fg-muted">Send to signers via comm</div>
        {batch?.sighashDigest && (
          <p className="mt-1 font-mono text-xs text-fg-muted">
            sighash: {shortHash(batch.sighashDigest)}
          </p>
        )}
      </header>

      {disabled && disabledReason && (
        <p role="alert" className="text-sm text-amber-500">
          {disabledReason}
        </p>
      )}

      <ul className="space-y-1">
        {rows.map(({ slotIndex, hash, peer, status }) => {
          const glyph = statusGlyph(status?.status);
          const label = peer
            ? `Slot ${slotIndex} — ${peer.nickname} (${shortHash(hash)})`
            : `Slot ${slotIndex} — ${shortHash(hash)} (no peer mapped)`;
          return (
            <li
              key={slotIndex}
              className="flex items-center justify-between rounded border border-surface-hi bg-surface-lo px-3 py-2 text-sm"
              aria-label={`slot-${slotIndex}`}
            >
              <span>{label}</span>
              <span className="flex items-center gap-3">
                <span
                  data-testid={`pill-${slotIndex}`}
                  className={
                    status?.status === "error"
                      ? "text-red-400"
                      : status?.status === "sent" || status?.status === "acked"
                        ? "text-emerald-400"
                        : "text-fg-muted"
                  }
                >
                  {glyph} {status?.status ?? (peer ? "idle" : "unmapped")}
                </span>
                {(status?.status === "sent" || status?.status === "error") && (
                  <>
                    <button
                      type="button"
                      onClick={() => usePayrollBatchesStore.getState().retryNow(batchId, slotIndex)}
                      className="text-xs px-1.5 py-0.5 rounded border border-neutral-600 hover:bg-neutral-800"
                      title="Reset retry schedule and re-send now"
                    >
                      Retry now
                    </button>
                    <button
                      type="button"
                      onClick={() => usePayrollBatchesStore.getState().dismissRetry(batchId, slotIndex)}
                      className="text-xs px-1 text-neutral-500 hover:text-neutral-300"
                      aria-label="Dismiss retry"
                      title="Stop retrying this signer"
                    >
                      ×
                    </button>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={!canSend}
          onClick={() => void sendAll(batchId, packet, multisig)}
          className="rounded bg-accent px-3 py-1 text-sm text-accent-fg disabled:opacity-50"
        >
          Send packet to mapped signers
        </button>
      </div>
    </section>
  );
}
