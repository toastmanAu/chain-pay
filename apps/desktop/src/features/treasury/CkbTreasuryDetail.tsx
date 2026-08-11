import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CkbMultisig, MultisigTreasury } from "@chain-pay/shared";
import { Tile } from "@/components/ui/Tile";
import { chainBadge } from "@/lib/format/chain-badge";
import { formatCkb } from "@/lib/format/ckb";
import { formatBlockNumber } from "@/lib/format/block";
import { secondsAgo } from "@/lib/format/time";
import { useSyncStore } from "@/stores/sync";
import { lightClient } from "@/lib/light-client/client";
import { treasuryLockScript } from "@/lib/chains/ckb/address";
import type { CkbMultisigConfig } from "@/lib/chains/ckb/multisig";

export function CkbTreasuryDetail({ treasury }: { treasury: MultisigTreasury }) {
  const multisig = treasury.multisig as CkbMultisig;
  const cfg = useMemo<CkbMultisigConfig>(
    () => ({
      s: 0,
      r: 0,
      m: multisig.m,
      n: multisig.n,
      pubkeyHashes: multisig.pubkeyHashes,
      ...(multisig.since !== undefined ? { since: multisig.since } : {}),
    }),
    [multisig.m, multisig.n, multisig.pubkeyHashes, multisig.since],
  );
  const script = useMemo(() => treasuryLockScript(cfg), [cfg]);

  const ckbSync = useSyncStore((s) => s.ckb);
  const lcReady = ckbSync.started && ckbSync.tipBlockNumber > 0n;

  // Subscribe the light client to this lock script on mount; idempotent.
  // Start from a small buffer behind the current tip — full genesis back-scan
  // takes hours on testnet for what we actually want (recent funding txs).
  // A user-driven "rescan from block X" affordance lives in Phase 2.5.
  const SUBSCRIBE_BUFFER_BLOCKS = 200n;
  const [subscribed, setSubscribed] = useState(false);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  useEffect(() => {
    if (!lcReady || subscribed) return;
    const fromBlock =
      ckbSync.tipBlockNumber > SUBSCRIBE_BUFFER_BLOCKS
        ? ckbSync.tipBlockNumber - SUBSCRIBE_BUFFER_BLOCKS
        : 0n;
    let cancelled = false;
    void lightClient()
      .watchLockScript(script, fromBlock)
      .then(() => {
        if (!cancelled) setSubscribed(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setSubscribeError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [lcReady, subscribed, script, ckbSync.tipBlockNumber]);

  const balanceQuery = useQuery({
    queryKey: ["treasury-balance", multisig.address],
    queryFn: () => lightClient().getLockBalance(script),
    enabled: lcReady && subscribed,
    refetchInterval: 6_000,
  });

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link to="/treasury" className="text-xs text-fg-muted hover:text-fg">
            ← Treasury
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{treasury.label}</h1>
          <p className="text-sm text-fg-muted">
            {chainBadge(multisig.chain)} · {multisig.m}-of-{multisig.n} multisig
          </p>
        </div>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Tile
          label="Balance"
          value={balanceDisplay(balanceQuery.data, balanceQuery.isLoading, lcReady, subscribed)}
          hint={
            !lcReady
              ? "waiting for light client"
              : !subscribed
                ? "subscribing to lock…"
                : balanceQuery.dataUpdatedAt
                  ? `updated ${secondsAgo(balanceQuery.dataUpdatedAt)}s ago`
                  : "first fetch…"
          }
          tone="accent"
        />
        <Tile
          label="Sync tip"
          value={ckbSync.tipBlockNumber > 0n ? formatBlockNumber(ckbSync.tipBlockNumber) : "—"}
          hint={ckbSync.peers > 0 ? `${ckbSync.peers} peer${ckbSync.peers === 1 ? "" : "s"}` : "no peers yet"}
        />
        <Tile label="Pending tx" value="—" hint="Phase 2.5" />
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Address</h2>
        <div className="mt-2 break-all font-mono text-xs text-accent">{multisig.address}</div>
        <p className="mt-3 text-xs text-fg-muted">
          Fund this address to begin running payroll. Balance updates from the embedded light
          client every 6 seconds.
        </p>
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Co-signer pubkey hashes</h2>
        <ul className="mt-3 space-y-1">
          {multisig.pubkeyHashes.map((h, i) => (
            <li key={`${h}-${i}`} className="flex items-baseline gap-3 text-xs">
              <span className="w-6 text-fg-muted tabular-nums">{i + 1}.</span>
              <span className="break-all font-mono">{h}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-fg-muted">
          Any {multisig.m} of these signers must approve a transaction.
        </p>
      </section>

      {subscribeError ? (
        <p className="text-xs text-danger">subscribe failed: {subscribeError}</p>
      ) : null}
      {balanceQuery.error ? (
        <p className="text-xs text-danger">
          balance fetch failed: {(balanceQuery.error as Error).message}
        </p>
      ) : null}
    </div>
  );
}

function balanceDisplay(
  shannons: bigint | undefined,
  isLoading: boolean,
  lcReady: boolean,
  subscribed: boolean,
): string {
  if (!lcReady) return "—";
  if (!subscribed) return "…";
  if (isLoading && shannons === undefined) return "…";
  if (shannons === undefined) return "—";
  return `${formatCkb(shannons)} CKB`;
}
