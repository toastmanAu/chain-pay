import { useState } from "react";

interface ReadyStepProps {
  address: string;
  publishedAt: number;
  onDelete: () => void | Promise<void>;
}

export function ReadyStep({ address, publishedAt, onDelete }: ReadyStepProps) {
  const [confirming, setConfirming] = useState(false);

  function copyAddress(): void {
    void navigator.clipboard.writeText(address);
  }

  const publishedLocal = new Date(publishedAt).toLocaleString();

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-surface-hi bg-surface p-4">
        <div className="text-xs uppercase tracking-wide text-accent">Comm channel ready</div>
        <div className="mt-2 break-all font-mono text-xs text-accent">{address}</div>
        <div className="mt-3 text-xs text-fg-muted">Profile published {publishedLocal}</div>
        <button
          type="button"
          onClick={copyAddress}
          className="mt-3 rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs"
        >
          Copy address
        </button>
      </div>
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-md border border-danger/40 bg-danger/5 px-3 py-1 text-xs text-danger"
        >
          Delete identity
        </button>
      ) : (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          <p>
            This will permanently delete your comm-channel identity. The address{" "}
            <span className="font-mono">{address}</span> will become unreachable. Messages already
            sent stay on-chain forever. Continue?
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void onDelete()}
              className="rounded-md bg-danger px-3 py-1 text-xs font-medium text-danger-fg hover:opacity-90"
            >
              Yes, delete
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-surface-hi bg-bg px-3 py-1 text-xs text-fg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
