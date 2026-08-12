import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatEther, type Hex } from "viem";
import QRCode from "qrcode";
import { useQuery } from "@tanstack/react-query";
import { isMultisigTreasury, type EvmMultisig } from "@chain-pay/shared";
import { usePendingTransactionsStore } from "@/stores/pending-transactions";
import { useTreasuryStore } from "@/stores/treasury";
import { parseSafePayment } from "@/lib/chains/evm/safe";
import { MetaMaskSafeOwnerSigner } from "@/lib/signers/metamask-safe-owner";
import { executeSafePayment } from "@/lib/chains/evm/safe-executor";
import { readEvmExecutionStatus } from "@/lib/chains/evm/execution-status";
import { postConfirmedSafePayment } from "@/lib/accounting/evm-safe-accounting";
import {
  walletConnectSafeOwnerSigner,
  type WalletConnectStatus,
} from "@/lib/signers/walletconnect-safe-owner";
import {
  parseSafeApproval,
  serializeSafeApproval,
} from "@/lib/chains/evm/safe-approval-interchange";
import { Tile } from "@/components/ui/Tile";

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
  const walletConnect = useMemo(() => walletConnectSafeOwnerSigner(), []);
  const [walletConnectStatus, setWalletConnectStatus] = useState<WalletConnectStatus>(
    walletConnect.snapshot(),
  );
  const [pairingQr, setPairingQr] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    const unsubscribe = walletConnect.subscribe(setWalletConnectStatus);
    void walletConnect.restore().catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
    return unsubscribe;
  }, [walletConnect]);

  useEffect(() => {
    const uri = walletConnectStatus.state === "connecting" ? walletConnectStatus.pairingUri : undefined;
    if (!uri) {
      setPairingQr(null);
      return;
    }
    let active = true;
    void QRCode.toDataURL(uri, { width: 256, margin: 1 }).then((data) => {
      if (active) setPairingQr(data);
    });
    return () => { active = false; };
  }, [walletConnectStatus]);

  if (
    !pending ||
    !treasury ||
    !isMultisigTreasury(treasury) ||
    !treasury.multisig.chain.startsWith("evm:")
  ) {
    return <MissingApproval />;
  }
  if (!payloadResult?.payload) {
    return <InvalidApproval message={payloadResult?.error ?? "Safe payment payload is missing"} />;
  }
  const payload = payloadResult.payload;
  const multisig = treasury.multisig as EvmMultisig;

  const recordApproval = async (signature: { signerHash: string; bytes: Uint8Array }) => {
    const added = await recordSignature(
      pending.id,
      { ...signature, signedAt: Date.now() },
      multisig,
    );
    setNotice(
      added
        ? `Approval recorded from ${signature.signerHash}`
        : "This owner already approved the payment",
    );
  };

  const handleMetaMaskApprove = async () => {
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
      await recordApproval(signature);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleWalletConnectApprove = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const signature = await walletConnect.sign({
        chain: pending.chain,
        digest: pending.signingDigest,
        context: { pending, multisig },
      });
      await recordApproval(signature);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const handlePairWalletConnect = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await walletConnect.connect();
      setNotice("WalletConnect owner session connected");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnectWalletConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await walletConnect.disconnect();
      setNotice("WalletConnect session disconnected");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "WalletConnect disconnect failed");
    } finally {
      setBusy(false);
    }
  };

  const handleImportApproval = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const signature = await parseSafeApproval({ text: await file.text(), pending, multisig });
      await recordApproval(signature);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (importInput.current) importInput.current.value = "";
      setBusy(false);
    }
  };

  const handleExportApproval = async (signature: (typeof pending.signatures)[number]) => {
    setError(null);
    try {
      const text = await serializeSafeApproval({ pending, multisig, signature });
      downloadText(
        `chainpay-safe-approval-${pending.signingDigest.slice(2, 12)}-${signature.signerHash.slice(2, 10)}.json`,
        text,
      );
      setNotice(`Approval exported for ${signature.signerHash}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
              <li key={signature.signerHash} className="flex items-center justify-between gap-3 text-xs text-fg-muted">
                <span className="break-all font-mono">{signature.signerHash}</span>
                <button
                  type="button"
                  onClick={() => void handleExportApproval(signature)}
                  className="shrink-0 rounded border border-surface-hi px-2 py-1 hover:text-fg"
                >
                  Export approval
                </button>
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
        <SignerActions
          busy={busy}
          walletConnectStatus={walletConnectStatus}
          pairingQr={pairingQr}
          onMetaMask={() => void handleMetaMaskApprove()}
          onPair={() => void handlePairWalletConnect()}
          onWalletConnect={() => void handleWalletConnectApprove()}
          onDisconnect={() => void handleDisconnectWalletConnect()}
          onImport={() => importInput.current?.click()}
        />
      )}

      <input
        ref={importInput}
        type="file"
        accept="application/json,.json"
        aria-label="Import Safe approval file"
        className="hidden"
        onChange={(event) => void handleImportApproval(event.target.files?.[0])}
      />

      {pending.state !== "awaiting_signature" && walletConnectStatus.state === "connected" ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-surface-hi bg-surface p-3 text-xs">
          <span className="break-all font-mono text-fg-muted">WalletConnect: {walletConnectStatus.account}</span>
          <button
            type="button"
            onClick={() => void handleDisconnectWalletConnect()}
            disabled={busy}
            className={secondaryButtonCls}
          >
            Disconnect WalletConnect
          </button>
        </div>
      ) : null}

      {notice ? <p role="status" className="text-sm text-accent">{notice}</p> : null}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}

function SignerActions({
  busy,
  walletConnectStatus,
  pairingQr,
  onMetaMask,
  onPair,
  onWalletConnect,
  onDisconnect,
  onImport,
}: {
  busy: boolean;
  walletConnectStatus: WalletConnectStatus;
  pairingQr: string | null;
  onMetaMask: () => void;
  onPair: () => void;
  onWalletConnect: () => void;
  onDisconnect: () => void;
  onImport: () => void;
}) {
  const pairingUri = walletConnectStatus.state === "connecting" ? walletConnectStatus.pairingUri : undefined;
  return (
    <section className="space-y-4 rounded-lg border border-surface-hi bg-surface p-5">
      <div>
        <h2 className="text-sm font-medium">Add an owner approval</h2>
        <p className="mt-1 text-xs text-fg-muted">Every signature is recovered locally against the reviewed SafeTx before persistence.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onMetaMask} disabled={busy} className={actionButtonCls}>
          Approve with browser wallet
        </button>
        {walletConnectStatus.state === "connected" ? (
          <>
            <button type="button" onClick={onWalletConnect} disabled={busy} className={actionButtonCls}>
              Approve with WalletConnect
            </button>
            <button type="button" onClick={onDisconnect} disabled={busy} className={secondaryButtonCls}>
              Disconnect WalletConnect
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onPair}
            disabled={busy || walletConnectStatus.state === "unconfigured"}
            className={actionButtonCls}
          >
            Pair WalletConnect
          </button>
        )}
        <button type="button" onClick={onImport} disabled={busy} className={secondaryButtonCls}>
          Import approval
        </button>
      </div>
      {walletConnectStatus.state === "connected" ? (
        <p className="break-all font-mono text-xs text-accent">Connected: {walletConnectStatus.account}</p>
      ) : null}
      {walletConnectStatus.state === "unconfigured" ? (
        <p className="text-xs text-warn">WalletConnect unavailable: configure VITE_WALLETCONNECT_PROJECT_ID.</p>
      ) : null}
      {walletConnectStatus.state === "expired" ? (
        <p className="text-xs text-warn">WalletConnect session expired. Pair the wallet again.</p>
      ) : null}
      {walletConnectStatus.state === "error" ? (
        <p className="text-xs text-danger">{walletConnectStatus.message}</p>
      ) : null}
      {pairingUri ? (
        <div className="space-y-3 rounded-md border border-surface-hi bg-bg p-4">
          <p className="text-xs text-fg-muted">Scan with a WalletConnect-compatible wallet or open the deep link on this device.</p>
          {pairingQr ? <img src={pairingQr} alt="WalletConnect pairing QR code" className="h-52 w-52 bg-white p-2" /> : null}
          <a href={pairingUri} className="inline-block text-sm text-accent hover:underline">Open wallet deep link</a>
        </div>
      ) : null}
    </section>
  );
}

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const actionButtonCls =
  "rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
const secondaryButtonCls =
  "rounded-md border border-surface-hi bg-bg px-4 py-2 text-sm text-fg-muted hover:text-fg disabled:opacity-40";

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
