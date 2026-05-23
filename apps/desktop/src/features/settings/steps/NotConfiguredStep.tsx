interface NotConfiguredStepProps {
  onSetup: () => void | Promise<void>;
  error: Error | null;
}

export function NotConfiguredStep({ onSetup, error }: NotConfiguredStepProps) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        The comm channel is an on-chain encrypted relay for signing coordination. Setting up an
        identity generates a fresh ML-DSA-65 + ML-KEM-768 keypair and prompts you to fund a small
        capacity reserve. Your secret keys never leave this device.
      </p>
      <button
        type="button"
        onClick={() => {
          void onSetup();
        }}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
      >
        Set up comm channel
      </button>
      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          <strong>Setup failed:</strong> {error.message}
        </div>
      )}
    </div>
  );
}
