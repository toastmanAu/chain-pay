import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { isMultisigTreasury, type EvmMultisig, type Treasury } from "@chain-pay/shared";
import { readSafeSnapshot } from "@/lib/chains/evm/safe-reader";
import { useTreasuryStore } from "@/stores/treasury";

const SEPOLIA_CHAIN_ID = 11155111;

export function SetupSafe() {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const addTreasury = useTreasuryStore((state) => state.addTreasury);
  const treasuries = useTreasuryStore((state) => state.treasuries);
  const navigate = useNavigate();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!label.trim() || !address.trim() || checking) return;
    setChecking(true);
    setError(null);
    try {
      const snapshot = await readSafeSnapshot(SEPOLIA_CHAIN_ID, address.trim());
      const duplicate = treasuries.some(
        (treasury) =>
          isMultisigTreasury(treasury) &&
          treasury.multisig.chain === `evm:${SEPOLIA_CHAIN_ID}` &&
          treasury.multisig.address.toLowerCase() === snapshot.address.toLowerCase(),
      );
      if (duplicate) throw new Error("This Safe is already in your treasury list");

      const now = new Date().toISOString();
      const multisig: EvmMultisig = {
        chain: `evm:${SEPOLIA_CHAIN_ID}`,
        address: snapshot.address,
        owners: snapshot.owners,
        threshold: snapshot.threshold,
        version: snapshot.version,
      };
      const treasury: Treasury = {
        id: crypto.randomUUID(),
        label: label.trim(),
        multisig,
        createdAt: now,
        updatedAt: now,
      };
      addTreasury(treasury);
      navigate(`/treasury/${treasury.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <Link to="/treasury" className="text-xs text-fg-muted hover:text-fg">
          ← Treasury
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Add a Sepolia Safe</h1>
        <p className="text-sm text-fg-muted">
          Import an existing Safe contract. ChainPay reads its owners, threshold, version, and
          balance directly from Sepolia before saving it.
        </p>
      </header>

      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5">
        <Field label="Label">
          <input
            aria-label="Label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. Sepolia payroll Safe"
            className={inputCls}
          />
        </Field>
        <Field label="Network" hint="execution/signing follows in the next slice">
          <div className="rounded-md border border-accent bg-accent/10 px-3 py-2 text-sm text-accent">
            Sepolia · chain ID {SEPOLIA_CHAIN_ID}
          </div>
        </Field>
        <Field label="Safe contract address" hint="0x + 40 hex characters">
          <input
            aria-label="Safe contract address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="0x…"
            spellCheck={false}
            className={`${inputCls} font-mono`}
          />
        </Field>

        {error ? (
          <div role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
            {error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Link
            to="/treasury"
            className="rounded-md border border-surface-hi bg-surface px-4 py-2 text-sm text-fg-muted hover:text-fg"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={!label.trim() || !address.trim() || checking}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {checking ? "Checking Safe…" : "Verify and add Safe"}
          </button>
        </div>
      </form>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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
