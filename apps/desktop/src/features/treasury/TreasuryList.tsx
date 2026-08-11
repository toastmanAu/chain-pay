import { Link } from "react-router-dom";
import { isBitcoinWatchTreasury, isSolanaWatchTreasury, type CkbMultisig, type Treasury } from "@chain-pay/shared";
import { useTreasuryStore } from "@/stores/treasury";
import { chainBadge } from "@/lib/format/chain-badge";

export function TreasuryList() {
  const treasuries = useTreasuryStore((s) => s.treasuries);
  const removeTreasury = useTreasuryStore((s) => s.removeTreasury);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Treasury</h1>
          <p className="text-sm text-fg-muted">Multisig wallets for payroll funding.</p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/treasury/new/solana"
            className="rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent hover:bg-accent/10"
          >
            Add Solana watch
          </Link>
          <Link
            to="/treasury/new/bitcoin"
            className="rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent hover:bg-accent/10"
          >
            Add Bitcoin watch
          </Link>
          <Link
            to="/treasury/new/safe"
            className="rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent hover:bg-accent/10"
          >
            Add Sepolia Safe
          </Link>
          <Link
            to="/treasury/new"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            New CKB multisig
          </Link>
        </div>
      </div>

      {treasuries.length === 0 ? (
        <div className="rounded-lg border border-surface-hi bg-surface p-6 text-sm text-fg-muted">
          No treasuries yet. Create a CKB or EVM multisig, or add a Bitcoin or Solana watch-only treasury.
        </div>
      ) : (
        <ul className="space-y-2">
          {treasuries.map((t) => (
            <TreasuryRow key={t.id} treasury={t} onDelete={() => removeTreasury(t.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TreasuryRow({ treasury, onDelete }: { treasury: Treasury; onDelete: () => void }) {
  if (isBitcoinWatchTreasury(treasury)) {
    const source = treasury.watch.source;
    return (
      <li className="rounded-lg border border-surface-hi bg-surface transition-colors hover:border-surface-hi/80">
        <div className="flex items-start justify-between gap-4 p-4">
          <Link to={`/treasury/${treasury.id}`} className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-fg hover:text-accent">{treasury.label}</span>
              <span className="rounded-md bg-surface-hi px-2 py-0.5 text-xs text-fg-muted">
                {chainBadge(treasury.watch.chain)}
              </span>
              <span className="text-xs text-fg-muted">watch-only · {source.scriptType}</span>
            </div>
            <div className="mt-1 truncate font-mono text-xs text-fg-muted">
              {source.kind === "address" ? source.address : source.descriptor}
            </div>
          </Link>
          <button
            type="button"
            onClick={onDelete}
            className="shrink-0 rounded-md border border-surface-hi px-2 py-1 text-xs text-fg-muted hover:border-danger hover:text-danger"
          >
            Remove
          </button>
        </div>
      </li>
    );
  }
  if (isSolanaWatchTreasury(treasury)) {
    return (
      <li className="rounded-lg border border-surface-hi bg-surface transition-colors hover:border-surface-hi/80">
        <div className="flex items-start justify-between gap-4 p-4">
          <Link to={`/treasury/${treasury.id}`} className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-fg hover:text-accent">{treasury.label}</span>
              <span className="rounded-md bg-surface-hi px-2 py-0.5 text-xs text-fg-muted">{chainBadge(treasury.watch.chain)}</span>
              <span className="text-xs text-fg-muted">watch-only</span>
            </div>
            <div className="mt-1 truncate font-mono text-xs text-fg-muted">{treasury.watch.address}</div>
          </Link>
          <button type="button" onClick={onDelete} className="shrink-0 rounded-md border border-surface-hi px-2 py-1 text-xs text-fg-muted hover:border-danger hover:text-danger">
            Remove
          </button>
        </div>
      </li>
    );
  }
  const m = treasury.multisig;
  const chainLabel = chainBadge(m.chain);
  const summary =
    "owners" in m
      ? `${m.threshold}-of-${m.owners.length}`
      : `${(m as CkbMultisig).m}-of-${(m as CkbMultisig).n}`;

  return (
    <li className="rounded-lg border border-surface-hi bg-surface transition-colors hover:border-surface-hi/80">
      <div className="flex items-start justify-between gap-4 p-4">
        <Link to={`/treasury/${treasury.id}`} className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg hover:text-accent">{treasury.label}</span>
            <span className="rounded-md bg-surface-hi px-2 py-0.5 text-xs text-fg-muted">{chainLabel}</span>
            <span className="text-xs text-fg-muted tabular-nums">{summary}</span>
          </div>
          <div className="mt-1 break-all font-mono text-xs text-fg-muted">{m.address}</div>
        </Link>
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 rounded-md border border-surface-hi px-2 py-1 text-xs text-fg-muted hover:border-danger hover:text-danger"
        >
          Remove
        </button>
      </div>
    </li>
  );
}
