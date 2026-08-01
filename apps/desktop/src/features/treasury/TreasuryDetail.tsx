import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatEther } from "viem";
import type { CkbMultisig, EvmMultisig, Treasury } from "@chain-pay/shared";
import { useTreasuryStore } from "@/stores/treasury";
import { useSyncStore } from "@/stores/sync";
import { lightClient } from "@/lib/light-client/client";
import { treasuryLockScript } from "@/lib/chains/ckb/address";
import type { CkbMultisigConfig } from "@/lib/chains/ckb/multisig";
import { readSafeSnapshot } from "@/lib/chains/evm/safe-reader";

const SHANNONS_PER_CKB = 100_000_000n;

export function TreasuryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const treasury = useTreasuryStore((s) => s.treasuries.find((t) => t.id === id));

  if (!treasury) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Treasury not found</h1>
        <button
          type="button"
          onClick={() => navigate("/treasury")}
          className="rounded-md border border-surface-hi bg-surface px-4 py-2 text-sm hover:text-fg"
        >
          Back to treasury list
        </button>
      </div>
    );
  }

  if (treasury.multisig.chain.startsWith("evm:")) return <EvmTreasuryDetail treasury={treasury} />;

  return <CkbTreasuryDetail treasury={treasury} />;
}

function CkbTreasuryDetail({ treasury }: { treasury: Treasury }) {
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

function EvmTreasuryDetail({ treasury }: { treasury: Treasury }) {
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

function formatEth(wei: bigint): string {
  const value = formatEther(wei);
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, 6).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole!;
}

function Tile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "accent";
}) {
  const valueClass = tone === "accent" ? "text-accent" : "text-fg";
  return (
    <div className="rounded-lg border border-surface-hi bg-surface p-5">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      <div className="mt-1 text-xs text-fg-muted">{hint}</div>
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

function formatCkb(shannons: bigint): string {
  const whole = shannons / SHANNONS_PER_CKB;
  const fractional = shannons % SHANNONS_PER_CKB;
  if (fractional === 0n) return formatThousands(whole);
  // Trim trailing zeros from the 8-digit fractional part for readability.
  const fracStr = fractional.toString().padStart(8, "0").replace(/0+$/, "");
  return `${formatThousands(whole)}.${fracStr}`;
}

function formatThousands(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatBlockNumber(n: bigint): string {
  return formatThousands(n);
}

function secondsAgo(timestampMs: number): number {
  return Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
}

function chainBadge(chain: string): string {
  if (chain === "ckb:mainnet") return "CKB mainnet";
  if (chain === "ckb:testnet") return "CKB testnet";
  if (chain.startsWith("evm:")) return `EVM ${chain.slice(4)}`;
  return chain;
}
