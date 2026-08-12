import { useSyncStore } from "@/stores/sync";
import { Tile } from "@/components/ui/Tile";
import { formatBlockNumber } from "@/lib/format/block";
import { secondsAgo } from "@/lib/format/time";

type PhaseStatus = "done" | "in-progress" | "next" | "blocked";

interface PhaseEntry {
  id: string;
  title: string;
  summary: string;
  status: PhaseStatus;
  note?: string;
}

const PHASES: ReadonlyArray<PhaseEntry> = [
  {
    id: "0",
    title: "Phase 0 — Scaffold",
    summary: "Monorepo, ChainAdapter / SignerTransport interfaces, DocType schemas",
    status: "done",
  },
  {
    id: "1",
    title: "Phase 1 — Light client",
    summary: "Embedded CKB light client, WASM in renderer, mainnet-verified",
    status: "done",
  },
  {
    id: "2",
    title: "Phase 2 — Multisig treasury",
    summary: "2-of-3 secp256k1 multisig: encode, derive, build, sign, merge, broadcast",
    status: "done",
    note: "first tx 0x4e66d1…0e92, block 21,161,590",
  },
  {
    id: "2.5",
    title: "Phase 2.5 — Payroll batches",
    summary: "Payees CRUD, CoinGecko FX snapshot, batch state machine, draft persistence",
    status: "done",
    note: "first batch tx 0x69ebf7…3b4e1, block 21,176,012 · 3 payees + change",
  },
  {
    id: "2.7",
    title: "Phase 2.7 — CEMP-PQ",
    summary: "Post-quantum encrypted signature relay via ML-DSA + ML-KEM + Profile Cells",
    status: "in-progress",
    note: "upstream ready (profile 0xf316f3…, message 0x8ce77e35…) · ChainPay integration next",
  },
  {
    id: "3",
    title: "Phase 3 — EVM treasury",
    summary: "Safe (Gnosis) multisig + MetaMask / WalletConnect signer transports",
    status: "next",
  },
  {
    id: "4",
    title: "Phase 4 — Accounting bridge",
    summary: "Frappe / ERPNext journal entries, compliance export",
    status: "next",
  },
];

export function Dashboard() {
  const ckb = useSyncStore((s) => s.ckb);

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
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-fg-muted">Build status</h2>
          <span className="text-xs text-fg-muted">
            {PHASES.filter((p) => p.status === "done").length} of {PHASES.length} phases shipped
          </span>
        </div>
        <ol className="mt-4 space-y-3">
          {PHASES.map((phase) => (
            <PhaseRow key={phase.id} phase={phase} />
          ))}
        </ol>
      </section>

      {ckb.lastPolledAt > 0 ? (
        <p className="text-xs text-fg-muted">last polled {secondsAgo(ckb.lastPolledAt)}s ago</p>
      ) : null}
    </div>
  );
}

interface PhaseRowProps {
  phase: PhaseEntry;
}

function PhaseRow({ phase }: PhaseRowProps) {
  const styles = PHASE_STATUS_STYLES[phase.status];
  return (
    <li className={`flex gap-3 rounded-md border px-3 py-2 ${styles.row}`}>
      <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${styles.pip}`}>
        {styles.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-sm font-medium ${styles.title}`}>{phase.title}</span>
          <span className={`text-xs uppercase tracking-wide ${styles.badge}`}>{styles.label}</span>
        </div>
        <p className="mt-0.5 text-xs text-fg-muted">{phase.summary}</p>
        {phase.note ? <p className={`mt-1 text-xs ${styles.note}`}>{phase.note}</p> : null}
      </div>
    </li>
  );
}

const PHASE_STATUS_STYLES: Record<
  PhaseStatus,
  {
    glyph: string;
    label: string;
    row: string;
    pip: string;
    title: string;
    badge: string;
    note: string;
  }
> = {
  done: {
    glyph: "✓",
    label: "shipped",
    row: "border-surface-hi/60 bg-surface/40",
    pip: "bg-accent/15 text-accent",
    title: "text-fg",
    badge: "text-accent",
    note: "text-fg-muted",
  },
  "in-progress": {
    glyph: "→",
    label: "in progress",
    row: "border-warn/50 bg-warn/5",
    pip: "bg-warn/20 text-warn",
    title: "text-fg",
    badge: "text-warn",
    note: "text-warn",
  },
  next: {
    glyph: "○",
    label: "next up",
    row: "border-surface-hi/60 bg-surface/20",
    pip: "bg-surface-hi/40 text-fg-muted",
    title: "text-fg",
    badge: "text-fg-muted",
    note: "text-fg-muted",
  },
  blocked: {
    glyph: "!",
    label: "blocked",
    row: "border-danger/40 bg-danger/5",
    pip: "bg-danger/20 text-danger",
    title: "text-fg",
    badge: "text-danger",
    note: "text-danger",
  },
};

