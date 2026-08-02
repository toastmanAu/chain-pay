import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CkbMultisig, MultisigTreasury, PayrollBatch, PayrollBatchState, Treasury } from "@chain-pay/shared";
import { isMultisigTreasury, isPayrollBatch } from "@chain-pay/shared";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { useTreasuryStore } from "@/stores/treasury";
import { nextStates, isTerminal } from "@/lib/payroll/state-machine";
import { postBatchJournal } from "@/lib/accounting/post-batch-journal";

const inputCls =
  "w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted/60";

export function PayrollBatches() {
  const batches = usePayrollBatchesStore((s) => s.batches);
  const treasuries = useTreasuryStore((s) => s.treasuries);
  const ckbTreasuries = useMemo(
    () => treasuries.filter(isMultisigTreasury).filter((t) => t.multisig.chain.startsWith("ckb:")),
    [treasuries],
  );

  // This page is the payroll-batch index — vendor batches surface in their own
  // (3a-T13) UI. Filter the heterogeneous AnyBatch[] before sorting so
  // BatchCard can keep its narrower PayrollBatch prop type.
  const sorted = useMemo(
    () =>
      batches
        .filter(isPayrollBatch)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [batches],
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Payroll batches</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Each batch is one multisig transaction with one input from a treasury and N outputs to
          payee addresses. Lifecycle: draft → calculated → approved → broadcasted →
          confirmed/failed (or cancelled at any pre-broadcast step).
        </p>
      </header>

      <CreateBatchForm treasuries={ckbTreasuries} />

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-fg-muted">
          {sorted.length} {sorted.length === 1 ? "batch" : "batches"}
        </h2>
        {sorted.length === 0 ? (
          <p className="rounded-lg border border-dashed border-surface-hi bg-surface/50 p-6 text-center text-sm text-fg-muted">
            No batches yet. Create one above, or build one from the{" "}
            <span className="text-fg">Payments</span> page after picking payees.
          </p>
        ) : (
          <ul className="space-y-2">
            {sorted.map((b) => (
              <BatchCard
                key={b.id}
                batch={b}
                treasuryLabel={lookupTreasuryLabel(treasuries, b.treasuryId)}
                treasuryM={lookupTreasuryM(treasuries, b.treasuryId)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CreateBatchForm({ treasuries }: { treasuries: MultisigTreasury[] }) {
  const addBatch = usePayrollBatchesStore((s) => s.addBatch);
  const [label, setLabel] = useState("");
  const [treasuryId, setTreasuryId] = useState(treasuries[0]?.id ?? "");
  const [cycleStart, setCycleStart] = useState(monthStart(new Date()));
  const [cycleEnd, setCycleEnd] = useState(monthEnd(new Date()));
  const [error, setError] = useState<string | null>(null);

  function handleCreate() {
    setError(null);
    if (!label.trim()) return setError("Label required");
    if (!treasuryId) return setError("Select a treasury first");
    const now = new Date().toISOString();
    const id = (globalThis.crypto?.randomUUID?.() ?? `b-${Date.now()}`) as string;
    const batch: PayrollBatch = {
      id,
      kind: "payroll",
      label: label.trim(),
      treasuryId,
      cycleStart,
      cycleEnd,
      fxSnapshot: [],
      lines: [],
      state: "draft",
      createdAt: now,
      updatedAt: now,
    };
    addBatch(batch);
    setLabel("");
  }

  if (treasuries.length === 0) {
    return (
      <section className="rounded-lg border border-dashed border-surface-hi bg-surface/40 p-4 text-sm text-fg-muted">
        Create a multisig treasury first (Treasury → + New).
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-lg border border-surface-hi bg-surface p-5">
      <h2 className="text-sm font-medium">New batch (draft)</h2>
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 space-y-1 text-xs text-fg-muted">
          Label
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. May 2026 payroll"
            className={inputCls}
          />
        </label>
        <label className="col-span-2 space-y-1 text-xs text-fg-muted">
          Treasury
          <select value={treasuryId} onChange={(e) => setTreasuryId(e.target.value)} className={inputCls}>
            {treasuries.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-fg-muted">
          Cycle start
          <input
            type="date"
            value={cycleStart}
            onChange={(e) => setCycleStart(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="space-y-1 text-xs text-fg-muted">
          Cycle end
          <input
            type="date"
            value={cycleEnd}
            onChange={(e) => setCycleEnd(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleCreate}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
        >
          Create draft
        </button>
      </div>
    </section>
  );
}

function BatchCard({
  batch,
  treasuryLabel,
  treasuryM,
}: {
  batch: PayrollBatch;
  treasuryLabel: string;
  treasuryM: number | null;
}) {
  const transition = usePayrollBatchesStore((s) => s.transition);
  const removeBatch = usePayrollBatchesStore((s) => s.removeBatch);
  const selectDraft = usePayrollBatchesStore((s) => s.selectDraft);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const totalFiat = useMemo(() => sumFiat(batch), [batch]);
  const transitions = nextStates(batch.state);
  // A batch is resumable when it has a frozen tx attached and hasn't broadcast
  // yet — i.e. we're between "build" and "merge & broadcast".
  const resumable =
    Boolean(batch.txBytes) &&
    (batch.state === "calculated" || batch.state === "approved");
  const sigCount = batch.partialSigs?.length ?? 0;

  function handleTransition(to: PayrollBatchState) {
    setError(null);
    try {
      transition(batch.id, to);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleResume() {
    selectDraft(batch.id);
    navigate("/payments");
  }

  return (
    <li className="space-y-3 rounded-lg border border-surface-hi bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-fg">{batch.label}</span>
            <StateBadge state={batch.state} />
            {resumable ? (
              <span className="text-[10px] uppercase tracking-wide text-fg-muted">
                {sigCount}/{treasuryM ?? "?"} sigs collected
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs text-fg-muted">
            {batch.cycleStart} → {batch.cycleEnd} · treasury: {treasuryLabel} · {batch.lines.length}{" "}
            line{batch.lines.length === 1 ? "" : "s"}
            {totalFiat ? <> · total {totalFiat}</> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {resumable ? (
            <button
              type="button"
              onClick={handleResume}
              className="rounded-md bg-accent/90 px-3 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
            >
              Resume
            </button>
          ) : null}
          {transitions.map((to) => (
            <button
              key={to}
              type="button"
              onClick={() => handleTransition(to)}
              className="rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs text-fg-muted hover:text-fg"
            >
              → {to}
            </button>
          ))}
          {isTerminal(batch.state) ? (
            <button
              type="button"
              onClick={() => removeBatch(batch.id)}
              className="rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs text-fg-muted hover:bg-danger/30 hover:text-fg"
            >
              delete
            </button>
          ) : null}
        </div>
      </div>
      {batch.fxSnapshot.length > 0 ? (
        <div className="text-[11px] text-fg-muted">
          FX:{" "}
          {batch.fxSnapshot
            .map((q) => `1 ${q.base}=${q.rate} ${q.quote}`)
            .join(" · ")}
        </div>
      ) : null}
      {batch.state === "posting" ? (
        <p className="text-xs text-fg-muted">Posting to accounting…</p>
      ) : null}
      {batch.state === "posted" ? (
        <p className="text-xs text-accent">Posted · {batch.jeName}</p>
      ) : null}
      {batch.state === "post_failed" ? (
        <div className="flex items-center gap-2">
          <p className="text-xs text-danger">{batch.postError}</p>
          <button
            type="button"
            onClick={() => void postBatchJournal(batch.id)}
            className="rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs text-fg-muted hover:text-fg"
          >
            Retry
          </button>
        </div>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </li>
  );
}

function StateBadge({ state }: { state: PayrollBatchState }) {
  const tone = stateTone(state);
  return (
    <span
      className={
        "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide " + tone
      }
    >
      {state}
    </span>
  );
}

function stateTone(state: PayrollBatchState): string {
  switch (state) {
    case "draft":
      return "bg-surface-hi text-fg-muted";
    case "calculated":
      return "bg-warn/20 text-warn";
    case "approved":
      return "bg-accent/20 text-accent";
    case "broadcast_countdown":
      return "bg-warn/30 text-warn";
    case "broadcast_initiating":
      return "bg-accent/30 text-accent";
    case "broadcast_failed":
      return "bg-danger/20 text-danger";
    case "broadcasted":
      return "bg-accent/40 text-accent-fg";
    case "confirmed":
      return "bg-accent text-accent-fg";
    case "posting":
      return "bg-accent/60 text-accent-fg";
    case "posted":
      return "bg-accent/80 text-accent-fg";
    case "post_failed":
      return "bg-danger/20 text-danger";
    case "failed":
      return "bg-danger/30 text-danger";
    case "cancelled":
      return "bg-surface-hi text-fg-muted line-through";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function lookupTreasuryLabel(
  treasuries: Array<{ id: string; label: string }>,
  id: string,
): string {
  return treasuries.find((t) => t.id === id)?.label ?? "(unknown)";
}

function lookupTreasuryM(treasuries: Treasury[], id: string): number | null {
  const found = treasuries.find((t) => t.id === id);
  if (!found || !isMultisigTreasury(found)) return null;
  if (!found.multisig.chain.startsWith("ckb:")) return null;
  return (found.multisig as CkbMultisig).m;
}

function sumFiat(batch: PayrollBatch): string | null {
  if (batch.lines.length === 0) return null;
  // Sum within each currency separately — mixed-currency batches show each total.
  const byCurrency = new Map<string, bigint>();
  for (const line of batch.lines) {
    const key = line.fiat.currency;
    byCurrency.set(key, (byCurrency.get(key) ?? 0n) + line.fiat.minor);
  }
  const parts: string[] = [];
  for (const [currency, minor] of byCurrency) {
    const whole = minor / 100n;
    const frac = (minor % 100n).toString().padStart(2, "0");
    parts.push(`${whole.toString()}.${frac} ${currency}`);
  }
  return parts.join(" + ");
}

function monthStart(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function monthEnd(d: Date): string {
  const year = d.getFullYear();
  const next = new Date(year, d.getMonth() + 1, 0);
  const month = String(next.getMonth() + 1).padStart(2, "0");
  const day = String(next.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
