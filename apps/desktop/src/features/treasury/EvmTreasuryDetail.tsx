import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { EvmMultisig, MultisigTreasury } from "@chain-pay/shared";
import { Tile } from "@/components/ui/Tile";
import { formatEth } from "@/lib/format/evm";
import { formatBlockNumber } from "@/lib/format/block";
import { secondsAgo } from "@/lib/format/time";
import { readSafeSnapshot } from "@/lib/chains/evm/safe-reader";

export function EvmTreasuryDetail({ treasury }: { treasury: MultisigTreasury }) {
  const multisig = treasury.multisig as EvmMultisig;
  const chainId = Number(multisig.chain.slice("evm:".length));
  const safeQuery = useQuery({
    queryKey: ["safe-snapshot", chainId, multisig.address],
    queryFn: () => readSafeSnapshot(chainId, multisig.address),
    refetchInterval: 12_000,
  });
  const snapshot = safeQuery.data;
  const owners = snapshot?.owners ?? multisig.owners;
  const threshold = snapshot?.threshold ?? multisig.threshold;
  const configChanged =
    snapshot !== undefined &&
    (snapshot.threshold !== multisig.threshold ||
      snapshot.version !== multisig.version ||
      snapshot.owners.map((owner) => owner.toLowerCase()).join(",") !==
        multisig.owners.map((owner) => owner.toLowerCase()).join(","));

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link to="/treasury" className="text-xs text-fg-muted hover:text-fg">
            ← Treasury
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{treasury.label}</h1>
          <p className="text-sm text-fg-muted">
            Sepolia · {threshold}-of-{owners.length} Safe · v{snapshot?.version ?? multisig.version}
          </p>
        </div>
        <Link
          to={`/treasury/${treasury.id}/payment/new`}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
        >
          New payment
        </Link>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Tile
          label="Balance"
          value={snapshot ? `${formatEth(snapshot.balanceWei)} ETH` : safeQuery.isLoading ? "…" : "—"}
          hint={
            safeQuery.dataUpdatedAt
              ? `updated ${secondsAgo(safeQuery.dataUpdatedAt)}s ago`
              : "reading Sepolia…"
          }
          tone="accent"
        />
        <Tile label="Safe threshold" value={`${threshold} / ${owners.length}`} hint="owners required" />
        <Tile
          label="Block"
          value={snapshot ? formatBlockNumber(snapshot.blockNumber) : "—"}
          hint="Sepolia RPC tip"
        />
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Safe contract</h2>
        <div className="mt-2 break-all font-mono text-xs text-accent">{multisig.address}</div>
        <p className="mt-3 text-xs text-fg-muted">
          Read-only monitoring is live. Safe transaction creation and owner signing land in the
          next slice.
        </p>
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Owners</h2>
        <ul className="mt-3 space-y-1">
          {owners.map((owner, index) => (
            <li key={owner} className="flex items-baseline gap-3 text-xs">
              <span className="w-6 text-fg-muted tabular-nums">{index + 1}.</span>
              <span className="break-all font-mono">{owner}</span>
            </li>
          ))}
        </ul>
      </section>

      {configChanged ? (
        <p className="rounded-md border border-warn/40 bg-warn/5 p-3 text-xs text-warn">
          This Safe's on-chain owners, threshold, or version changed since it was added. Live
          values are shown.
        </p>
      ) : null}
      {safeQuery.error ? (
        <p className="text-xs text-danger">Safe refresh failed: {(safeQuery.error as Error).message}</p>
      ) : null}
    </div>
  );
}
