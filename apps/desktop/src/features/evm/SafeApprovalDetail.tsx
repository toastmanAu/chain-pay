import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatEther, type Hex } from "viem";
import { useQuery } from "@tanstack/react-query";
import type { EvmMultisig } from "@chain-pay/shared";
import { usePendingTransactionsStore } from "@/stores/pending-transactions";
import { useTreasuryStore } from "@/stores/treasury";
import { parseSafePayment } from "@/lib/chains/evm/safe";
import { MetaMaskSafeOwnerSigner } from "@/lib/signers/metamask-safe-owner";
import { executeSafePayment } from "@/lib/chains/evm/safe-executor";
import { readEvmExecutionStatus } from "@/lib/chains/evm/execution-status";
import { postConfirmedSafePayment } from "@/lib/accounting/evm-safe-accounting";

export function SafeApprovalDetail() {
  const { id } = useParams<{ id: string }>();
  const pending = usePendingTransactionsStore((state) =>
    state.transactions.find((transaction) => transaction.id === id),
  );
  const treasury = useTreasuryStore((state) =>
    state.treasuries.find((candidate) => candidate.id === pending?.treasuryId),
  );
  const recordSignature = usePendingTransactionsStore((state) => state.recordEvmSignature);
  const markBroadcasted = usePendingTransactionsStore((state) => state.markBroadcasted);
  const markConfirming = usePendingTransactionsStore((state) => state.markConfirming);
  const markConfirmed = usePendingTransactionsStore((state) => state.markConfirmed);
  const markFailed = usePendingTransactionsStore((state) => state.markFailed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const payloadResult = useMemo(() => {
    if (!pending) return null;
    try {
      return { payload: parseSafePayment(pending.payloadJson), error: null };
    } catch (caught) {
      return { payload: null, error: caught instanceof Error ? caught.message : String(caught) };
    }
  }, [pending]);
  const confirmationQuery = useQuery({
    queryKey: ["safe-execution", pending?.broadcastedHash],
    queryFn: () =>
      readEvmExecutionStatus(11155111, pending!.broadcastedHash as Hex),
    enabled:
      pending?.state === "confirming" &&
      pending.broadcastedHash !== undefined,
    refetchInterval: 5_000,
  });

  useEffect(() => {
    if (!pending || pending.state !== "confirming" || !confirmationQuery.data) return;
    if (confirmationQuery.data.state === "confirmed") {
      markConfirmed(pending.id, confirmationQuery.data);
    } else if (confirmationQuery.data.state === "failed") {
      markFailed(pending.id, confirmationQuery.data.reason);
    }
  }, [confirmationQuery.data, markConfirmed, markFailed, pending]);

  if (!pending || !treasury || !treasury.multisig.chain.startsWith("evm:")) {
    return <MissingApproval />;
  }
  if (!payloadResult?.payload) {
    return <InvalidApproval message={payloadResult?.error ?? "Safe payment payload is missing"} />;
  }
  const payload = payloadResult.payload;
  const multisig = treasury.multisig as EvmMultisig;

  const handleApprove = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const transport = new MetaMaskSafeOwnerSigner();
      if (!(await transport.isAvailable())) throw new Error("No injected EVM wallet found");
      const signature = await transport.sign({
        chain: pending.chain,
        digest: pending.signingDigest,
        context: { pending, multisig },
      });
      const added = recordSignature(
        pending.id,
        { ...signature, signedAt: Date.now() },
        multisig,
      );
      setNotice(
        added
          ? `Approval recorded from ${signature.signerHash}`
          : "This owner already approved the payment",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleExecute = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const hash = await executeSafePayment(pending, multisig);
      markBroadcasted(pending.id, hash);
      markConfirming(pending.id);
      setNotice(`Safe execution submitted: ${hash}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <Link to="/approvals" className="text-xs text-fg-muted hover:text-fg">
          ← Approvals
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Review Safe payment</h1>
        <p className="text-sm text-fg-muted">
          Verify every field below before asking your wallet to sign the canonical EIP-712 SafeTx.
        </p>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Tile label="Amount" value={`${formatEther(BigInt(payload.tx.value))} ETH`} />
        <Tile label="Approvals" value={`${pending.signatures.length} / ${multisig.threshold}`} />
        <Tile label="Safe nonce" value={String(payload.tx.nonce)} />
      </section>

      <section className="space-y-4 rounded-lg border border-surface-hi bg-surface p-5">
        <ReviewRow label="Network" value="Sepolia · chain ID 11155111" />
        <ReviewRow label="From Safe" value={payload.safeAddress} mono />
        <ReviewRow label="Recipient" value={payload.tx.to} mono />
        <ReviewRow label="Value (wei)" value={payload.tx.value} mono />
        <ReviewRow label="Operation" value="CALL (0)" />
        <ReviewRow label="Calldata" value={payload.tx.data} mono />
        <ReviewRow label="Safe version" value={payload.safeVersion} />
        <ReviewRow label="SafeTx hash" value={pending.signingDigest} mono />
        {pending.accounting ? (
          <>
            <ReviewRow label="Payee reference" value={pending.accounting.payeeId} />
            <ReviewRow
              label="Accounting value"
              value={`${(pending.accounting.fiat.minor / 100n).toString()}.${(pending.accounting.fiat.minor % 100n).toString().padStart(2, "0")} ${pending.accounting.fiat.currency}`}
            />
          </>
        ) : null}
      </section>

      {pending.signatures.length > 0 ? (
        <section className="rounded-lg border border-surface-hi bg-surface p-5">
          <h2 className="text-sm font-medium">Recorded owner approvals</h2>
          <ul className="mt-3 space-y-2">
            {pending.signatures.map((signature) => (
              <li key={signature.signerHash} className="font-mono text-xs text-fg-muted">
                {signature.signerHash}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {pending.state === "ready_to_broadcast" ? (
        <div className="space-y-3 rounded-md border border-accent/40 bg-accent/5 p-4 text-sm">
          <p className="text-accent">Signature threshold met. The connected owner wallet will pay Sepolia execution gas.</p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleExecute()}
              disabled={busy}
              className="rounded-md bg-accent px-4 py-2 font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "Waiting for wallet…" : "Execute on Sepolia"}
            </button>
          </div>
        </div>
      ) : pending.state === "broadcasted" || pending.state === "confirming" ? (
        <ExecutionStatus
          label="Confirming on Sepolia"
          hash={pending.broadcastedHash}
          detail={confirmationQuery.error ? (confirmationQuery.error as Error).message : "Polling for transaction receipt…"}
        />
      ) : pending.state === "confirmed" || pending.state === "posting" ? (
        <ExecutionStatus
          label={pending.state === "posting" ? "Posting to ERPNext" : "Confirmed"}
          hash={pending.broadcastedHash}
          detail={
            pending.state === "posting"
              ? "The immutable confirmed-payment record and server-derived Journal Entry are being posted."
              : `Included in block ${pending.confirmedBlockNumber ?? "—"}`
          }
          success
        />
      ) : pending.state === "posted" ? (
        <ExecutionStatus
          label="Posted"
          hash={pending.broadcastedHash}
          detail={`ERPNext Journal Entry ${pending.journalEntryName ?? "—"}`}
          success
        />
      ) : pending.state === "post_failed" ? (
        <div className="space-y-3 rounded-md border border-danger/40 bg-danger/5 p-4 text-sm">
          <p role="alert" className="text-danger">{pending.postError ?? "ERPNext accounting post failed"}</p>
          <p className="text-xs text-fg-muted">The Safe payment is already confirmed. Retry only re-posts accounting and cannot execute it again.</p>
          <button
            type="button"
            onClick={() => void postConfirmedSafePayment(pending.id)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg"
          >
            Retry accounting
          </button>
        </div>
      ) : pending.state === "failed" ? (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          {pending.failureReason ?? "Safe execution failed"}
        </div>
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void handleApprove()}
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Waiting for wallet…" : "Connect owner wallet and approve"}
          </button>
        </div>
      )}

      {notice ? <p role="status" className="text-sm text-accent">{notice}</p> : null}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}

function ExecutionStatus({
  label,
  hash,
  detail,
  success = false,
}: {
  label: string;
  hash?: string | undefined;
  detail: string;
  success?: boolean;
}) {
  return (
    <div className={`rounded-md border p-4 text-sm ${success ? "border-accent/40 bg-accent/5" : "border-warn/40 bg-warn/5"}`}>
      <div className="font-medium">{label}</div>
      {hash ? <div className="mt-2 break-all font-mono text-xs">{hash}</div> : null}
      <div className="mt-2 text-xs text-fg-muted">{detail}</div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-surface-hi bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{label}</div>
      <div className="mt-2 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function ReviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-4 text-sm">
      <div className="text-fg-muted">{label}</div>
      <div className={`break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</div>
    </div>
  );
}

function MissingApproval() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Approval not found</h1>
      <Link to="/approvals" className="text-sm text-accent hover:underline">Return to approvals</Link>
    </div>
  );
}

function InvalidApproval({ message }: { message: string }) {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">Invalid saved approval</h1>
      <p role="alert" className="text-sm text-danger">{message}</p>
      <Link to="/approvals" className="text-sm text-accent hover:underline">Return to approvals</Link>
    </div>
  );
}
