import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SolanaWatchTreasury } from "@chain-pay/shared";
import { Tile } from "@/components/ui/Tile";
import { chainBadge } from "@/lib/format/chain-badge";
import { formatThousands } from "@/lib/format/thousands";
import { formatLamports, formatSignedSol, formatSol } from "@/lib/format/sol";
import { useSolanaWatchStore } from "@/stores/solana-watch";
import { solanaBridge } from "@/lib/chains/sol/ipc";
import { syncSolanaWatch } from "@/lib/chains/sol/sync";

export function SolanaWatchDetail({ treasury }: { treasury: SolanaWatchTreasury }) {
  const record = useSolanaWatchStore((state) => state.records[treasury.id]);
  const [statusError, setStatusError] = useState<string | null>(null);
  useEffect(() => {
    useSolanaWatchStore.getState().ensure(treasury.id, treasury.watch);
  }, [treasury.id, treasury.watch]);
  const providerQuery = useQuery({
    queryKey: ["solana-provider-status", treasury.watch.chain],
    queryFn: () => solanaBridge().status(treasury.watch.chain),
    retry: false,
  });
  const syncQuery = useQuery({
    queryKey: ["solana-watch-sync", treasury.id],
    queryFn: () => syncSolanaWatch(treasury),
    enabled: providerQuery.data?.configured === true,
    retry: false,
    refetchInterval: 60_000,
  });
  const snapshot = record?.snapshot;
  const providerState = providerQuery.isLoading
    ? "checking provider…"
    : providerQuery.data?.configured
      ? "provider configured"
      : "provider not configured";

  async function refreshStatus(signature: string): Promise<void> {
    setStatusError(null);
    try {
      const status = await solanaBridge().transactionStatus({ chain: treasury.watch.chain, signature });
      useSolanaWatchStore.getState().updateTransactionStatus(treasury.id, signature, status.state);
    } catch {
      setStatusError("Transaction status is temporarily unavailable; the last snapshot was preserved.");
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link to="/treasury" className="text-xs text-fg-muted hover:text-fg">← Treasury</Link>
          <h1 className="mt-1 text-2xl font-semibold">{treasury.label}</h1>
          <p className="text-sm text-fg-muted">{chainBadge(treasury.watch.chain)} · Solana watch-only</p>
        </div>
        <div className="flex gap-2">
          <Link to={`/treasury/${treasury.id}/solana/payment/new`} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg">New SOL payment</Link>
          <button type="button" onClick={() => void syncQuery.refetch()} disabled={!providerQuery.data?.configured || syncQuery.isFetching} className="rounded-md border border-accent px-3 py-2 text-sm text-accent disabled:cursor-not-allowed disabled:opacity-40">
            {syncQuery.isFetching ? "Syncing…" : "Refresh"}
          </button>
        </div>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Tile label="Balance" value={snapshot ? `${formatSol(snapshot.balanceLamports)} SOL` : "—"} hint={record?.lastSyncedAt ? `synced ${new Date(record.lastSyncedAt).toLocaleString()}` : providerState} tone="accent" />
        <Tile label="Transactions" value={String(snapshot?.transactions.length ?? 0)} hint={snapshot?.historyTruncated ? "latest 100 · history bounded" : "known signatures"} />
        <Tile label="Finalized slot" value={snapshot ? formatThousands(BigInt(snapshot.slot)) : "—"} hint={snapshot ? `${snapshot.blockhash.slice(0, 12)}…` : "not synced"} />
      </section>

      {!providerQuery.isLoading && !providerQuery.data?.configured ? (
        <p role="alert" className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm text-warn">
          Configure {treasury.watch.chain === "sol:mainnet" ? "SOLANA_MAINNET_RPC_URL" : "SOLANA_DEVNET_RPC_URL"} in the desktop main-process environment, then restart ChainPay.
        </p>
      ) : null}
      {record?.error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">Solana sync failed: {record.error}</p> : null}
      {statusError ? <p role="alert" className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm text-warn">{statusError}</p> : null}
      {record?.rollbackDetected ? (
        <p role="alert" className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm text-warn">
          {record.rollbackSignatures.length > 0
            ? `Chain rollback detected for ${record.rollbackSignatures.length} transaction${record.rollbackSignatures.length === 1 ? "" : "s"}.`
            : "Chain rollback detected in the slot or blockhash context."} Current provider state has replaced stale status.
        </p>
      ) : null}

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Receive address</h2>
        <div className="mt-2 break-all font-mono text-sm text-accent">{treasury.watch.address}</div>
        <p className="mt-2 text-xs text-fg-muted">Public account only. ChainPay never holds signer secrets; durable-nonce payments require externally produced signatures.</p>
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Transaction history</h2>
        {snapshot?.transactions.length ? (
          <ul className="mt-3 divide-y divide-surface-hi">
            {snapshot.transactions.map((transaction) => (
              <li key={transaction.signature} className="flex items-center justify-between gap-4 py-3 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono">{transaction.signature}</div>
                  <div className="mt-1 text-fg-muted">Slot {formatThousands(BigInt(transaction.slot))} · {transaction.state}{transaction.blockTime ? ` · ${new Date(transaction.blockTime * 1000).toLocaleString()}` : ""}</div>
                  <div className="mt-1 text-fg-muted">Fee {transaction.feeLamports === null ? "unavailable" : `${formatLamports(transaction.feeLamports)} lamports`}{transaction.feePaidByWatched === null ? "" : transaction.feePaidByWatched ? " · paid by watched account" : " · paid by another account"}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={`font-medium tabular-nums ${transaction.netLamports !== null && BigInt(transaction.netLamports) >= 0n ? "text-accent" : "text-fg"}`}>
                    {transaction.netLamports === null ? "delta unavailable" : `${formatSignedSol(transaction.netLamports)} SOL`}
                  </span>
                  <button type="button" onClick={() => void refreshStatus(transaction.signature)} className="rounded border border-surface-hi px-2 py-1 text-fg-muted hover:text-fg">Check status</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-sm text-fg-muted">No transactions found.</p>}
      </section>
    </div>
  );
}
