import { useEffect, useState } from "react";
import { Address, ClientPublicTestnet } from "@ckb-ccc/core";
import { lightClient } from "../../../lib/light-client/client";

interface FundingStepProps {
  address: string;
  onFunded: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

const REQUIRED_SHANNONS = 70n * 100_000_000n;
const REQUIRED_CKB = 70;
const POLL_INTERVAL_MS = 5_000;

export function FundingStep({ address, onFunded, onCancel }: FundingStepProps) {
  const [balanceShannons, setBalanceShannons] = useState<bigint | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [hasTriggered, setHasTriggered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Lightweight CCC client used only to parse the bech32 address into a
    // lock script — no network calls.
    const parser = new ClientPublicTestnet();

    async function pollOnce(): Promise<void> {
      try {
        const lock = (await Address.fromString(address, parser)).script;
        const cap = await lightClient().getLockBalance(lock);
        if (cancelled) return;
        setBalanceShannons(cap);
        setPollError(null);
        if (cap >= REQUIRED_SHANNONS && !hasTriggered) {
          setHasTriggered(true);
          void onFunded();
        }
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : "balance poll failed");
      }
    }

    void pollOnce();
    const interval = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [address, onFunded, hasTriggered]);

  function copyAddress(): void {
    void navigator.clipboard.writeText(address);
  }

  const balanceCkb =
    balanceShannons === null ? null : Number(balanceShannons / 100_000_000n);

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        Fund this address with at least {REQUIRED_CKB} CKB. Once funded, the profile cell will be
        published automatically and the comm channel will start.
      </p>
      <div className="rounded-lg border border-surface-hi bg-surface p-4">
        <div className="text-xs uppercase tracking-wide text-fg-muted">Comm channel address</div>
        <div className="mt-2 break-all font-mono text-xs text-accent">{address}</div>
        <button
          type="button"
          onClick={copyAddress}
          className="mt-3 rounded-md border border-surface-hi bg-bg px-2 py-1 text-xs"
        >
          Copy address
        </button>
      </div>
      <div className="rounded-lg border border-surface-hi bg-surface p-4 text-sm">
        <span className="text-fg-muted">Balance:</span>{" "}
        <span className="font-mono">
          {balanceCkb === null ? "—" : `${balanceCkb} / ${REQUIRED_CKB} CKB`}
        </span>
        {pollError && <span className="ml-2 text-warn"> · {pollError}</span>}
      </div>
      <button
        type="button"
        onClick={() => void onCancel()}
        className="rounded-md border border-surface-hi bg-bg px-3 py-1 text-xs text-fg-muted"
      >
        Cancel setup (delete identity)
      </button>
    </div>
  );
}
