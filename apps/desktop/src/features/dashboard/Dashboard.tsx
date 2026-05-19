import { useEffect } from "react";
import { useSyncStore } from "@/stores/sync";

export function Dashboard() {
  const ckb = useSyncStore((s) => s.ckb);
  const startCkb = useSyncStore((s) => s.startCkb);

  useEffect(() => {
    if (!ckb.started && !ckb.starting) void startCkb("mainnet");
  }, [ckb.started, ckb.starting, startCkb]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-fg-muted">Treasury, payroll, sync status at a glance.</p>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Tile
          label="CKB tip block"
          value={ckb.tipBlockNumber > 0n ? formatBlockNumber(ckb.tipBlockNumber) : ckb.starting ? "starting…" : "—"}
          hint={
            ckb.lastError
              ? `error: ${ckb.lastError}`
              : ckb.started
                ? `${ckb.peers} peer${ckb.peers === 1 ? "" : "s"} · ${ckb.network ?? ""}`
                : "embedded light client"
          }
          tone={ckb.lastError ? "danger" : ckb.tipBlockNumber > 0n ? "accent" : "default"}
        />
        <Tile label="Pending payments" value="—" hint="Phase 2" />
        <Tile label="This month payroll" value="—" hint="Phase 2.5" />
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Next up</h2>
        <ol className="mt-3 space-y-2 text-sm">
          <li><strong className="text-fg">Phase 1</strong> — embedded CKB light client live (verify the tip tile is ticking).</li>
          <li><strong className="text-fg">Phase 2</strong> — CKB multisig treasury setup, propose / sign / broadcast.</li>
          <li><strong className="text-fg">Phase 3</strong> — Safe-based EVM multisig with MetaMask + WalletConnect.</li>
        </ol>
      </section>

      {ckb.lastPolledAt > 0 ? (
        <p className="text-xs text-fg-muted">last polled {Math.max(0, Math.round((Date.now() - ckb.lastPolledAt) / 1000))}s ago</p>
      ) : null}
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
  tone?: "default" | "accent" | "danger";
}) {
  const valueClass = tone === "accent" ? "text-accent" : tone === "danger" ? "text-danger" : "text-fg";
  return (
    <div className="rounded-lg border border-surface-hi bg-surface p-5">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      <div className="mt-1 text-xs text-fg-muted">{hint}</div>
    </div>
  );
}

function formatBlockNumber(n: bigint): string {
  const s = n.toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
