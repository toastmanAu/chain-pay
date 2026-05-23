import { useEffect, useMemo, useState } from "react";
import type { FiatAmount, PayeeProfile } from "@chain-pay/shared";
import type { ChainId } from "@chain-pay/shared";
import { usePayeesStore } from "@/stores/payees";
import { CopyButton } from "@/components/clipboard/CopyButton";

interface DraftPayee {
  displayName: string;
  salaryFiatAmount: string;
  salaryFiatCurrency: string;
  preferredChain: ChainId;
  preferredAsset: string;
  walletAddress: string;
  active: boolean;
}

const emptyDraft: DraftPayee = {
  displayName: "",
  salaryFiatAmount: "",
  salaryFiatCurrency: "USD",
  preferredChain: "ckb:testnet",
  preferredAsset: "CKB",
  walletAddress: "",
  active: true,
};

const inputCls =
  "w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted/60";

export function Employees() {
  const payees = usePayeesStore((s) => s.payees);
  const addPayee = usePayeesStore((s) => s.addPayee);
  const updatePayee = usePayeesStore((s) => s.updatePayee);
  const removePayee = usePayeesStore((s) => s.removePayee);

  const [draft, setDraft] = useState<DraftPayee>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validation = useMemo(() => validateDraft(draft), [draft]);
  const formMode = editingId ? "Edit payee" : "Add payee";

  useEffect(() => {
    if (!editingId) return;
    const p = payees.find((x) => x.id === editingId);
    if (!p) {
      setEditingId(null);
      return;
    }
    setDraft({
      displayName: p.displayName,
      salaryFiatAmount: fiatAmountToText(p.salaryFiat),
      salaryFiatCurrency: p.salaryFiat.currency,
      preferredChain: p.preferredChain,
      preferredAsset: p.preferredAsset,
      walletAddress: p.walletAddress,
      active: p.active,
    });
  }, [editingId, payees]);

  function handleSubmit() {
    setError(null);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    const now = new Date().toISOString();
    if (editingId) {
      updatePayee(editingId, {
        displayName: draft.displayName.trim(),
        salaryFiat: validation.salaryFiat,
        preferredChain: draft.preferredChain,
        preferredAsset: draft.preferredAsset.trim() || "CKB",
        walletAddress: draft.walletAddress.trim(),
        active: draft.active,
      });
    } else {
      const id = (globalThis.crypto?.randomUUID?.() ?? `p-${Date.now()}`) as string;
      const profile: PayeeProfile = {
        id,
        displayName: draft.displayName.trim(),
        salaryFiat: validation.salaryFiat,
        preferredChain: draft.preferredChain,
        preferredAsset: draft.preferredAsset.trim() || "CKB",
        walletAddress: draft.walletAddress.trim(),
        active: draft.active,
        createdAt: now,
        updatedAt: now,
      };
      addPayee(profile);
    }
    setDraft(emptyDraft);
    setEditingId(null);
  }

  function handleCancelEdit() {
    setEditingId(null);
    setDraft(emptyDraft);
    setError(null);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Employees &amp; contractors</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Payee profiles: fiat salary, preferred asset, preferred network, wallet address.
          Phase 2.5 — payroll batch will read this list to produce one N-to-many multisig tx.
        </p>
      </header>

      <section className="space-y-3 rounded-lg border border-surface-hi bg-surface p-5">
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-medium">{formMode}</h2>
          {editingId ? (
            <button
              type="button"
              onClick={handleCancelEdit}
              className="text-xs text-fg-muted underline hover:text-fg"
            >
              cancel edit
            </button>
          ) : null}
        </header>

        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2 space-y-1 text-xs text-fg-muted">
            Display name
            <input
              type="text"
              value={draft.displayName}
              onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
              placeholder="Alice Operator"
              className={inputCls}
            />
          </label>

          <label className="space-y-1 text-xs text-fg-muted">
            Salary (per cycle)
            <input
              type="text"
              inputMode="decimal"
              value={draft.salaryFiatAmount}
              onChange={(e) => setDraft({ ...draft, salaryFiatAmount: e.target.value })}
              placeholder="5000.00"
              className={`${inputCls} tabular-nums`}
            />
          </label>

          <label className="space-y-1 text-xs text-fg-muted">
            Currency
            <select
              value={draft.salaryFiatCurrency}
              onChange={(e) => setDraft({ ...draft, salaryFiatCurrency: e.target.value })}
              className={inputCls}
            >
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
              <option value="AUD">AUD</option>
              <option value="NZD">NZD</option>
              <option value="JPY">JPY</option>
            </select>
          </label>

          <label className="space-y-1 text-xs text-fg-muted">
            Preferred chain
            <select
              value={draft.preferredChain}
              onChange={(e) =>
                setDraft({ ...draft, preferredChain: e.target.value as ChainId })
              }
              className={inputCls}
            >
              <option value="ckb:testnet">CKB Testnet</option>
              <option value="ckb:mainnet">CKB Mainnet</option>
            </select>
          </label>

          <label className="space-y-1 text-xs text-fg-muted">
            Asset
            <input
              type="text"
              value={draft.preferredAsset}
              onChange={(e) => setDraft({ ...draft, preferredAsset: e.target.value })}
              placeholder="CKB"
              className={inputCls}
            />
          </label>

          <label className="col-span-2 space-y-1 text-xs text-fg-muted">
            Wallet address
            <input
              type="text"
              value={draft.walletAddress}
              onChange={(e) => setDraft({ ...draft, walletAddress: e.target.value })}
              placeholder="ckt1q…"
              spellCheck={false}
              className={`${inputCls} font-mono text-xs`}
            />
          </label>

          <label className="col-span-2 flex items-center gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
            />
            Active (include in next payroll batch)
          </label>
        </div>

        {error ? <p className="text-xs text-danger">{error}</p> : null}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!validation.ok}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {editingId ? "Save changes" : "Add payee"}
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-fg-muted">
          {payees.length} {payees.length === 1 ? "payee" : "payees"}
        </h2>
        {payees.length === 0 ? (
          <p className="rounded-lg border border-dashed border-surface-hi bg-surface/50 p-6 text-center text-sm text-fg-muted">
            No payees yet. Add one above.
          </p>
        ) : (
          <ul className="divide-y divide-surface-hi rounded-lg border border-surface-hi bg-surface">
            {payees.map((p) => (
              <PayeeRow
                key={p.id}
                payee={p}
                onEdit={() => setEditingId(p.id)}
                onRemove={() => removePayee(p.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PayeeRow({
  payee,
  onEdit,
  onRemove,
}: {
  payee: PayeeProfile;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="space-y-1 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={payee.active ? "font-medium text-fg" : "text-fg-muted line-through"}>
            {payee.displayName}
          </span>
          {!payee.active ? (
            <span className="rounded-full bg-surface-hi px-2 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">
              inactive
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="tabular-nums text-xs text-fg-muted">
            {formatFiat(payee.salaryFiat)} · {payee.preferredAsset} on{" "}
            <span className="text-fg">{networkLabel(payee.preferredChain)}</span>
          </span>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs text-fg-muted hover:text-fg"
          >
            edit
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs text-fg-muted hover:bg-danger/30 hover:text-fg"
          >
            remove
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2 font-mono text-[11px] text-fg-muted">
        <span className="flex-1 break-all">{payee.walletAddress}</span>
        <CopyButton value={payee.walletAddress} label="address" title="Copy address" />
      </div>
    </li>
  );
}

interface DraftValidation {
  ok: boolean;
  error: string;
  salaryFiat: FiatAmount;
}

function validateDraft(d: DraftPayee): DraftValidation {
  if (!d.displayName.trim()) return fail("Display name required");
  const salaryFiat = parseFiat(d.salaryFiatAmount, d.salaryFiatCurrency);
  if (!salaryFiat) return fail("Salary must be a positive number");
  if (!d.walletAddress.trim()) return fail("Wallet address required");
  const addr = d.walletAddress.trim();
  if (d.preferredChain.startsWith("ckb:") && !/^ck[bt]1[0-9a-z]+$/.test(addr)) {
    return fail("CKB address must start with ckb1/ckt1 and be bech32-shaped");
  }
  return { ok: true, error: "", salaryFiat };
}

function fail(error: string): DraftValidation {
  return { ok: false, error, salaryFiat: { currency: "USD", minor: 0n } };
}

function parseFiat(amountText: string, currency: string): FiatAmount | null {
  const s = amountText.trim();
  if (!s) return null;
  const m = s.match(/^(\d+)(?:\.(\d{0,4}))?$/);
  if (!m) return null;
  const whole = BigInt(m[1] ?? "0");
  const fracRaw = (m[2] ?? "").padEnd(2, "0").slice(0, 2);
  const minor = whole * 100n + BigInt(fracRaw || "0");
  if (minor <= 0n) return null;
  return { currency, minor };
}

function fiatAmountToText(fa: FiatAmount): string {
  const minor = fa.minor;
  const whole = minor / 100n;
  const frac = (minor % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${frac}`;
}

function formatFiat(fa: FiatAmount): string {
  return `${fiatAmountToText(fa)} ${fa.currency}`;
}

function networkLabel(chain: ChainId): string {
  if (chain === "ckb:testnet") return "CKB Testnet";
  if (chain === "ckb:mainnet") return "CKB Mainnet";
  return chain;
}
