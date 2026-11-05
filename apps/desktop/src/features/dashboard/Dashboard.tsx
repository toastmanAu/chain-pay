import { useSyncStore } from "@/stores/sync";
import { Tile } from "@/components/ui/Tile";
import { formatBlockNumber } from "@/lib/format/block";
import { secondsAgo } from "@/lib/format/time";

type PhaseStatus = "verified" | "live-check-open";

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
    status: "verified",
  },
  {
    id: "1",
    title: "Phase 1 — Light client",
    summary: "Embedded CKB light client, WASM in renderer, verified on mainnet",
    status: "verified",
  },
  {
    id: "2",
    title: "Phase 2 — Multisig treasury",
    summary: "2-of-3 secp256k1 multisig: encode, derive, build, sign, merge, broadcast",
    status: "verified",
    note: "first tx 0x4e66d1…0e92, block 21,161,590",
  },
  {
    id: "2.5",
    title: "Phase 2.5 — Payroll batches",
    summary: "Payees CRUD, CoinGecko FX snapshot, batch state machine, draft persistence",
    status: "verified",
    note: "first batch tx 0x69ebf7…3b4e1, block 21,176,012 · 3 payees + change",
  },
  {
    id: "2.7",
    title: "Phase 2.7 — CEMP-PQ",
    summary: "Encrypted signature relay via ML-DSA, ML-KEM, Profile Cells, and acknowledgments",
    status: "verified",
    note: "CKB testnet A↔B roundtrip confirmed",
  },
  {
    id: "invoices",
    title: "Invoice intake",
    summary: "Manual entry, OCR extraction, bundling, and approval workflow implemented",
    status: "live-check-open",
    note: "OCR on real documents and mobile invoice arrival still need physical checks",
  },
  {
    id: "3",
    title: "Phase 3 — EVM treasury",
    summary: "Safe monitoring, approvals, execution, and WalletConnect interchange implemented",
    status: "live-check-open",
    note: "Funded Sepolia execution with two Safe owners remains to be verified",
  },
  {
    id: "4",
    title: "Phase 4 — Accounting bridge",
    summary: "ERPNext journal posting and compliance export implemented across four chains",
    status: "live-check-open",
    note: "CKB and Bitcoin posting verified live; Safe and Solana gates remain",
  },
  {
    id: "5-btc",
    title: "Phase 5 — Bitcoin",
    summary: "Testnet4 watch, external signing review, broadcast, and accounting",
    status: "verified",
    note: "Confirmed payment and idempotent ERPNext journal verified live",
  },
  {
    id: "5-sol",
    title: "Phase 5 — Solana",
    summary: "Watch, durable-nonce payment, and finalized accounting implemented",
    status: "live-check-open",
    note: "Funded devnet signer and nonce setup remain to be tested",
  },
  {
    id: "mobile",
    title: "Mobile companion",
    summary: "Android pairing, invoice capture, OCR, and queued sync implemented",
    status: "live-check-open",
    note: "A53 pairing tested; arrival in desktop Invoices remains open",
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
            {PHASES.filter((p) => p.status === "verified").length} verified ·{" "}
            {PHASES.filter((p) => p.status === "live-check-open").length} live checks open
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
          <span className={`shrink-0 whitespace-nowrap text-xs uppercase tracking-wide ${styles.badge}`}>{styles.label}</span>
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
  verified: {
    glyph: "✓",
    label: "verified",
    row: "border-surface-hi/60 bg-surface/40",
    pip: "bg-accent/15 text-accent",
    title: "text-fg",
    badge: "text-accent",
    note: "text-fg-muted",
  },
  "live-check-open": {
    glyph: "→",
    label: "live check open",
    row: "border-warn/50 bg-warn/5",
    pip: "bg-warn/20 text-warn",
    title: "text-fg",
    badge: "text-warn",
    note: "text-warn",
  },
};

