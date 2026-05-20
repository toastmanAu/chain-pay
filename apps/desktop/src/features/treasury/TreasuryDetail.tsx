import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CkbMultisig, Treasury } from "@chain-pay/shared";
import { useTreasuryStore } from "@/stores/treasury";
import { useSyncStore } from "@/stores/sync";
import { lightClient } from "@/lib/light-client/client";
import { treasuryLockScript } from "@/lib/chains/ckb/address";
import type { CkbMultisigConfig } from "@/lib/chains/ckb/multisig";

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

  // EVM treasuries are Phase 3 — for now, only CKB shows balance + sync.
  if (!treasury.multisig.chain.startsWith("ckb:")) {
    return <NonCkbStub treasury={treasury} />;
  }

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
  const [subscribed, setSubscribed] = useState(false);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  useEffect(() => {
    if (!lcReady || subscribed) return;
    let cancelled = false;
    void lightClient()
      .watchLockScript(script, 0n)
      .then(() => {
        if (!cancelled) setSubscribed(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setSubscribeError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [lcReady, subscribed, script]);

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

function NonCkbStub({ treasury }: { treasury: Treasury }) {
  return (
    <div className="space-y-4">
      <Link to="/treasury" className="text-xs text-fg-muted hover:text-fg">
        ← Treasury
      </Link>
      <h1 className="text-2xl font-semibold">{treasury.label}</h1>
      <div className="rounded-lg border border-warn/40 bg-warn/5 p-4 text-sm">
        EVM treasury detail is Phase 3. The Safe contract address is{" "}
        <code className="font-mono">{treasury.multisig.address}</code>.
      </div>
    </div>
  );
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
