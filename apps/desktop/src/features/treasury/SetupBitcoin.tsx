import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type {
  BitcoinAddressScriptType,
  BitcoinChain,
  BitcoinDerivedScriptType,
  BitcoinWatchTreasury,
} from "@chain-pay/shared";
import { useTreasuryStore } from "@/stores/treasury";
import {
  DEFAULT_BITCOIN_GAP_LIMIT,
  parseBitcoinWatchImport,
  type BitcoinWatchImport,
} from "@/lib/chains/btc/watch-source";

type SourceKind = BitcoinWatchImport["kind"];

export function SetupBitcoin() {
  const [label, setLabel] = useState("");
  const [chain, setChain] = useState<BitcoinChain>("btc:testnet");
  const [kind, setKind] = useState<SourceKind>("address");
  const [value, setValue] = useState("");
  const [scriptType, setScriptType] = useState<BitcoinAddressScriptType | BitcoinDerivedScriptType>("p2wpkh");
  const [gapLimit, setGapLimit] = useState(String(DEFAULT_BITCOIN_GAP_LIMIT));
  const [error, setError] = useState<string | null>(null);
  const addTreasury = useTreasuryStore((state) => state.addTreasury);
  const navigate = useNavigate();

  const scriptOptions = useMemo(
    () =>
      kind === "address"
        ? (["p2wpkh", "p2tr", "p2sh", "p2wsh", "p2pkh"] as BitcoinAddressScriptType[])
        : (["p2wpkh", "p2tr", "p2sh-p2wpkh", "p2pkh"] as BitcoinDerivedScriptType[]),
    [kind],
  );

  function changeKind(next: SourceKind): void {
    setKind(next);
    setValue("");
    setScriptType("p2wpkh");
    setError(null);
  }

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault();
    setError(null);
    try {
      if (!label.trim()) throw new Error("Treasury label is required");
      const parsedGap = Number(gapLimit);
      const input: BitcoinWatchImport =
        kind === "address"
          ? { kind, value: value.trim(), chain, scriptType: scriptType as BitcoinAddressScriptType }
          : kind === "descriptor"
            ? {
                kind,
                value: value.trim(),
                chain,
                scriptType: scriptType as BitcoinDerivedScriptType,
                gapLimit: parsedGap,
              }
            : {
                kind,
                value: value.trim(),
                chain,
                scriptType: scriptType as BitcoinDerivedScriptType,
                derivationPath: [0],
                gapLimit: parsedGap,
              };
      const watch = parseBitcoinWatchImport(input);
      const now = new Date().toISOString();
      const treasury: BitcoinWatchTreasury = {
        id: crypto.randomUUID(),
        kind: "bitcoin-watch",
        label: label.trim(),
        watch,
        createdAt: now,
        updatedAt: now,
      };
      addTreasury(treasury);
      navigate(`/treasury/${treasury.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const sourceLabel =
    kind === "address" ? "Bitcoin address" : kind === "descriptor" ? "Output descriptor" : "Account xpub";
  const placeholder =
    kind === "address"
      ? chain === "btc:mainnet"
        ? "bc1q…"
        : "tb1q…"
      : kind === "descriptor"
        ? "wpkh([fingerprint/84h/1h/0h]tpub…/0/*)#checksum"
        : chain === "btc:mainnet"
          ? "xpub… / zpub…"
          : "tpub… / vpub…";

  return (
    <div className="space-y-6">
      <header>
        <Link to="/treasury" className="text-xs text-fg-muted hover:text-fg">← Treasury</Link>
        <h1 className="mt-1 text-2xl font-semibold">Add Bitcoin watch-only treasury</h1>
        <p className="text-sm text-fg-muted">
          Monitor balances and activity without importing any signing secret.
        </p>
      </header>

      <div className="rounded-md border border-accent/40 bg-accent/5 p-3 text-sm text-fg-muted">
        Paste only a public address, output descriptor, or extended public key. Never paste a seed
        phrase, WIF, xprv, or other private key. ChainPay will reject and never persist private material.
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Label">
          <input aria-label="Label" value={label} onChange={(event) => setLabel(event.target.value)} className={inputCls} />
        </Field>
        <Field label="Network">
          <select aria-label="Network" value={chain} onChange={(event) => setChain(event.target.value as BitcoinChain)} className={inputCls}>
            <option value="btc:testnet">Bitcoin testnet</option>
            <option value="btc:mainnet">Bitcoin mainnet</option>
          </select>
        </Field>
        <Field label="Watch source">
          <div className="grid grid-cols-3 gap-2">
            {(["address", "descriptor", "xpub"] as SourceKind[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => changeKind(option)}
                className={`rounded-md border px-3 py-2 text-sm ${kind === option ? "border-accent bg-accent/10 text-accent" : "border-surface-hi text-fg-muted"}`}
              >
                {option === "xpub" ? "Account xpub" : option[0]?.toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Script type" hint="Must match the address, descriptor, and extended-key version">
          <select aria-label="Script type" value={scriptType} onChange={(event) => setScriptType(event.target.value as BitcoinAddressScriptType | BitcoinDerivedScriptType)} className={inputCls}>
            {scriptOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </Field>
        <Field label={sourceLabel} hint={kind === "xpub" ? "ChainPay derives only the non-hardened external branch /0/*" : undefined}>
          <textarea
            aria-label={sourceLabel}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            rows={kind === "address" ? 2 : 4}
            className={`${inputCls} font-mono text-xs`}
          />
        </Field>
        {kind !== "address" ? (
          <Field label="Gap limit" hint="Consecutive unused receive addresses required to finish discovery">
            <input aria-label="Gap limit" type="number" min={1} max={1000} value={gapLimit} onChange={(event) => setGapLimit(event.target.value)} className={inputCls} />
          </Field>
        ) : null}

        {error ? <div role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <Link to="/treasury" className="rounded-md border border-surface-hi px-4 py-2 text-sm text-fg-muted">Cancel</Link>
          <button type="submit" disabled={!label.trim() || !value.trim()} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-40">
            Validate and add
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string | undefined; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      {hint ? <span className="ml-2 text-xs text-fg-muted">{hint}</span> : null}
      {children}
    </label>
  );
}

const inputCls = "w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm text-fg";
