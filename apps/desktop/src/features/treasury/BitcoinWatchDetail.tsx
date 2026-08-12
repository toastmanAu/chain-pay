import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type {
  BitcoinAccountingState,
  BitcoinBroadcastReview,
  BitcoinTransactionStatusResponse,
  BitcoinWatchTreasury,
} from "@chain-pay/shared";
import { ReviewValue } from "@/components/ui/ReviewValue";
import { Tile } from "@/components/ui/Tile";
import { chainBadge } from "@/lib/format/chain-badge";
import { formatThousands } from "@/lib/format/thousands";
import { formatBtc, formatSignedBtc } from "@/lib/format/btc";
import { useBitcoinWatchStore } from "@/stores/bitcoin-watch";
import { useBitcoinBroadcastStore, type BitcoinBroadcastUiState } from "@/stores/bitcoin-broadcast";
import { bitcoinBridge } from "@/lib/chains/btc/ipc";
import { syncBitcoinWatch } from "@/lib/chains/btc/sync";
import { deriveBitcoinReceiveAddress } from "@/lib/chains/btc/watch-source";
import { postFinalizedBitcoinPayment } from "@/lib/accounting/bitcoin-accounting";

export function BitcoinWatchDetail({ treasury }: { treasury: BitcoinWatchTreasury }) {
  const source = treasury.watch.source;
  const record = useBitcoinWatchStore((state) => state.records[treasury.id]);
  const broadcast = useBitcoinBroadcastStore((state) => state.records[treasury.id]);
  const [rawTxHex, setRawTxHex] = useState(() => broadcast?.rawTxHex ?? "");
  const [confirmedReview, setConfirmedReview] = useState(false);
  const [inspection, setInspection] = useState<BitcoinBroadcastReview | null>(null);
  const [inspectionBusy, setInspectionBusy] = useState(false);
  const [accountingInputs, setAccountingInputs] = useState<Record<number, { payeeId: string; fiatMinor: string }>>({});
  useEffect(() => {
    useBitcoinWatchStore.getState().ensure(treasury.id, treasury.watch);
  }, [treasury.id, treasury.watch]);
  const providerQuery = useQuery({
    queryKey: ["bitcoin-provider-status", treasury.watch.chain],
    queryFn: () => bitcoinBridge().status(treasury.watch.chain),
    retry: false,
  });
  const syncQuery = useQuery({
    queryKey: ["bitcoin-watch-sync", treasury.id],
    queryFn: () => syncBitcoinWatch({ treasuryId: treasury.id, config: treasury.watch }),
    enabled: providerQuery.data?.configured === true,
    retry: false,
    refetchInterval: 60_000,
  });
  const snapshot = record?.snapshot;
  let receiveAddress: string;
  try {
    receiveAddress = deriveBitcoinReceiveAddress(treasury.watch, record?.nextReceiveIndex ?? 0);
  } catch {
    receiveAddress = source.kind === "address" ? source.address : "Unavailable";
  }
  const providerState = providerQuery.isLoading
    ? "Checking provider…"
    : providerQuery.data?.configured
      ? "Provider configured"
      : "Provider not configured";
  const watchedAddresses = useMemo(
    () => [...new Set([...(snapshot?.addresses ?? []), receiveAddress].filter((address) => address !== "Unavailable"))],
    [snapshot?.addresses, receiveAddress],
  );
  const accountingOutputs = inspection?.outputs.filter(
    (output) => !output.watched && output.scriptType !== "op_return" && BigInt(output.valueSats) > 0n,
  ) ?? [];
  const accountingMappingComplete = accountingOutputs.length > 0 && accountingOutputs.every((output) => {
    const value = accountingInputs[output.vout];
    return Boolean(output.address && value?.payeeId.trim() && /^[1-9]\d*$/.test(value?.fiatMinor.trim() ?? ""));
  });

  async function inspectRawTransaction(): Promise<void> {
    const raw = rawTxHex.trim();
    setInspectionBusy(true);
    setConfirmedReview(false);
    try {
      const response = await bitcoinBridge().reviewBroadcast({
        chain: treasury.watch.chain,
        treasuryId: treasury.id,
        watchedAddresses,
        rawTxHex: raw,
      });
      if (response.ok) {
        setInspection(response.review);
        setAccountingInputs(Object.fromEntries(response.review.outputs
          .filter((output) => !output.watched && output.scriptType !== "op_return" && BigInt(output.valueSats) > 0n)
          .map((output) => [output.vout, { payeeId: "", fiatMinor: "" }])));
      } else {
        useBitcoinBroadcastStore.getState().beginReview(treasury.id, treasury.watch.chain, raw);
        useBitcoinBroadcastStore.getState().fail(treasury.id, response.error);
      }
    } catch {
      useBitcoinBroadcastStore.getState().beginReview(treasury.id, treasury.watch.chain, raw);
      useBitcoinBroadcastStore.getState().fail(treasury.id, { code: "provider_unavailable", message: "Bitcoin provider is unavailable" });
    } finally {
      setInspectionBusy(false);
    }
  }

  async function prepareAccountingReview(): Promise<void> {
    if (!inspection || accountingOutputs.length === 0) return;
    const accounting = accountingOutputs.map((output) => ({
      vout: output.vout,
      destination: output.address ?? "",
      valueSats: output.valueSats,
      payeeId: accountingInputs[output.vout]?.payeeId.trim() ?? "",
      fiat: { currency: "USD" as const, minor: accountingInputs[output.vout]?.fiatMinor.trim() ?? "" },
    }));
    useBitcoinBroadcastStore.getState().beginReview(treasury.id, treasury.watch.chain, rawTxHex.trim());
    setConfirmedReview(false);
    try {
      const response = await bitcoinBridge().reviewBroadcast({
        chain: treasury.watch.chain, treasuryId: treasury.id, watchedAddresses,
        rawTxHex: rawTxHex.trim(), accounting,
      });
      if (response.ok) {
        useBitcoinBroadcastStore.getState().acceptReview(treasury.id, response.review);
        setInspection(null);
      }
      else useBitcoinBroadcastStore.getState().fail(treasury.id, response.error);
    } catch {
      useBitcoinBroadcastStore.getState().fail(treasury.id, { code: "provider_unavailable", message: "Bitcoin provider is unavailable" });
    }
  }

  async function submitReviewedTransaction(): Promise<void> {
    if (!broadcast?.review || !confirmedReview) return;
    useBitcoinBroadcastStore.getState().beginSubmit(treasury.id);
    try {
      const response = await bitcoinBridge().confirmBroadcast({
        chain: treasury.watch.chain,
        treasuryId: treasury.id,
        watchedAddresses,
        rawTxHex: broadcast.rawTxHex,
        reviewDigest: broadcast.review.digest,
        ...(broadcast.review.reviewVersion === 2 ? { accounting: broadcast.review.accounting } : {}),
      });
      if (response.ok) useBitcoinBroadcastStore.getState().acceptReceipt(treasury.id, response.receipt);
      else {
        if (response.review) useBitcoinBroadcastStore.getState().acceptReview(treasury.id, response.review);
        useBitcoinBroadcastStore.getState().fail(treasury.id, response.error);
      }
    } catch {
      useBitcoinBroadcastStore.getState().fail(treasury.id, { code: "provider_unavailable", message: "Bitcoin provider is unavailable" });
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link to="/treasury" className="text-xs text-fg-muted hover:text-fg">← Treasury</Link>
          <h1 className="mt-1 text-2xl font-semibold">{treasury.label}</h1>
          <p className="text-sm text-fg-muted">
            {chainBadge(treasury.watch.chain)} · Bitcoin watch-only · {source.scriptType}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void syncQuery.refetch()}
          disabled={!providerQuery.data?.configured || syncQuery.isFetching}
          className="rounded-md border border-accent px-3 py-2 text-sm text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {syncQuery.isFetching ? "Syncing…" : "Refresh"}
        </button>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Tile
          label="Balance"
          value={snapshot ? `${formatBtc(snapshot.balanceSats)} BTC` : "—"}
          hint={record?.lastSyncedAt ? `synced ${new Date(record.lastSyncedAt).toLocaleString()}` : providerState}
          tone="accent"
        />
        <Tile label="UTXOs" value={String(snapshot?.utxos.length ?? 0)} hint="unspent outputs" />
        <Tile
          label="Tip"
          value={snapshot ? formatThousands(BigInt(snapshot.tipHeight)) : "—"}
          hint={snapshot ? `${snapshot.tipHash.slice(0, 12)}…` : "not synced"}
        />
      </section>

      {!providerQuery.isLoading && !providerQuery.data?.configured ? (
        <p role="alert" className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm text-warn">
          Configure {treasury.watch.chain === "btc:mainnet" ? "BITCOIN_MAINNET_ESPLORA_URL" : "BITCOIN_TESTNET_ESPLORA_URL"} in the desktop main-process environment, then restart ChainPay.
        </p>
      ) : null}
      {record?.error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
          Bitcoin sync failed: {record.error}
        </p>
      ) : null}

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Receive address</h2>
        <div className="mt-2 break-all font-mono text-sm text-accent">{receiveAddress}</div>
        <p className="mt-2 text-xs text-fg-muted">
          {source.kind === "address"
            ? "Fixed imported address."
            : `Public derivation index ${record?.nextReceiveIndex ?? 0}; gap limit ${treasury.watch.gapLimit}.`}
        </p>
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-4">
        <div className="text-xs uppercase tracking-wide text-fg-muted">Watch source</div>
        <div className="mt-2 break-all font-mono text-xs text-accent">
          {source.kind === "address" ? source.address : source.descriptor}
        </div>
        <p className="mt-3 text-xs text-fg-muted">
          Watch-only. ChainPay never constructs or signs Bitcoin transactions; manual broadcast accepts only a finalized transaction signed elsewhere.
        </p>
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Manual signed transaction broadcast</h2>
        <p className="mt-2 text-xs text-fg-muted">
          Paste finalized raw transaction hex. Seeds, private keys, signing requests, and PSBTs are not accepted.
        </p>
        <textarea
          aria-label="Fully signed raw transaction"
          value={rawTxHex}
          onChange={(event) => {
            setRawTxHex(event.target.value); setConfirmedReview(false); setInspection(null); setAccountingInputs({});
          }}
          rows={5}
          spellCheck={false}
          placeholder="020000000001…"
          className="mt-3 w-full rounded-md border border-surface-hi bg-bg p-3 font-mono text-xs text-fg outline-none focus:border-accent"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void inspectRawTransaction()}
            disabled={!providerQuery.data?.configured || !rawTxHex.trim() || inspectionBusy || broadcast?.state === "submitting"}
            className="rounded-md border border-accent px-3 py-2 text-sm text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {inspectionBusy ? "Inspecting…" : "Inspect signed transaction"}
          </button>
          {broadcast && !inspection ? <span className="text-xs text-fg-muted">State: {broadcastStateLabel(broadcast.state)}</span> : null}
        </div>

        {broadcast?.error && !inspection ? (
          <p role="alert" className={`mt-3 rounded-md border p-3 text-sm ${broadcast.error.code === "provider_unavailable" ? "border-warn/40 bg-warn/5 text-warn" : broadcast.state === "already_broadcast" ? "border-accent/40 bg-accent/5 text-accent" : "border-danger/40 bg-danger/5 text-danger"}`}>
            {broadcast.error.message}
          </p>
        ) : null}

        {inspection ? (
          <div className="mt-5 space-y-4 border-t border-surface-hi pt-4">
            <div>
              <h3 className="text-sm font-medium">Accounting output mapping</h3>
              <p className="mt-1 text-xs text-fg-muted">
                Map every positive external output. This mapping is approved by this operator at broadcast time; it is not cryptographically signed by the external Bitcoin signers.
              </p>
            </div>
            {accountingOutputs.map((output) => (
              <div key={`accounting:${output.vout}`} className="grid gap-3 rounded-md border border-surface-hi p-3 md:grid-cols-[minmax(0,1fr)_minmax(10rem,0.5fr)_minmax(10rem,0.5fr)]">
                <div className="text-xs">
                  <div className="text-fg-muted">Output {output.vout} · immutable destination and amount</div>
                  <div className="mt-1 break-all font-mono">{output.address ?? "Unsupported destination"}</div>
                  <div className="mt-1 tabular-nums">{formatBtc(output.valueSats)} BTC</div>
                </div>
                <label className="text-xs text-fg-muted">
                  Payee reference
                  <input
                    aria-label={`Payee reference for output ${output.vout}`}
                    value={accountingInputs[output.vout]?.payeeId ?? ""}
                    onChange={(event) => setAccountingInputs((values) => ({ ...values, [output.vout]: { ...values[output.vout]!, payeeId: event.target.value } }))}
                    className="mt-1 w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-fg"
                  />
                </label>
                <label className="text-xs text-fg-muted">
                  USD obligation (cents)
                  <input
                    aria-label={`USD obligation for output ${output.vout}`}
                    inputMode="numeric"
                    value={accountingInputs[output.vout]?.fiatMinor ?? ""}
                    onChange={(event) => setAccountingInputs((values) => ({ ...values, [output.vout]: { ...values[output.vout]!, fiatMinor: event.target.value } }))}
                    className="mt-1 w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-fg"
                  />
                </label>
              </div>
            ))}
            <button
              type="button"
              onClick={() => void prepareAccountingReview()}
              disabled={!accountingMappingComplete || broadcast?.state === "reviewing" || broadcast?.state === "submitting"}
              className="rounded-md border border-accent px-3 py-2 text-sm text-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {broadcast?.state === "reviewing" ? "Preparing review…" : "Prepare accounting-bound review"}
            </button>
          </div>
        ) : null}

        {broadcast?.review ? (
          <div className="mt-5 space-y-4 border-t border-surface-hi pt-4">
            <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
              <ReviewValue label="Inputs" value={`${formatBtc(broadcast.review.inputValueSats)} BTC`} />
              <ReviewValue label="Outputs" value={`${formatBtc(broadcast.review.outputValueSats)} BTC`} />
              <ReviewValue label="Miner fee" value={`${formatBtc(broadcast.review.feeSats)} BTC`} />
              <ReviewValue label="Fee rate" value={`${broadcast.review.feeRateSatsPerVbyte} sat/vB`} />
            </div>
            <div className="text-xs">
              <div className="text-fg-muted">Transaction ID</div>
              <div className="mt-1 break-all font-mono">{broadcast.review.txid}</div>
              <div className="mt-2 text-fg-muted">Review digest · tip {formatThousands(BigInt(broadcast.review.tipHeight))}</div>
              <div className="mt-1 break-all font-mono text-accent">{broadcast.review.digest}</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-fg-muted"><tr><th className="pb-2">Direction</th><th className="pb-2">Address / script</th><th className="pb-2">Amount</th><th className="pb-2">Ownership</th></tr></thead>
                <tbody>
                  {broadcast.review.inputs.map((input) => (
                    <tr key={`${input.txid}:${input.vout}`} className="border-t border-surface-hi">
                      <td className="py-2">Input</td><td className="max-w-72 truncate py-2 font-mono">{input.address ?? input.scriptType}</td><td className="py-2">{formatBtc(input.valueSats)} BTC</td><td className="py-2">{input.watched ? "Watched" : "Unknown"}</td>
                    </tr>
                  ))}
                  {broadcast.review.outputs.map((output) => (
                    <tr key={`out:${output.vout}`} className="border-t border-surface-hi">
                      <td className="py-2">Output {output.vout}</td><td className="max-w-72 truncate py-2 font-mono">{output.address ?? output.scriptType}</td><td className="py-2">{formatBtc(output.valueSats)} BTC</td><td className="py-2">{output.changeCandidate ? "Change candidate" : output.watched ? "Watched" : "External"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {broadcast.review.warnings.map((warning) => <p key={warning} className="rounded-md border border-warn/40 bg-warn/5 p-3 text-xs text-warn">{warning}</p>)}
            {broadcast.review.reviewVersion === 2 ? (
              <div className="rounded-md border border-accent/40 bg-accent/5 p-3 text-xs">
                <div className="font-medium text-accent">Accounting-bound review v2</div>
                {broadcast.review.accounting.map((line) => (
                  <div key={line.vout} className="mt-2">
                    Output {line.vout} · {line.payeeId} · USD {(BigInt(line.fiat.minor) / 100n).toString()}.{(BigInt(line.fiat.minor) % 100n).toString().padStart(2, "0")} · {line.destination}
                  </div>
                ))}
                <p className="mt-2 text-fg-muted">Operator-approved at broadcast time; not signed by the external Bitcoin signers.</p>
              </div>
            ) : (
              <p role="alert" className="rounded-md border border-warn/40 bg-warn/5 p-3 text-xs text-warn">
                Legacy A2 review: broadcast and status tracking remain available, but this transaction is permanently excluded from automatic accounting.
              </p>
            )}
            {!broadcast.receipt ? (
              <div className="rounded-md border border-danger/40 bg-danger/5 p-3">
                <label className="flex items-start gap-2 text-xs text-fg">
                  <input type="checkbox" checked={confirmedReview} onChange={(event) => setConfirmedReview(event.target.checked)} className="mt-0.5" />
                  <span>I verified the selected treasury, network, inputs, destinations, change candidates, and fee shown in this immutable review.</span>
                </label>
                <button
                  type="button"
                  onClick={() => void submitReviewedTransaction()}
                  disabled={!confirmedReview || broadcast.state === "submitting" || broadcast.state !== "reviewed"}
                  className="mt-3 rounded-md bg-danger px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {broadcast.state === "submitting" ? "Broadcasting…" : "Confirm and broadcast"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {broadcast?.receipt ? (
          <div className="mt-4 rounded-md border border-accent/40 bg-accent/5 p-3 text-xs">
            <div className="font-medium text-accent">{broadcast.receipt.state === "already_broadcast" ? "Already broadcast" : "Submitted"}</div>
            <div className="mt-1 break-all font-mono">{broadcast.receipt.txid}</div>
            <div className="mt-1 text-fg-muted">{broadcast.status ? broadcastStatusLabel(broadcast.status) : "Checking network status…"}</div>
            {broadcast.accountingError ? <div className="mt-2 text-warn">{broadcast.accountingError}</div> : null}
            {broadcast.reorged ? <div role="alert" className="mt-2 text-warn">A prior confirmation was reorged; accounting requires manual reconciliation and ChainPay will never auto-reverse or rebroadcast.</div> : null}
            {broadcast.review?.reviewVersion === 2 ? (
              <div className="mt-3 border-t border-accent/20 pt-3">
                <div>Accounting: {bitcoinAccountingStateLabel(broadcast.accountingState)}</div>
                {broadcast.finalizedEvidence ? <div className="mt-1 text-fg-muted">Finalized in block {broadcast.finalizedEvidence.blockHeight} · {broadcast.finalizedEvidence.confirmations} confirmations</div> : null}
                {broadcast.accountingRecordName ? <div className="mt-1">Record <span className="font-mono">{broadcast.accountingRecordName}</span></div> : null}
                {broadcast.journalEntryName ? <div className="mt-1">Journal <span className="font-mono">{broadcast.journalEntryName}</span></div> : null}
                {broadcast.accountingState === "post_failed" ? (
                  <button type="button" onClick={() => void postFinalizedBitcoinPayment(treasury.id)} className="mt-2 rounded-md border border-accent px-3 py-1.5 text-accent">Retry accounting post</button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Unspent outputs</h2>
        {snapshot?.utxos.length ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-fg-muted"><tr><th className="pb-2">Outpoint</th><th className="pb-2">Amount</th><th className="pb-2">Confirmations</th></tr></thead>
              <tbody>
                {snapshot.utxos.map((utxo) => (
                  <tr key={`${utxo.txid}:${utxo.vout}`} className="border-t border-surface-hi">
                    <td className="py-2 font-mono">{utxo.txid.slice(0, 12)}…:{utxo.vout}</td>
                    <td className="py-2 tabular-nums">{formatBtc(utxo.valueSats)} BTC</td>
                    <td className="py-2 tabular-nums">{utxo.confirmed ? utxo.confirmations : "Unconfirmed"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="mt-3 text-sm text-fg-muted">No unspent outputs found.</p>}
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Transaction history</h2>
        {snapshot?.transactions.length ? (
          <ul className="mt-3 divide-y divide-surface-hi">
            {snapshot.transactions.map((transaction) => (
              <li key={transaction.txid} className="flex items-center justify-between gap-4 py-3 text-xs">
                <div className="min-w-0">
                  <div className="truncate font-mono">{transaction.txid}</div>
                  <div className="mt-1 text-fg-muted">
                    {transaction.confirmed
                      ? `${transaction.confirmations} confirmation${transaction.confirmations === 1 ? "" : "s"}${transaction.blockTime ? ` · ${new Date(transaction.blockTime * 1000).toLocaleString()}` : ""}`
                      : "Unconfirmed or reorged"}
                  </div>
                </div>
                <div className={`shrink-0 font-medium tabular-nums ${BigInt(transaction.netValueSats) >= 0n ? "text-accent" : "text-fg"}`}>
                  {formatSignedBtc(transaction.netValueSats)} BTC
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-sm text-fg-muted">No transactions found.</p>}
      </section>
    </div>
  );
}

function broadcastStateLabel(state: BitcoinBroadcastUiState): string {
  return ({
    draft: "Draft",
    reviewing: "Reviewing",
    reviewed: "Ready for confirmation",
    submitting: "Submitting",
    submitted: "Submitted",
    already_broadcast: "Already broadcast",
    rejected: "Rejected",
    unavailable: "Provider unavailable",
  })[state];
}

function broadcastStatusLabel(status: BitcoinTransactionStatusResponse): string {
  if (status.state === "confirmed") return `Confirmed · ${status.confirmations} confirmations`;
  if (status.state === "confirming") return `Confirming · ${status.confirmations} confirmation${status.confirmations === 1 ? "" : "s"}`;
  if (status.state === "pending") return "Pending in mempool or reorged";
  return "Not currently known by provider";
}

function bitcoinAccountingStateLabel(state: BitcoinAccountingState): string {
  return ({
    not_applicable: "Legacy transaction — not applicable",
    awaiting_finalization: "Waiting for 6 canonical confirmations",
    ready: "Finalized evidence ready",
    posting: "Posting to ERPNext…",
    posted: "Posted",
    post_failed: "Post failed — safe to retry",
    reconciliation_required: "Manual reconciliation required",
  })[state];
}
