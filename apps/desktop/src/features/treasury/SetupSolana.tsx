import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { SolanaChain, SolanaWatchTreasury } from "@chain-pay/shared";
import { parseSolanaAddress } from "@/lib/chains/sol/address";
import { useTreasuryStore } from "@/stores/treasury";

export function SetupSolana() {
  const [label, setLabel] = useState("");
  const [chain, setChain] = useState<SolanaChain>("sol:devnet");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const addTreasury = useTreasuryStore((state) => state.addTreasury);
  const navigate = useNavigate();

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    setError(null);
    try {
      if (!label.trim()) throw new Error("Treasury label is required");
      const publicAddress = parseSolanaAddress(address, chain);
      const now = new Date().toISOString();
      const treasury: SolanaWatchTreasury = {
        id: crypto.randomUUID(),
        kind: "solana-watch",
        label: label.trim(),
        watch: { chain, address: publicAddress },
        createdAt: now,
        updatedAt: now,
      };
      addTreasury(treasury);
      navigate(`/treasury/${treasury.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <Link to="/treasury" className="text-xs text-fg-muted hover:text-fg">← Treasury</Link>
        <h1 className="mt-1 text-2xl font-semibold">Add Solana watch-only treasury</h1>
        <p className="text-sm text-fg-muted">Monitor exact lamport balances and transaction status without signing access.</p>
      </header>
      <div className="rounded-md border border-accent/40 bg-accent/5 p-3 text-sm text-fg-muted">
        Paste only a public account address. Seed phrases, keypair files, and private keys are not accepted or persisted.
      </div>
      <form onSubmit={submit} className="space-y-5">
        <Field label="Label"><input aria-label="Label" value={label} onChange={(event) => setLabel(event.target.value)} className={inputCls} /></Field>
        <Field label="Network">
          <select aria-label="Network" value={chain} onChange={(event) => setChain(event.target.value as SolanaChain)} className={inputCls}>
            <option value="sol:devnet">Solana devnet</option>
            <option value="sol:mainnet">Solana mainnet</option>
          </select>
        </Field>
        <Field label="Public account address">
          <textarea aria-label="Public account address" value={address} onChange={(event) => setAddress(event.target.value)} rows={2} spellCheck={false} placeholder="Base58 public address" className={`${inputCls} font-mono text-xs`} />
        </Field>
        {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Link to="/treasury" className="rounded-md border border-surface-hi px-4 py-2 text-sm text-fg-muted">Cancel</Link>
          <button type="submit" disabled={!label.trim() || !address.trim()} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-40">Validate and add</button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1 text-sm"><span className="font-medium">{label}</span>{children}</label>;
}

const inputCls = "w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm text-fg";
