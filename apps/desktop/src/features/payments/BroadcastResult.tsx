export function BroadcastResult({
  txHash,
  network,
  onReset,
}: {
  txHash: string;
  network: string;
  onReset: () => void;
}) {
  const explorerUrl =
    network === "ckb:mainnet"
      ? `https://explorer.nervos.org/transaction/${txHash}`
      : `https://pudge.explorer.nervos.org/transaction/${txHash}`;
  return (
    <div className="space-y-3 rounded-lg border border-accent/40 bg-accent/5 p-5">
      <div className="text-sm font-medium text-accent">Broadcast successful</div>
      <div className="break-all font-mono text-xs text-fg">{txHash}</div>
      <div className="flex items-center gap-3 text-xs">
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          View on explorer ↗
        </a>
        <button
          type="button"
          onClick={onReset}
          className="rounded-md border border-surface-hi bg-surface px-3 py-1 hover:text-fg"
        >
          Send another
        </button>
      </div>
    </div>
  );
}
