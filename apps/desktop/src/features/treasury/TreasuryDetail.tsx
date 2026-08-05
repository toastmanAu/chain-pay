import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatEther } from "viem";
import {
  isBitcoinWatchTreasury,
  isMultisigTreasury,
  isSolanaWatchTreasury,
  type BitcoinWatchTreasury,
  type BitcoinTransactionStatusResponse,
  type CkbMultisig,
  type EvmMultisig,
  type MultisigTreasury,
  type SolanaWatchTreasury,
} from "@chain-pay/shared";
import { useTreasuryStore } from "@/stores/treasury";
import { useSyncStore } from "@/stores/sync";
import { lightClient } from "@/lib/light-client/client";
import { treasuryLockScript } from "@/lib/chains/ckb/address";
import type { CkbMultisigConfig } from "@/lib/chains/ckb/multisig";
import { readSafeSnapshot } from "@/lib/chains/evm/safe-reader";
import { useBitcoinWatchStore } from "@/stores/bitcoin-watch";
import { useBitcoinBroadcastStore, type BitcoinBroadcastUiState } from "@/stores/bitcoin-broadcast";
import { bitcoinBridge } from "@/lib/chains/btc/ipc";
import { syncBitcoinWatch } from "@/lib/chains/btc/sync";
import { deriveBitcoinReceiveAddress } from "@/lib/chains/btc/watch-source";
import { useSolanaWatchStore } from "@/stores/solana-watch";
import { solanaBridge } from "@/lib/chains/sol/ipc";
import { syncSolanaWatch } from "@/lib/chains/sol/sync";

const SHANNONS_PER_CKB = 100_000_000n;

export function TreasuryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const treasury = useTreasuryStore((s) => s.treasuries.find((t) => t.id === id));

  if (!treasury) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Treasury not found</h1>
        <button
          type="button"
          onClick={() => navigate("/treasury")}
          className="rounded-md border border-surface-hi bg-surface px-4 py-2 text-sm hover:text-fg"
        >
          Back to treasury list
        </button>
      </div>
    );
  }

  if (isBitcoinWatchTreasury(treasury)) return <BitcoinWatchDetail treasury={treasury} />;
  if (isSolanaWatchTreasury(treasury)) return <SolanaWatchDetail treasury={treasury} />;
  if (!isMultisigTreasury(treasury)) return null;
  if (treasury.multisig.chain.startsWith("evm:")) return <EvmTreasuryDetail treasury={treasury} />;

  return <CkbTreasuryDetail treasury={treasury} />;
}

function SolanaWatchDetail({ treasury }: { treasury: SolanaWatchTreasury }) {
  const record = useSolanaWatchStore((state) => state.records[treasury.id]);
  const [statusError, setStatusError] = useState<string | null>(null);
  useEffect(() => {
    useSolanaWatchStore.getState().ensure(treasury.id, treasury.watch);
  }, [treasury.id, treasury.watch]);
  const providerQuery = useQuery({
    queryKey: ["solana-provider-status", treasury.watch.chain],
    queryFn: () => solanaBridge().status(treasury.watch.chain),
    retry: false,
  });
  const syncQuery = useQuery({
    queryKey: ["solana-watch-sync", treasury.id],
    queryFn: () => syncSolanaWatch(treasury),
    enabled: providerQuery.data?.configured === true,
    retry: false,
    refetchInterval: 60_000,
  });
  const snapshot = record?.snapshot;
  const providerState = providerQuery.isLoading
    ? "checking provider…"
    : providerQuery.data?.configured
      ? "provider configured"
      : "provider not configured";

  async function refreshStatus(signature: string): Promise<void> {
    setStatusError(null);
    try {
      const status = await solanaBridge().transactionStatus({ chain: treasury.watch.chain, signature });
      useSolanaWatchStore.getState().updateTransactionStatus(treasury.id, signature, status.state);
    } catch {
      setStatusError("Transaction status is temporarily unavailable; the last snapshot was preserved.");
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link to="/treasury" className="text-xs text-fg-muted hover:text-fg">← Treasury</Link>
          <h1 className="mt-1 text-2xl font-semibold">{treasury.label}</h1>
          <p className="text-sm text-fg-muted">{chainBadge(treasury.watch.chain)} · Solana watch-only</p>
        </div>
        <div className="flex gap-2">
          <Link to={`/treasury/${treasury.id}/solana/payment/new`} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg">New SOL payment</Link>
          <button type="button" onClick={() => void syncQuery.refetch()} disabled={!providerQuery.data?.configured || syncQuery.isFetching} className="rounded-md border border-accent px-3 py-2 text-sm text-accent disabled:cursor-not-allowed disabled:opacity-40">
            {syncQuery.isFetching ? "Syncing…" : "Refresh"}
          </button>
        </div>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Tile label="Balance" value={snapshot ? `${formatSol(snapshot.balanceLamports)} SOL` : "—"} hint={record?.lastSyncedAt ? `synced ${new Date(record.lastSyncedAt).toLocaleString()}` : providerState} tone="accent" />
        <Tile label="Transactions" value={String(snapshot?.transactions.length ?? 0)} hint={snapshot?.historyTruncated ? "latest 100 · history bounded" : "known signatures"} />
        <Tile label="Finalized slot" value={snapshot ? formatThousands(BigInt(snapshot.slot)) : "—"} hint={snapshot ? `${snapshot.blockhash.slice(0, 12)}…` : "not synced"} />
      </section>

      {!providerQuery.isLoading && !providerQuery.data?.configured ? (
        <p role="alert" className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm text-warn">
          Configure {treasury.watch.chain === "sol:mainnet" ? "SOLANA_MAINNET_RPC_URL" : "SOLANA_DEVNET_RPC_URL"} in the desktop main-process environment, then restart ChainPay.
        </p>
      ) : null}
      {record?.error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">Solana sync failed: {record.error}</p> : null}
      {statusError ? <p role="alert" className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm text-warn">{statusError}</p> : null}
      {record?.rollbackDetected ? (
        <p role="alert" className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm text-warn">
          {record.rollbackSignatures.length > 0
            ? `Chain rollback detected for ${record.rollbackSignatures.length} transaction${record.rollbackSignatures.length === 1 ? "" : "s"}.`
            : "Chain rollback detected in the slot or blockhash context."} Current provider state has replaced stale status.
        </p>
      ) : null}

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Receive address</h2>
        <div className="mt-2 break-all font-mono text-sm text-accent">{treasury.watch.address}</div>
        <p className="mt-2 text-xs text-fg-muted">Public account only. ChainPay never holds signer secrets; durable-nonce payments require externally produced signatures.</p>
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Transaction history</h2>
        {snapshot?.transactions.length ? (
          <ul className="mt-3 divide-y divide-surface-hi">
            {snapshot.transactions.map((transaction) => (
              <li key={transaction.signature} className="flex items-center justify-between gap-4 py-3 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono">{transaction.signature}</div>
                  <div className="mt-1 text-fg-muted">Slot {formatThousands(BigInt(transaction.slot))} · {transaction.state}{transaction.blockTime ? ` · ${new Date(transaction.blockTime * 1000).toLocaleString()}` : ""}</div>
                  <div className="mt-1 text-fg-muted">Fee {transaction.feeLamports === null ? "unavailable" : `${formatLamports(transaction.feeLamports)} lamports`}{transaction.feePaidByWatched === null ? "" : transaction.feePaidByWatched ? " · paid by watched account" : " · paid by another account"}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={`font-medium tabular-nums ${transaction.netLamports !== null && BigInt(transaction.netLamports) >= 0n ? "text-accent" : "text-fg"}`}>
                    {transaction.netLamports === null ? "delta unavailable" : `${formatSignedSol(transaction.netLamports)} SOL`}
                  </span>
                  <button type="button" onClick={() => void refreshStatus(transaction.signature)} className="rounded border border-surface-hi px-2 py-1 text-fg-muted hover:text-fg">Check status</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-sm text-fg-muted">No transactions found.</p>}
      </section>
    </div>
  );
}

function CkbTreasuryDetail({ treasury }: { treasury: MultisigTreasury }) {
  const multisig = treasury.multisig as CkbMultisig;
  const cfg = useMemo<CkbMultisigConfig>(
    () => ({
      s: 0,
      r: 0,
      m: multisig.m,
      n: multisig.n,
      pubkeyHashes: multisig.pubkeyHashes,
      ...(multisig.since !== undefined ? { since: multisig.since } : {}),
    }),
    [multisig.m, multisig.n, multisig.pubkeyHashes, multisig.since],
  );
  const script = useMemo(() => treasuryLockScript(cfg), [cfg]);

  const ckbSync = useSyncStore((s) => s.ckb);
  const lcReady = ckbSync.started && ckbSync.tipBlockNumber > 0n;

  // Subscribe the light client to this lock script on mount; idempotent.
  // Start from a small buffer behind the current tip — full genesis back-scan
  // takes hours on testnet for what we actually want (recent funding txs).
  // A user-driven "rescan from block X" affordance lives in Phase 2.5.
  const SUBSCRIBE_BUFFER_BLOCKS = 200n;
  const [subscribed, setSubscribed] = useState(false);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  useEffect(() => {
    if (!lcReady || subscribed) return;
    const fromBlock =
      ckbSync.tipBlockNumber > SUBSCRIBE_BUFFER_BLOCKS
        ? ckbSync.tipBlockNumber - SUBSCRIBE_BUFFER_BLOCKS
        : 0n;
    let cancelled = false;
    void lightClient()
      .watchLockScript(script, fromBlock)
      .then(() => {
        if (!cancelled) setSubscribed(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setSubscribeError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [lcReady, subscribed, script, ckbSync.tipBlockNumber]);

  const balanceQuery = useQuery({
    queryKey: ["treasury-balance", multisig.address],
    queryFn: () => lightClient().getLockBalance(script),
    enabled: lcReady && subscribed,
    refetchInterval: 6_000,
  });

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link to="/treasury" className="text-xs text-fg-muted hover:text-fg">
            ← Treasury
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{treasury.label}</h1>
          <p className="text-sm text-fg-muted">
            {chainBadge(multisig.chain)} · {multisig.m}-of-{multisig.n} multisig
          </p>
        </div>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Tile
          label="Balance"
          value={balanceDisplay(balanceQuery.data, balanceQuery.isLoading, lcReady, subscribed)}
          hint={
            !lcReady
              ? "waiting for light client"
              : !subscribed
                ? "subscribing to lock…"
                : balanceQuery.dataUpdatedAt
                  ? `updated ${secondsAgo(balanceQuery.dataUpdatedAt)}s ago`
                  : "first fetch…"
          }
          tone="accent"
        />
        <Tile
          label="Sync tip"
          value={ckbSync.tipBlockNumber > 0n ? formatBlockNumber(ckbSync.tipBlockNumber) : "—"}
          hint={ckbSync.peers > 0 ? `${ckbSync.peers} peer${ckbSync.peers === 1 ? "" : "s"}` : "no peers yet"}
        />
        <Tile label="Pending tx" value="—" hint="Phase 2.5" />
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Address</h2>
        <div className="mt-2 break-all font-mono text-xs text-accent">{multisig.address}</div>
        <p className="mt-3 text-xs text-fg-muted">
          Fund this address to begin running payroll. Balance updates from the embedded light
          client every 6 seconds.
        </p>
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Co-signer pubkey hashes</h2>
        <ul className="mt-3 space-y-1">
          {multisig.pubkeyHashes.map((h, i) => (
            <li key={`${h}-${i}`} className="flex items-baseline gap-3 text-xs">
              <span className="w-6 text-fg-muted tabular-nums">{i + 1}.</span>
              <span className="break-all font-mono">{h}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-fg-muted">
          Any {multisig.m} of these signers must approve a transaction.
        </p>
      </section>

      {subscribeError ? (
        <p className="text-xs text-danger">subscribe failed: {subscribeError}</p>
      ) : null}
      {balanceQuery.error ? (
        <p className="text-xs text-danger">
          balance fetch failed: {(balanceQuery.error as Error).message}
        </p>
      ) : null}
    </div>
  );
}

function EvmTreasuryDetail({ treasury }: { treasury: MultisigTreasury }) {
  const multisig = treasury.multisig as EvmMultisig;
  const chainId = Number(multisig.chain.slice("evm:".length));
  const safeQuery = useQuery({
    queryKey: ["safe-snapshot", chainId, multisig.address],
    queryFn: () => readSafeSnapshot(chainId, multisig.address),
    refetchInterval: 12_000,
  });
  const snapshot = safeQuery.data;
  const owners = snapshot?.owners ?? multisig.owners;
  const threshold = snapshot?.threshold ?? multisig.threshold;
  const configChanged =
    snapshot !== undefined &&
    (snapshot.threshold !== multisig.threshold ||
      snapshot.version !== multisig.version ||
      snapshot.owners.map((owner) => owner.toLowerCase()).join(",") !==
        multisig.owners.map((owner) => owner.toLowerCase()).join(","));

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link to="/treasury" className="text-xs text-fg-muted hover:text-fg">
            ← Treasury
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{treasury.label}</h1>
          <p className="text-sm text-fg-muted">
            Sepolia · {threshold}-of-{owners.length} Safe · v{snapshot?.version ?? multisig.version}
          </p>
        </div>
        <Link
          to={`/treasury/${treasury.id}/payment/new`}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
        >
          New payment
        </Link>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Tile
          label="Balance"
          value={snapshot ? `${formatEth(snapshot.balanceWei)} ETH` : safeQuery.isLoading ? "…" : "—"}
          hint={
            safeQuery.dataUpdatedAt
              ? `updated ${secondsAgo(safeQuery.dataUpdatedAt)}s ago`
              : "reading Sepolia…"
          }
          tone="accent"
        />
        <Tile label="Safe threshold" value={`${threshold} / ${owners.length}`} hint="owners required" />
        <Tile
          label="Block"
          value={snapshot ? formatBlockNumber(snapshot.blockNumber) : "—"}
          hint="Sepolia RPC tip"
        />
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Safe contract</h2>
        <div className="mt-2 break-all font-mono text-xs text-accent">{multisig.address}</div>
        <p className="mt-3 text-xs text-fg-muted">
          Read-only monitoring is live. Safe transaction creation and owner signing land in the
          next slice.
        </p>
      </section>

      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="text-sm font-medium text-fg-muted">Owners</h2>
        <ul className="mt-3 space-y-1">
          {owners.map((owner, index) => (
            <li key={owner} className="flex items-baseline gap-3 text-xs">
              <span className="w-6 text-fg-muted tabular-nums">{index + 1}.</span>
              <span className="break-all font-mono">{owner}</span>
            </li>
          ))}
        </ul>
      </section>

      {configChanged ? (
        <p className="rounded-md border border-warn/40 bg-warn/5 p-3 text-xs text-warn">
          This Safe's on-chain owners, threshold, or version changed since it was added. Live
          values are shown.
        </p>
      ) : null}
      {safeQuery.error ? (
        <p className="text-xs text-danger">Safe refresh failed: {(safeQuery.error as Error).message}</p>
      ) : null}
    </div>
  );
}

function BitcoinWatchDetail({ treasury }: { treasury: BitcoinWatchTreasury }) {
  const source = treasury.watch.source;
  const record = useBitcoinWatchStore((state) => state.records[treasury.id]);
  const broadcast = useBitcoinBroadcastStore((state) => state.records[treasury.id]);
  const [rawTxHex, setRawTxHex] = useState(() => broadcast?.rawTxHex ?? "");
  const [confirmedReview, setConfirmedReview] = useState(false);
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
  const receiptStatusQuery = useQuery({
    queryKey: ["bitcoin-broadcast-status", treasury.id, broadcast?.receipt?.txid],
    queryFn: () => bitcoinBridge().transactionStatus({ chain: treasury.watch.chain, txid: broadcast!.receipt!.txid }),
    enabled: providerQuery.data?.configured === true && Boolean(broadcast?.receipt),
    retry: false,
    refetchInterval: 30_000,
  });
  useEffect(() => {
    if (receiptStatusQuery.data) useBitcoinBroadcastStore.getState().refreshStatus(treasury.id, receiptStatusQuery.data);
  }, [receiptStatusQuery.data, treasury.id]);

  async function reviewRawTransaction(): Promise<void> {
    const raw = rawTxHex.trim();
    useBitcoinBroadcastStore.getState().beginReview(treasury.id, treasury.watch.chain, raw);
    setConfirmedReview(false);
    try {
      const response = await bitcoinBridge().reviewBroadcast({
        chain: treasury.watch.chain,
        treasuryId: treasury.id,
        watchedAddresses,
        rawTxHex: raw,
      });
      if (response.ok) useBitcoinBroadcastStore.getState().acceptReview(treasury.id, response.review);
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
          onChange={(event) => { setRawTxHex(event.target.value); setConfirmedReview(false); }}
          rows={5}
          spellCheck={false}
          placeholder="020000000001…"
          className="mt-3 w-full rounded-md border border-surface-hi bg-bg p-3 font-mono text-xs text-fg outline-none focus:border-accent"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void reviewRawTransaction()}
            disabled={!providerQuery.data?.configured || !rawTxHex.trim() || broadcast?.state === "reviewing" || broadcast?.state === "submitting"}
            className="rounded-md border border-accent px-3 py-2 text-sm text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {broadcast?.state === "reviewing" ? "Reviewing…" : "Review signed transaction"}
          </button>
          {broadcast ? <span className="text-xs text-fg-muted">State: {broadcastStateLabel(broadcast.state)}</span> : null}
        </div>

        {broadcast?.error ? (
          <p role="alert" className={`mt-3 rounded-md border p-3 text-sm ${broadcast.error.code === "provider_unavailable" ? "border-warn/40 bg-warn/5 text-warn" : broadcast.state === "already_broadcast" ? "border-accent/40 bg-accent/5 text-accent" : "border-danger/40 bg-danger/5 text-danger"}`}>
            {broadcast.error.message}
          </p>
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
            {receiptStatusQuery.error ? <div className="mt-2 text-warn">Status refresh is temporarily unavailable.</div> : null}
            {broadcast.reorged ? <div role="alert" className="mt-2 text-warn">A prior confirmation was reorged; the transaction is being tracked again.</div> : null}
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

function formatBtc(satoshiText: string): string {
  const sats = BigInt(satoshiText);
  const whole = sats / 100_000_000n;
  const fractional = (sats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fractional ? `${formatThousands(whole)}.${fractional}` : formatThousands(whole);
}

function formatSignedBtc(satoshiText: string): string {
  const sats = BigInt(satoshiText);
  if (sats < 0n) return `-${formatBtc((-sats).toString())}`;
  return `+${formatBtc(sats.toString())}`;
}

function formatSol(lamportText: string): string {
  const lamports = BigInt(lamportText);
  const whole = lamports / 1_000_000_000n;
  const fractional = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fractional ? `${formatThousands(whole)}.${fractional}` : formatThousands(whole);
}

function formatSignedSol(lamportText: string): string {
  const lamports = BigInt(lamportText);
  return lamports < 0n ? `-${formatSol((-lamports).toString())}` : `+${formatSol(lamports.toString())}`;
}

function formatLamports(lamportText: string): string {
  return formatThousands(BigInt(lamportText));
}

function ReviewValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-surface-hi p-3">
      <div className="text-fg-muted">{label}</div>
      <div className="mt-1 font-medium tabular-nums">{value}</div>
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

function formatEth(wei: bigint): string {
  const value = formatEther(wei);
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, 6).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole!;
}

function Tile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "accent";
}) {
  const valueClass = tone === "accent" ? "text-accent" : "text-fg";
  return (
    <div className="rounded-lg border border-surface-hi bg-surface p-5">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      <div className="mt-1 text-xs text-fg-muted">{hint}</div>
    </div>
  );
}

function balanceDisplay(
  shannons: bigint | undefined,
  isLoading: boolean,
  lcReady: boolean,
  subscribed: boolean,
): string {
  if (!lcReady) return "—";
  if (!subscribed) return "…";
  if (isLoading && shannons === undefined) return "…";
  if (shannons === undefined) return "—";
  return `${formatCkb(shannons)} CKB`;
}

function formatCkb(shannons: bigint): string {
  const whole = shannons / SHANNONS_PER_CKB;
  const fractional = shannons % SHANNONS_PER_CKB;
  if (fractional === 0n) return formatThousands(whole);
  // Trim trailing zeros from the 8-digit fractional part for readability.
  const fracStr = fractional.toString().padStart(8, "0").replace(/0+$/, "");
  return `${formatThousands(whole)}.${fracStr}`;
}

function formatThousands(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatBlockNumber(n: bigint): string {
  return formatThousands(n);
}

function secondsAgo(timestampMs: number): number {
  return Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
}

function chainBadge(chain: string): string {
  if (chain === "ckb:mainnet") return "CKB mainnet";
  if (chain === "ckb:testnet") return "CKB testnet";
  if (chain.startsWith("evm:")) return `EVM ${chain.slice(4)}`;
  if (chain === "btc:mainnet") return "Bitcoin mainnet";
  if (chain === "btc:testnet") return "Bitcoin testnet";
  if (chain === "sol:mainnet") return "Solana mainnet";
  if (chain === "sol:devnet") return "Solana devnet";
  return chain;
}
