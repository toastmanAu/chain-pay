// apps/desktop/src/features/sign/sign-inbox-rows/InboxRow.tsx
import type { IncomingPacketEntry } from "@/stores/incoming-packets";
import { usePeerBookStore } from "@/stores/peer-book";

interface InboxRowProps {
  entry: IncomingPacketEntry;
  onSign: () => void;
  onDismiss: () => void;
}

function shortSighash(hash: string): string {
  if (hash.length < 14) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-4)}`;
}

function expiresLabel(epochSec: number | undefined): string {
  if (!epochSec || epochSec <= 0) return "no expiry";
  const ms = epochSec * 1000 - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `expires in ${mins}m`;
  const hours = Math.round(mins / 60);
  return `expires in ${hours}h`;
}

export function InboxRow({ entry, onSign, onDismiss }: InboxRowProps) {
  const peer = usePeerBookStore((s) =>
    s.peers.find((p) => p.addrHash === entry.senderAddrHash),
  );
  const senderLabel = peer?.nickname ?? `unknown sender ${shortSighash(entry.senderAddrHash)}`;

  return (
    <li className="space-y-1 rounded border border-surface-hi bg-surface-lo p-3" data-testid={`inbox-row-${entry.sighashDigest}`}>
      <div className="font-medium">{senderLabel}</div>
      <div className="font-mono text-xs text-fg-muted">{shortSighash(entry.sighashDigest)}</div>
      <div className="text-xs text-fg-muted">{expiresLabel(entry.packet.expiresAt)}</div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="rounded px-2 py-0.5 text-xs text-fg-muted hover:text-fg"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={onSign}
          className="rounded bg-accent px-2 py-0.5 text-xs text-accent-fg"
        >
          Sign
        </button>
      </div>
    </li>
  );
}
