import { useEffect } from "react";
import { useSyncStore } from "@/stores/sync";

export function Dashboard() {
  const ckb = useSyncStore((s) => s.ckb);
  const startCkb = useSyncStore((s) => s.startCkb);

  useEffect(() => {
    if (!ckb.started) void startCkb("mainnet");
  }, [ckb.started, startCkb]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-fg-muted">Treasury, payroll, sync status at a glance.</p>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Tile label="CKB tip block" value={ckb.started ? String(ckb.tipBlockNumber) : "—"} hint={ckb.started ? `peers ${ckb.peers}` : "starting light client…"} />
        <Tile label="Pending payments" value="—" hint="Phase 2" />
        <Tile label="This month payroll" value="—" hint="Phase 2.5" />
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Next up</h2>
        <ol className="mt-3 space-y-2 text-sm">
          <li><strong className="text-fg">Phase 1</strong> — wire embedded CKB light client (see PHASE-1.md).</li>
          <li><strong className="text-fg">Phase 2</strong> — CKB multisig treasury setup, propose / sign / broadcast.</li>
          <li><strong className="text-fg">Phase 3</strong> — Safe-based EVM multisig with MetaMask + WalletConnect.</li>
        </ol>
      </section>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-surface-hi bg-surface p-5">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-fg-muted">{hint}</div>
    </div>
  );
}
