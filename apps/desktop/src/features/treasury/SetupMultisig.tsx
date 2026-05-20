import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CkbMultisig, Hex20, Treasury } from "@chain-pay/shared";
import { useTreasuryStore } from "@/stores/treasury";
import { deriveTreasuryAddress } from "@/lib/chains/ckb/address";
import type { CkbMultisigConfig } from "@/lib/chains/ckb/multisig";
import type { CkbNetwork } from "@/lib/light-client/network-configs";

const HEX20_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_N = 8;

interface FormState {
  label: string;
  network: CkbNetwork;
  m: number;
  n: number;
  pubkeyHashes: string[];
}

const initialState: FormState = {
  label: "",
  network: "testnet",
  m: 2,
  n: 3,
  pubkeyHashes: ["", "", ""],
};

export function SetupMultisig() {
  const [form, setForm] = useState<FormState>(initialState);
  const addTreasury = useTreasuryStore((s) => s.addTreasury);
  const navigate = useNavigate();

  const validation = useMemo(() => validateForm(form), [form]);
  const derivedAddress = useMemo(() => {
    if (!validation.config) return null;
    try {
      return deriveTreasuryAddress(validation.config, form.network);
    } catch {
      return null;
    }
  }, [validation.config, form.network]);

  const updateN = (n: number) => {
    const clamped = Math.max(1, Math.min(MAX_N, n));
    setForm((s) => ({
      ...s,
      n: clamped,
      m: Math.min(s.m, clamped),
      pubkeyHashes: resizeHashes(s.pubkeyHashes, clamped),
    }));
  };

  const updateHash = (i: number, value: string) => {
    setForm((s) => ({
      ...s,
      pubkeyHashes: s.pubkeyHashes.map((h, idx) => (idx === i ? value : h)),
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validation.config || !derivedAddress || !form.label.trim()) return;
    const now = new Date().toISOString();
    const multisig: CkbMultisig = {
      chain: form.network === "mainnet" ? "ckb:mainnet" : "ckb:testnet",
      s: 0,
      r: 0,
      m: validation.config.m,
      n: validation.config.n,
      pubkeyHashes: validation.config.pubkeyHashes,
      address: derivedAddress,
    };
    const treasury: Treasury = {
      id: crypto.randomUUID(),
      label: form.label.trim(),
      multisig,
      createdAt: now,
      updatedAt: now,
    };
    addTreasury(treasury);
    navigate("/treasury");
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">New CKB multisig treasury</h1>
        <p className="text-sm text-fg-muted">
          M-of-N treasury using <code className="text-fg">secp256k1_blake160_multisig_all</code>.
          The address is derived from the pubkey hash set — fund it after creation.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Label">
          <input
            type="text"
            value={form.label}
            onChange={(e) => setForm((s) => ({ ...s, label: e.target.value }))}
            placeholder="e.g. Payroll treasury"
            className={inputCls}
          />
        </Field>

        <Field label="Network">
          <div className="flex gap-2">
            {(["testnet", "mainnet"] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setForm((s) => ({ ...s, network: n }))}
                className={`flex-1 rounded-md border px-3 py-2 text-sm capitalize transition-colors ${
                  form.network === n
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-surface-hi bg-surface text-fg-muted hover:text-fg"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Threshold (M)" hint={`signatures needed to spend (≤ N = ${form.n})`}>
            <input
              type="number"
              min={1}
              max={form.n}
              value={form.m}
              onChange={(e) =>
                setForm((s) => ({ ...s, m: Math.max(1, Math.min(s.n, Number(e.target.value) || 1)) }))
              }
              className={inputCls}
            />
          </Field>
          <Field label="Total signers (N)" hint={`1 – ${MAX_N}`}>
            <input
              type="number"
              min={1}
              max={MAX_N}
              value={form.n}
              onChange={(e) => updateN(Number(e.target.value) || 1)}
              className={inputCls}
            />
          </Field>
        </div>

        <Field
          label="Co-signer pubkey hashes"
          hint="blake160 of each signer's secp256k1 pubkey — 0x + 40 hex chars"
        >
          <div className="space-y-2">
            {form.pubkeyHashes.map((hash, i) => {
              const isValid = !hash || HEX20_RE.test(hash);
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-6 text-xs text-fg-muted tabular-nums">{i + 1}.</span>
                  <input
                    type="text"
                    value={hash}
                    onChange={(e) => updateHash(i, e.target.value)}
                    placeholder="0x…"
                    spellCheck={false}
                    className={`${inputCls} font-mono text-xs ${
                      !isValid ? "border-danger/70 focus:border-danger" : ""
                    }`}
                  />
                </div>
              );
            })}
          </div>
        </Field>

        <div className="rounded-lg border border-surface-hi bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-fg-muted">Derived treasury address</div>
          <div className="mt-2 break-all font-mono text-xs">
            {derivedAddress ? (
              <span className="text-accent">{derivedAddress}</span>
            ) : (
              <span className="text-fg-muted">— fill in all pubkey hashes to preview —</span>
            )}
          </div>
          {validation.errors.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs text-danger">
              {validation.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => navigate("/treasury")}
            className="rounded-md border border-surface-hi bg-surface px-4 py-2 text-sm text-fg-muted hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!derivedAddress || !form.label.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Create treasury
          </button>
        </div>
      </form>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-medium">{label}</span>
        {hint ? <span className="text-xs text-fg-muted">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

function resizeHashes(current: string[], n: number): string[] {
  if (current.length === n) return current;
  if (current.length > n) return current.slice(0, n);
  return [...current, ...Array(n - current.length).fill("")];
}

function validateForm(form: FormState): {
  config: CkbMultisigConfig | null;
  errors: string[];
} {
  const errors: string[] = [];
  if (form.m < 1) errors.push("M must be at least 1");
  if (form.m > form.n) errors.push(`M (${form.m}) cannot exceed N (${form.n})`);
  if (form.n > MAX_N) errors.push(`N cannot exceed ${MAX_N} in this wizard`);

  const trimmed = form.pubkeyHashes.map((h) => h.trim());
  trimmed.forEach((h, i) => {
    if (!h) errors.push(`Pubkey hash ${i + 1} is required`);
    else if (!HEX20_RE.test(h)) errors.push(`Pubkey hash ${i + 1} must be 0x + 40 hex chars`);
  });

  const uniqueCount = new Set(trimmed.filter(Boolean).map((h) => h.toLowerCase())).size;
  if (uniqueCount > 0 && uniqueCount !== trimmed.filter(Boolean).length) {
    errors.push("Pubkey hashes must be unique");
  }

  if (errors.length > 0) return { config: null, errors };

  return {
    config: {
      s: 0,
      r: 0,
      m: form.m,
      n: form.n,
      pubkeyHashes: trimmed as Hex20[],
    },
    errors: [],
  };
}
