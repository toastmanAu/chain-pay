import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatEther, parseEther } from "viem";
import { isMultisigTreasury, type EvmMultisig } from "@chain-pay/shared";
import { useTreasuryStore } from "@/stores/treasury";
import { usePendingTransactionsStore } from "@/stores/pending-transactions";
import { buildNativeSafePayment, type SafeConfig } from "@/lib/chains/evm/safe";
import { readSafeSnapshot } from "@/lib/chains/evm/safe-reader";
import { pendingSafePayment } from "@/lib/chains/evm/pending-safe-payment";

export function CreateSafePayment() {
  const { treasuryId } = useParams<{ treasuryId: string }>();
  const treasury = useTreasuryStore((state) =>
    state.treasuries.find((candidate) => candidate.id === treasuryId),
  );
  const addTransaction = usePendingTransactionsStore((state) => state.addTransaction);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [payeeId, setPayeeId] = useState("");
  const [fiatValue, setFiatValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  if (!treasury || !isMultisigTreasury(treasury) || !treasury.multisig.chain.startsWith("evm:")) {
    return <MissingTreasury />;
  }
  const multisig = treasury.multisig as EvmMultisig;
  const chainId = Number(multisig.chain.slice("evm:".length));

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const valueWei = parsePositiveEth(amount);
      const fiatMinor = parsePositiveUsd(fiatValue);
      const accountingPayeeId = parsePayeeId(payeeId);
      const snapshot = await readSafeSnapshot(chainId, multisig.address);
      if (valueWei > snapshot.balanceWei) {
        throw new Error(`Safe balance is ${formatEther(snapshot.balanceWei)} ETH`);
      }
      const cfg: SafeConfig = {
        chainId,
        address: multisig.address,
        owners: multisig.owners,
        threshold: multisig.threshold,
        version: multisig.version,
      };
      const built = await buildNativeSafePayment(cfg, recipient.trim(), valueWei);
      const pending = pendingSafePayment({
        id: crypto.randomUUID(),
        treasury,
        payload: built.payload,
        signingDigest: built.signingDigest,
        accounting: {
          payeeId: accountingPayeeId,
          fiat: { currency: "USD", minor: fiatMinor },
        },
      });
      addTransaction(pending);
      navigate(`/approvals/${pending.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <Link to={`/treasury/${treasury.id}`} className="text-xs text-fg-muted hover:text-fg">
          ← {treasury.label}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">New Safe payment</h1>
        <p className="text-sm text-fg-muted">
          Build one native-ETH transfer on Sepolia. You will review the canonical Safe transaction
          before asking an owner wallet to sign.
        </p>
      </header>

      <section className="rounded-lg border border-surface-hi bg-surface p-4 text-sm">
        <div className="text-xs uppercase tracking-wide text-fg-muted">From</div>
        <div className="mt-1 font-medium">{treasury.label}</div>
        <div className="mt-1 break-all font-mono text-xs text-fg-muted">{multisig.address}</div>
        <div className="mt-2 text-xs text-fg-muted">
          Sepolia · {multisig.threshold}-of-{multisig.owners.length} · Safe v{multisig.version}
        </div>
      </section>

      <form onSubmit={(event) => void handleCreate(event)} className="space-y-5">
        <Field label="Recipient">
          <input
            aria-label="Recipient"
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            placeholder="0x…"
            spellCheck={false}
            className={`${inputCls} font-mono`}
          />
        </Field>
        <Field label="Amount" hint="ETH · up to 18 decimal places">
          <input
            aria-label="Amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="0.01"
            className={inputCls}
          />
        </Field>
        <Field label="Payee / accounting reference" hint="Stored with the immutable source record">
          <input
            aria-label="Payee / accounting reference"
            value={payeeId}
            onChange={(event) => setPayeeId(event.target.value)}
            placeholder="vendor-1"
            className={inputCls}
          />
        </Field>
        <Field label="Accounting value" hint="USD · used for the server-derived Journal Entry">
          <input
            aria-label="Accounting value"
            value={fiatValue}
            onChange={(event) => setFiatValue(event.target.value)}
            inputMode="decimal"
            placeholder="25.00"
            className={inputCls}
          />
        </Field>

        {error ? (
          <div role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
            {error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Link
            to={`/treasury/${treasury.id}`}
            className="rounded-md border border-surface-hi bg-surface px-4 py-2 text-sm text-fg-muted hover:text-fg"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={!recipient.trim() || !amount.trim() || !payeeId.trim() || !fiatValue.trim() || busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Building SafeTx…" : "Build and review"}
          </button>
        </div>
      </form>
    </div>
  );
}

function parsePositiveUsd(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("Enter a valid USD amount with at most 2 decimal places");
  const minor = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (minor <= 0n) throw new Error("Accounting value must be greater than zero");
  return minor;
}

function parsePayeeId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 140) {
    throw new Error("Payee / accounting reference must be 1–140 characters");
  }
  return trimmed;
}

function parsePositiveEth(value: string): bigint {
  let wei: bigint;
  try {
    wei = parseEther(value.trim());
  } catch {
    throw new Error("Enter a valid ETH amount with at most 18 decimal places");
  }
  if (wei <= 0n) throw new Error("Payment amount must be greater than zero");
  return wei;
}

function MissingTreasury() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Sepolia Safe not found</h1>
      <Link to="/treasury" className="text-sm text-accent hover:underline">
        Return to treasury list
      </Link>
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
