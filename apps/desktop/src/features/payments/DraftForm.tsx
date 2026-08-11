import type { FxQuote, PayeeProfile } from "@chain-pay/shared";
import { PayeePicker } from "./PayeePicker";
import { type RecipientRow } from "./payment-draft";
import { FxSnapshotPanel } from "./FxSnapshotPanel";
import { Section } from "@/components/ui/Section";
import { inputCls } from "./styles";

export function DraftForm({
  treasuryChain,
  recipients,
  setRecipients,
  feeRate,
  setFeeRate,
  label,
  setLabel,
  onBuild,
  busy,
  syncReady,
  loadPayees,
  refetchFx,
  fxQuotes,
  fxLoading,
  fxError,
}: {
  treasuryChain: PayeeProfile["preferredChain"];
  recipients: RecipientRow[];
  setRecipients: (r: RecipientRow[]) => void;
  feeRate: string;
  setFeeRate: (v: string) => void;
  label: string;
  setLabel: (v: string) => void;
  onBuild: () => void;
  busy: boolean;
  syncReady: boolean;
  loadPayees: (payees: PayeeProfile[]) => void | Promise<void>;
  refetchFx: () => void | Promise<void>;
  fxQuotes: FxQuote[];
  fxLoading: boolean;
  fxError: string | null;
}) {
  const fxAge = fxQuotes[0]?.takenAt
    ? new Date(fxQuotes[0].takenAt).toLocaleTimeString()
    : null;
  return (
    <>
      <Section title="2. Recipients">
        <div className="space-y-2">
          {recipients.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_140px_auto] gap-2">
              <input
                type="text"
                value={r.address}
                onChange={(e) =>
                  setRecipients(recipients.map((row, idx) => (idx === i ? { ...row, address: e.target.value } : row)))
                }
                placeholder="ckb1… or ckt1…"
                spellCheck={false}
                className={`${inputCls} font-mono text-xs`}
              />
              <input
                type="text"
                value={r.amountCkb}
                onChange={(e) =>
                  setRecipients(recipients.map((row, idx) => (idx === i ? { ...row, amountCkb: e.target.value } : row)))
                }
                placeholder="amount CKB"
                inputMode="decimal"
                className={`${inputCls} tabular-nums`}
              />
              <button
                type="button"
                onClick={() => setRecipients(recipients.filter((_, idx) => idx !== i))}
                disabled={recipients.length === 1}
                className="rounded-md border border-surface-hi px-2 py-2 text-xs text-fg-muted hover:text-danger disabled:opacity-30"
              >
                ×
              </button>
            </div>
          ))}
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setRecipients([...recipients, { address: "", amountCkb: "" }])}
              className="text-xs text-fg-muted hover:text-fg"
            >
              + add recipient
            </button>
            <PayeePicker chainFilter={treasuryChain} onAdd={loadPayees} />
          </div>
          <FxSnapshotPanel
            quotes={fxQuotes}
            loading={fxLoading}
            error={fxError}
            takenAtLabel={fxAge}
            onRefresh={refetchFx}
          />
        </div>
      </Section>

      <Section title="3. Fee rate (shannons/byte)">
        <input
          type="text"
          value={feeRate}
          onChange={(e) => setFeeRate(e.target.value.replace(/\D/g, ""))}
          className={`${inputCls} tabular-nums`}
        />
      </Section>

      <Section title="4. Label (optional)">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. March payroll batch"
          className={inputCls}
        />
      </Section>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onBuild}
          disabled={busy || !syncReady}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {!syncReady ? "waiting for sync…" : busy ? "fetching cells + building…" : "Build payment"}
        </button>
      </div>
    </>
  );
}
