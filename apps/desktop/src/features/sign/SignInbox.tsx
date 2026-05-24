// apps/desktop/src/features/sign/SignInbox.tsx
import { useMemo } from "react";
import { useIncomingPacketsStore, type IncomingPacketEntry } from "@/stores/incoming-packets";
import { isExpired } from "@/lib/comm/expires-at";
import { InboxRow } from "./sign-inbox-rows/InboxRow";

interface SignInboxProps {
  onClaim: (entry: IncomingPacketEntry) => void;
}

export function SignInbox({ onClaim }: SignInboxProps) {
  const bySighash = useIncomingPacketsStore((s) => s.bySighash);
  const dismiss = useIncomingPacketsStore((s) => s.dismiss);

  const entries = useMemo(() => {
    return Object.values(bySighash)
      .filter((e) => !isExpired(e.packet.expiresAt))
      .sort((a, b) => b.receivedAt - a.receivedAt);
  }, [bySighash]);

  return (
    <section
      className="space-y-3 rounded-lg border border-surface-hi bg-surface p-5"
      aria-label="Sign inbox"
    >
      <header>
        <div className="text-xs uppercase tracking-wide text-fg-muted">Inbox</div>
        <p className="mt-1 text-sm text-fg-muted">
          Comm packets pending your signature.
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="text-sm italic text-fg-muted">
          No comm packets pending. Operators will appear here once they send.
        </p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <InboxRow
              key={e.sighashDigest}
              entry={e}
              onSign={() => onClaim(e)}
              onDismiss={() => dismiss(e.sighashDigest)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
