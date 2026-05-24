interface PublishingStepProps {
  address: string;
  error: Error | null;
  onRetry: () => void | Promise<void>;
}

export function PublishingStep({ address, error, onRetry }: PublishingStepProps) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-surface-hi bg-surface p-4">
        <div className="text-xs uppercase tracking-wide text-fg-muted">Publishing profile cell</div>
        <div className="mt-2 break-all font-mono text-xs text-accent">{address}</div>
        {!error && (
          <div className="mt-3 text-sm text-fg-muted">
            Broadcasting to testnet. This usually takes ~10 seconds…
          </div>
        )}
      </div>
      {error && (
        <>
          <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
            <strong>Publish failed:</strong> {error.message}
          </div>
          <button
            type="button"
            onClick={() => void onRetry()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            Retry publish
          </button>
        </>
      )}
    </div>
  );
}
