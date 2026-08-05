import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  isSolanaWatchTreasury,
  type SolanaPaymentConfig,
  type SolanaSignatureEnvelope,
  type SolanaWatchTreasury,
} from "@chain-pay/shared";
import { solanaBridge } from "@/lib/chains/sol/ipc";
import { parseSolanaAddress } from "@/lib/chains/sol/address";
import { useSolanaPaymentsStore } from "@/stores/solana-payments";
import { useTreasuryStore } from "@/stores/treasury";

const MAX_SIGNATURE_ENVELOPE_BYTES = 2_048;

export function CreateSolanaPayment() {
  const { treasuryId } = useParams<{ treasuryId: string }>();
  const treasury = useTreasuryStore((state) => state.treasuries.find((item) => item.id === treasuryId));
  if (!treasury || !isSolanaWatchTreasury(treasury)) return <p role="alert">Solana treasury not found.</p>;
  return treasury.payment
    ? <SolanaPaymentWorkflow treasury={treasury} payment={treasury.payment} />
    : <ConfigureSolanaPayment treasury={treasury} />;
}

function ConfigureSolanaPayment({ treasury }: { treasury: SolanaWatchTreasury }) {
  const [nonceAccount, setNonceAccount] = useState("");
  const [nonceAuthority, setNonceAuthority] = useState("");
  const [feePayer, setFeePayer] = useState(treasury.watch.address);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const configure = useTreasuryStore((state) => state.configureSolanaPayment);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setChecking(true);
    try {
      const config = {
        nonceAccount: parseSolanaAddress(nonceAccount, treasury.watch.chain),
        nonceAuthority: parseSolanaAddress(nonceAuthority, treasury.watch.chain),
        feePayer: parseSolanaAddress(feePayer, treasury.watch.chain),
      };
      await solanaBridge().paymentInspect({ chain: treasury.watch.chain, source: treasury.watch.address, ...config });
      configure(treasury.id, config);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-6">
      <Header treasuryId={treasury.id} title="Configure durable-nonce payments" />
      <Notice />
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <PublicKeyField label="Existing nonce account" value={nonceAccount} setValue={setNonceAccount} />
        <PublicKeyField label="Decoded nonce authority" value={nonceAuthority} setValue={setNonceAuthority} />
        <PublicKeyField label="External fee payer" value={feePayer} setValue={setFeePayer} />
        {error ? <p role="alert" className={errorCls}>{error}</p> : null}
        <button type="submit" disabled={checking || !nonceAccount.trim() || !nonceAuthority.trim() || !feePayer.trim()} className={primaryCls}>
          {checking ? "Validating on chain…" : "Validate and save public configuration"}
        </button>
      </form>
    </div>
  );
}

function SolanaPaymentWorkflow({ treasury, payment }: { treasury: SolanaWatchTreasury; payment: SolanaPaymentConfig }) {
  const record = useSolanaPaymentsStore((state) => state.records[treasury.id]);
  const [destination, setDestination] = useState("");
  const [amountSol, setAmountSol] = useState("");
  const [signatureJson, setSignatureJson] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [validatedDigest, setValidatedDigest] = useState<string | null>(null);
  const [proposalValidationFailed, setProposalValidationFailed] = useState(false);
  const proposal = record?.proposal;

  const statusQuery = useQuery({
    queryKey: ["solana-payment-status", record?.receipt?.signature],
    queryFn: () => solanaBridge().transactionStatus({ chain: treasury.watch.chain, signature: record!.receipt!.signature }),
    enabled: Boolean(record?.receipt),
    retry: false,
    refetchInterval: 20_000,
  });
  useEffect(() => {
    if (statusQuery.data) useSolanaPaymentsStore.getState().updateTransactionState(treasury.id, statusQuery.data.state);
  }, [statusQuery.data, treasury.id]);
  useEffect(() => {
    if (!proposal) {
      setValidatedDigest(null);
      setProposalValidationFailed(false);
      return;
    }
    let cancelled = false;
    setValidatedDigest(null);
    setProposalValidationFailed(false);
    void solanaBridge().paymentValidateProposal({ proposal })
      .then((response) => {
        if (cancelled) return;
        if (response.proposal.reviewDigest !== proposal.reviewDigest) throw new Error("Main-process payment review validation returned a mismatch");
        setValidatedDigest(proposal.reviewDigest);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const text = message(error);
          setLocalError(text);
          setProposalValidationFailed(true);
          useSolanaPaymentsStore.getState().fail(treasury.id, "The persisted payment review failed main-process validation");
        }
      });
    return () => { cancelled = true; };
  }, [proposal, treasury.id]);
  useEffect(() => {
    if (!record?.signatures.length) return;
    void Promise.all(record.signatures.map((envelope) => solanaBridge().paymentVerifySignature({ proposal: record.proposal, envelope })))
      .catch(() => useSolanaPaymentsStore.getState().fail(treasury.id, "A persisted signature failed restart revalidation"));
  }, [record?.proposal, record?.signatures, treasury.id]);

  const signed = useMemo(() => new Set(record?.signatures.map((item) => item.signer) ?? []), [record?.signatures]);

  async function prepare(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setLocalError(null);
    setBusy(true);
    try {
      const amountLamports = solToLamports(amountSol);
      const response = await solanaBridge().paymentPrepare({
        chain: treasury.watch.chain,
        treasuryId: treasury.id,
        source: treasury.watch.address,
        destination: parseSolanaAddress(destination, treasury.watch.chain),
        amountLamports,
        ...payment,
      });
      useSolanaPaymentsStore.getState().acceptProposal(treasury.id, response.proposal);
      setConfirmed(false);
    } catch (caught) {
      setLocalError(message(caught));
    } finally { setBusy(false); }
  }

  async function importEnvelope(raw = signatureJson): Promise<void> {
    setLocalError(null);
    if (!proposal) return;
    try {
      if (new TextEncoder().encode(raw).byteLength > MAX_SIGNATURE_ENVELOPE_BYTES) throw new Error("Solana signature envelope is too large");
      const parsed: unknown = JSON.parse(raw);
      const verified = await solanaBridge().paymentVerifySignature({ proposal, envelope: parsed as SolanaSignatureEnvelope });
      useSolanaPaymentsStore.getState().addVerifiedSignature(treasury.id, verified.envelope);
      setSignatureJson("");
    } catch (caught) { setLocalError(message(caught)); }
  }

  async function submit(): Promise<void> {
    if (!record || !confirmed) return;
    setLocalError(null);
    setBusy(true);
    try {
      useSolanaPaymentsStore.getState().beginSubmit(treasury.id);
      const response = await solanaBridge().paymentSubmit({ chain: treasury.watch.chain, treasuryId: treasury.id, proposal: record.proposal, signatures: record.signatures });
      useSolanaPaymentsStore.getState().acceptReceipt(treasury.id, response.receipt);
    } catch (caught) {
      const text = message(caught);
      useSolanaPaymentsStore.getState().submissionFailed(treasury.id, text);
      setConfirmed(false);
      setLocalError(text);
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <Header treasuryId={treasury.id} title="Native SOL durable-nonce payment" />
      <Notice />
      {!proposal ? (
        <form onSubmit={(event) => void prepare(event)} className="space-y-4">
          <PublicKeyField label="Destination wallet" value={destination} setValue={setDestination} />
          <label className="block space-y-1 text-sm"><span className="font-medium">Amount (SOL)</span><input aria-label="Amount (SOL)" value={amountSol} onChange={(event) => setAmountSol(event.target.value)} placeholder="0.01" className={inputCls} /></label>
          <button type="submit" disabled={busy || !destination.trim() || !amountSol.trim()} className={primaryCls}>{busy ? "Validating and simulating…" : "Prepare immutable review"}</button>
        </form>
      ) : proposalValidationFailed ? (
        <section className="rounded-md border border-danger/40 bg-danger/5 p-4 text-sm text-danger"><p>The persisted payment review is invalid and cannot be used.</p><button type="button" onClick={() => useSolanaPaymentsStore.getState().clear(treasury.id)} className={`${secondaryCls} mt-3`}>Discard invalid review</button></section>
      ) : validatedDigest !== proposal.reviewDigest ? (
        <p role="status" className="rounded-md border border-surface-hi bg-surface p-4 text-sm text-fg-muted">Validating the persisted immutable review in the main process…</p>
      ) : (
        <>
          <section className="rounded-lg border border-surface-hi bg-surface p-5 text-sm">
            <h2 className="font-medium">Immutable payment review</h2>
            <dl className="mt-3 grid gap-3 md:grid-cols-2">
              <Review label="Network" value={proposal.chain} /><Review label="Treasury ID" value={proposal.treasuryId} mono />
              <Review label="Amount" value={`${formatSol(proposal.amountLamports)} SOL (${proposal.amountLamports} lamports)`} /><Review label="Prepared at" value={proposal.createdAt} />
              <Review label="Source" value={proposal.source} mono /><Review label="Destination" value={proposal.destination} mono />
              <Review label="Fee payer" value={proposal.feePayer} mono /><Review label="Exact fee" value={`${proposal.feeLamports} lamports`} />
              <Review label="Nonce account" value={proposal.nonceAccount} mono /><Review label="Nonce authority" value={proposal.nonceAuthority} mono />
              <Review label="Durable nonce" value={proposal.durableNonce} mono /><Review label="Provider slot" value={proposal.slot} mono />
              <Review label="Source balance at review" value={`${proposal.sourceBalanceLamports} lamports`} /><Review label="Fee-payer balance at review" value={`${proposal.feePayerBalanceLamports} lamports`} />
              <Review label="Nonce balance at review" value={`${proposal.nonceBalanceLamports} lamports`} /><Review label="Nonce rent minimum" value={`${proposal.nonceRentMinimumLamports} lamports`} />
              <Review label="Instructions" value="0. AdvanceNonceAccount; 1. SystemProgram.transfer; no other instructions" /><Review label="Review digest" value={proposal.reviewDigest} mono />
            </dl>
            <details className="mt-4"><summary className="cursor-pointer text-fg-muted">Offline signing message</summary><div className="mt-2 break-all font-mono text-xs">{proposal.messageBase64}</div></details>
            <details className="mt-2"><summary className="cursor-pointer text-fg-muted">Unsigned transaction bytes</summary><div className="mt-2 break-all font-mono text-xs">{proposal.unsignedTransactionBase64}</div></details>
          </section>

          <section className="rounded-lg border border-surface-hi bg-surface p-5">
            <h2 className="text-sm font-medium">Actual required signers</h2>
            <p className="mt-1 text-xs text-fg-muted">Protocol-required signatures only. This is not a program-enforced M-of-N treasury.</p>
            <ul className="mt-3 space-y-2 text-xs">{proposal.requiredSigners.map((signer, index) => <li key={signer} className="flex gap-2"><span>{index + 1}.</span><span className="break-all font-mono">{signer}</span><span className={signed.has(signer) ? "text-accent" : "text-fg-muted"}>{signed.has(signer) ? "verified" : "required"}</span></li>)}</ul>
            {!record.receipt ? <div className="mt-4 space-y-2"><textarea aria-label="Signature envelope JSON" value={signatureJson} onChange={(event) => setSignatureJson(event.target.value)} maxLength={MAX_SIGNATURE_ENVELOPE_BYTES} rows={6} className={`${inputCls} font-mono text-xs`} /><div className="flex gap-2"><button type="button" onClick={() => void importEnvelope()} disabled={!signatureJson.trim()} className={secondaryCls}>Verify and import signature</button><label className={`${secondaryCls} cursor-pointer`}>Import file<input aria-label="Import signature file" type="file" accept="application/json,.json" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (file.size > MAX_SIGNATURE_ENVELOPE_BYTES) { setLocalError("Solana signature envelope is too large"); return; } void file.text().then(importEnvelope); }} /></label></div></div> : null}
            {record.signatures.length ? <div className="mt-3 flex flex-wrap gap-2">{record.signatures.map((item) => <button key={item.signer} type="button" onClick={() => downloadEnvelope(item)} className={secondaryCls}>Export {short(item.signer)}</button>)}</div> : null}
          </section>

          {!record.receipt && record.state === "ready" ? <section className="rounded-md border border-danger/40 bg-danger/5 p-4"><label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I rechecked the network, destination, amount, fee payer, signer list, nonce account, and immutable digest.</span></label><button type="button" onClick={() => void submit()} disabled={!confirmed || busy} className="mt-3 rounded-md bg-danger px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{busy ? "Revalidating and submitting…" : "Confirm and broadcast exact reviewed bytes"}</button></section> : null}
          {record.receipt ? <section className="rounded-md border border-accent/40 bg-accent/5 p-4 text-sm"><div className="font-medium text-accent">{record.receipt.alreadySubmitted ? "Already submitted" : "Submitted"}</div><div className="mt-1 break-all font-mono text-xs">{record.receipt.signature}</div><div className="mt-2 text-xs text-fg-muted">Status: {record.transactionState ?? "checking"}</div>{record.rollbackDetected ? <div role="alert" className="mt-2 text-warn">A prior confirmation regressed; current provider status is shown.</div> : null}</section> : null}
          {record.receipt && statusQuery.error ? <p role="alert" className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm text-warn">Payment status is temporarily unavailable; the last known state was preserved.</p> : null}
          {!record.receipt ? <button type="button" onClick={() => useSolanaPaymentsStore.getState().clear(treasury.id)} disabled={busy} className={secondaryCls}>Discard review and start over</button> : null}
        </>
      )}
      {(localError || record?.error) ? <p role="alert" className={errorCls}>{localError ?? record?.error}</p> : null}
    </div>
  );
}

function Header({ treasuryId, title }: { treasuryId: string; title: string }) { return <header><Link to={`/treasury/${treasuryId}`} className="text-xs text-fg-muted hover:text-fg">← Treasury</Link><h1 className="mt-1 text-2xl font-semibold">{title}</h1></header>; }
function Notice() { return <p className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm text-warn">ChainPay stores public configuration and externally produced signatures only. A durable nonce has one authority and is not an M-of-N custody policy.</p>; }
function PublicKeyField({ label, value, setValue }: { label: string; value: string; setValue(value: string): void }) { return <label className="block space-y-1 text-sm"><span className="font-medium">{label}</span><input aria-label={label} value={value} onChange={(event) => setValue(event.target.value)} spellCheck={false} className={`${inputCls} font-mono text-xs`} /></label>; }
function Review({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><dt className="text-xs text-fg-muted">{label}</dt><dd className={`mt-1 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</dd></div>; }

function solToLamports(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value)) throw new Error("Enter a canonical SOL amount with at most 9 decimal places");
  const [whole, fraction = ""] = value.split(".");
  const lamports = BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0") || "0");
  if (lamports <= 0n || lamports > 18_446_744_073_709_551_615n) throw new Error("SOL amount is outside the supported range");
  return lamports.toString();
}
function formatSol(value: string): string { const amount = BigInt(value); const whole = amount / 1_000_000_000n; const fraction = (amount % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, ""); return fraction ? `${whole}.${fraction}` : whole.toString(); }
function short(value: string): string { return `${value.slice(0, 5)}…${value.slice(-4)}`; }
function message(error: unknown): string { return error instanceof Error ? error.message : "Solana payment operation failed"; }
function downloadEnvelope(envelope: SolanaSignatureEnvelope): void { const url = URL.createObjectURL(new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `chainpay-solana-signature-${short(envelope.signer).replace("…", "-")}.json`; anchor.click(); URL.revokeObjectURL(url); }

const inputCls = "w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm text-fg";
const primaryCls = "rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-40";
const secondaryCls = "rounded-md border border-surface-hi px-3 py-2 text-xs text-fg-muted disabled:opacity-40";
const errorCls = "rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger";
