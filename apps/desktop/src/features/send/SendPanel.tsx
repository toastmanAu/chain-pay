import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useSourcesStore } from "@/stores/sources";
import { useSendsStore } from "@/stores/sends";
import { useNetworkConfigStore } from "@/stores/network-config";
import { SendHistory } from "./SendHistory";
import { JoyIdSignModal } from "./JoyIdSignModal";
import { UnlockModal } from "@/features/keyvault/UnlockModal";
import type { SendOutput, SendRecord } from "@chain-pay/shared";
import {
  sendAffordability,
  SEND_FEE_RESERVE_SHANNONS,
  type Affordability,
} from "@/lib/send";
import { ckbStringToShannons, shannonsToCkbString } from "@/lib/send/ckb-amount";
import { parseFiatMajorToMinor } from "@/lib/send/fiat-value";

const SHANNONS_PER_CKB = 100_000_000n;
/** Minimum cell capacity: 61 CKB for a secp recipient cell. */
const MIN_RECIPIENT_CKB = 61n;

interface PayeeRow {
  id: string;
  address: string;
  amountCkb: string;
  fiatAmount: string;
  currency: string;
}

function makeRow(): PayeeRow {
  return {
    id: crypto.randomUUID(),
    address: "",
    amountCkb: "",
    fiatAmount: "",
    currency: "USD",
  };
}

const inputCls =
  "w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted/60";

const selectCls =
  "rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm text-fg";

export function SendPanel() {
  const sources = useSourcesStore((s) => s.sources);
  const activeSourceId = useSourcesStore((s) => s.activeSourceId);
  const network = useNetworkConfigStore((s) => s.network);

  const [sourceId, setSourceId] = useState<string>(activeSourceId ?? sources[0]?.id ?? "");
  const [rows, setRows] = useState<PayeeRow[]>([makeRow()]);
  const [sending, setSending] = useState(false);
  const [unlockModalOpen, setUnlockModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [affordability, setAffordability] = useState<Affordability | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const source = sources.find((s) => s.id === sourceId);

  /** Recompute the outputs total in shannons from the current rows. */
  const outputsTotalShannons = rows.reduce<bigint>((acc, r) => {
    const shannons = ckbStringToShannons(r.amountCkb);
    // null (invalid/empty) or 0n rows contribute nothing to the total
    return acc + (shannons !== null && shannons > 0n ? shannons : 0n);
  }, 0n);

  useEffect(() => {
    if (!source || outputsTotalShannons === 0n) {
      setAffordability(null);
      setBalanceError(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        setBalanceError(null);
        const { lightClient } = await import("@/lib/light-client/client");

        let balance: bigint;
        if (source.lockKind === "secp256k1") {
          const { resolveSecp256k1ScriptInfo, secp256k1LockAndDeps } = await import(
            "@/lib/chains/ckb/secp256k1-lock"
          );
          const scriptInfo = await resolveSecp256k1ScriptInfo(network);
          const { lock } = secp256k1LockAndDeps(scriptInfo, source.joyidLockArgs);
          balance = await lightClient().getLockBalance(lock);
        } else {
          const { resolveJoyIdScriptInfo, joyidLockAndDeps } = await import(
            "@/lib/chains/ckb/joyid-lock"
          );
          const scriptInfo = await resolveJoyIdScriptInfo(network);
          const { lock } = joyidLockAndDeps(scriptInfo, source.joyidLockArgs);
          balance = await lightClient().getLockBalance(lock);
        }

        if (!cancelled) {
          setAffordability(
            sendAffordability(outputsTotalShannons, SEND_FEE_RESERVE_SHANNONS, balance),
          );
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setBalanceError(
            err instanceof Error ? err.message : "Balance check failed",
          );
          setAffordability(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, outputsTotalShannons, network]);

  function updateRow(id: string, patch: Partial<PayeeRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, makeRow()]);
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  /** Return validation errors for the current row set. */
  function validateRows(): string | null {
    for (const r of rows) {
      if (!r.address.trim()) return "Each payee must have an address.";
      const shannons = ckbStringToShannons(r.amountCkb);
      if (shannons === null || shannons <= 0n) return "Each payee must have a positive CKB amount.";
      if (shannons < MIN_RECIPIENT_CKB * SHANNONS_PER_CKB) {
        return `Minimum send per payee is ${MIN_RECIPIENT_CKB} CKB (minimum cell capacity).`;
      }
      const fiatMinor = parseFiatMajorToMinor(r.fiatAmount);
      if (fiatMinor === null || fiatMinor <= 0n) {
        return "Each payee must have a positive fiat accounting value.";
      }
      if (!/^[A-Z]{3}$/.test(r.currency)) {
        return "Each payee must have a three-letter fiat currency code.";
      }
    }
    return null;
  }

  async function handleSend() {
    if (!source) {
      setError("Select a source wallet first.");
      return;
    }
    const validErr = validateRows();
    if (validErr) {
      setError(validErr);
      return;
    }

    // Local-keystore (secp256k1) path: collect password via the UnlockModal first.
    // The rest of the send runs inside handleSecp256k1Send once the password is submitted.
    if (source.lockKind === "secp256k1") {
      setError(null);
      setSuccess(null);
      setUnlockModalOpen(true);
      return;
    }

    // JoyID relay path (default)
    setSending(true);
    setError(null);
    setSuccess(null);

    try {
      const chain: SendRecord["chain"] =
        network === "mainnet" ? "ckb:mainnet" : "ckb:testnet";

      const outputs: SendOutput[] = rows.map((r) => ({
        payeeId: r.address,
        payeeAddress: r.address.trim(),
        amount: {
          asset: "CKB",
          // ckbStringToShannons returns non-null here: validateRows() passed above
          value: ckbStringToShannons(r.amountCkb) ?? 0n,
          decimals: 8,
        },
        fiat: {
          currency: r.currency,
          minor: parseFiatMajorToMinor(r.fiatAmount) ?? 0n,
        },
      }));

      const now = new Date().toISOString();
      const draft: SendRecord = {
        id: crypto.randomUUID(),
        sourceId: source.id,
        chain,
        outputs,
        feeShannons: 0n,
        state: "draft",
        createdAt: now,
        updatedAt: now,
      };

      useSendsStore.getState().addSend(draft);
      useSendsStore.getState().markBuilt(draft.id, 0n);

      const { resolveJoyIdScriptInfo } = await import("@/lib/chains/ckb/joyid-lock");
      const { JoyIdRelaySigner } = await import("@/lib/signers/joyid-relay-ckb-tx-signer");
      const { makePresenter } = await import("@/stores/joyid-sign");
      const { buildAndSend } = await import("@/lib/send/build-and-send");
      const { lightClient } = await import("@/lib/light-client/client");
      const { Address, ClientPublicTestnet, ClientPublicMainnet } = await import("@ckb-ccc/core");

      const host = lightClient();
      const client =
        network === "mainnet" ? new ClientPublicMainnet() : new ClientPublicTestnet();
      const scriptInfo = await resolveJoyIdScriptInfo(network);

      const signer = new JoyIdRelaySigner({
        network,
        address: source.address,
        presenter: makePresenter(),
      });

      const { txHash } = await buildAndSend(
        draft,
        source,
        signer,
        1200n,
        {
          listCellsForLock: (lock) => host.listCellsForLock(lock),
          broadcast: (tx) => host.broadcastTransaction(tx),
          resolveRecipientLock: async (addr) => (await Address.fromString(addr, client)).script,
          scriptInfo,
          markSigning: (id) => useSendsStore.getState().markSigning(id),
          markBroadcasted: (id, hash) =>
            useSendsStore.getState().markBroadcasted(id, hash as `0x${string}`),
          markBackToBuilt: (id) => useSendsStore.getState().markBackToBuilt(id),
        },
      );

      setSuccess(`Broadcasted · ${txHash}`);
      setRows([makeRow()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  /**
   * secp256k1 (local-keystore) send path. Called by the UnlockModal's onSubmit
   * after the user has entered their password.
   *
   * Security invariants:
   * - `password` is a plain function parameter — it lives only in this frame.
   * - It is passed once to `LocalKeystoreCkbTxSigner` then goes out of scope.
   * - It is NEVER stored in Zustand, component state, or any persistent layer.
   * - Main-process vault zeroizes the password after signing.
   */
  async function handleSecp256k1Send(password: string): Promise<void> {
    // Capture source from the current render closure; guard against a race where
    // the source is deselected between modal open and confirm.
    const src = source;
    if (!src) return;
    if (!src.keyvaultId) {
      setError("Source wallet has no associated keystore.");
      return;
    }

    setUnlockModalOpen(false);
    setSending(true);
    setError(null);
    setSuccess(null);

    try {
      const chain: SendRecord["chain"] =
        network === "mainnet" ? "ckb:mainnet" : "ckb:testnet";

      const outputs: SendOutput[] = rows.map((r) => ({
        payeeId: r.address,
        payeeAddress: r.address.trim(),
        amount: {
          asset: "CKB",
          value: ckbStringToShannons(r.amountCkb) ?? 0n,
          decimals: 8,
        },
        fiat: {
          currency: r.currency,
          minor: parseFiatMajorToMinor(r.fiatAmount) ?? 0n,
        },
      }));

      const now = new Date().toISOString();
      const draft: SendRecord = {
        id: crypto.randomUUID(),
        sourceId: src.id,
        chain,
        outputs,
        feeShannons: 0n,
        state: "draft",
        createdAt: now,
        updatedAt: now,
      };

      useSendsStore.getState().addSend(draft);
      useSendsStore.getState().markBuilt(draft.id, 0n);

      const { resolveSecp256k1ScriptInfo } = await import("@/lib/chains/ckb/secp256k1-lock");
      const { resolveJoyIdScriptInfo } = await import("@/lib/chains/ckb/joyid-lock");
      const { LocalKeystoreCkbTxSigner } = await import(
        "@/lib/signers/local-keystore-ckb-tx-signer"
      );
      const { buildAndSend } = await import("@/lib/send/build-and-send");
      const { lightClient } = await import("@/lib/light-client/client");
      const { Address, ClientPublicTestnet, ClientPublicMainnet } = await import("@ckb-ccc/core");

      const host = lightClient();
      const client =
        network === "mainnet" ? new ClientPublicMainnet() : new ClientPublicTestnet();

      // Resolve both script infos concurrently.
      // secp256k1ScriptInfo drives the source lock; scriptInfo (JoyID) satisfies
      // the required SendDeps.scriptInfo field (unused for secp256k1 sources in buildAndSend).
      const [scriptInfo, secp256k1ScriptInfo] = await Promise.all([
        resolveJoyIdScriptInfo(network),
        resolveSecp256k1ScriptInfo(network),
      ]);

      const signer = new LocalKeystoreCkbTxSigner({
        keyvaultId: src.keyvaultId,
        derivationIndex: src.derivationIndex ?? 0,
        sourceLockArgs: src.joyidLockArgs,
        password,
        bridge: window.chainpay.keyvault,
      });

      const { txHash } = await buildAndSend(
        draft,
        src,
        signer,
        1200n,
        {
          listCellsForLock: (lock) => host.listCellsForLock(lock),
          broadcast: (tx) => host.broadcastTransaction(tx),
          resolveRecipientLock: async (addr) => (await Address.fromString(addr, client)).script,
          scriptInfo,
          secp256k1ScriptInfo,
          markSigning: (id) => useSendsStore.getState().markSigning(id),
          markBroadcasted: (id, hash) =>
            useSendsStore.getState().markBroadcasted(id, hash as `0x${string}`),
          markBackToBuilt: (id) => useSendsStore.getState().markBackToBuilt(id),
        },
      );

      // `password` leaves scope here — only the signer held it and the signer
      // is now out of scope too. Main already zeroized inside the vault.
      setSuccess(`Broadcasted · ${txHash}`);
      setRows([makeRow()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-8">
      <JoyIdSignModal />
      <UnlockModal
        open={unlockModalOpen}
        onSubmit={(password) => {
          if (source) void handleSecp256k1Send(password);
        }}
        onClose={() => setUnlockModalOpen(false)}
      />
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Send</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Single-sig payments. Select a source wallet and add payee rows.
          </p>
        </div>
        {/* Persistent path to wallet management — adding a source must never
            strand the user with no way back to connect/add another wallet. */}
        <Link
          to="/send/sources"
          className="shrink-0 rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm font-medium hover:opacity-90"
        >
          Manage wallets
        </Link>
      </header>

      {sources.length === 0 ? (
        <div className="rounded-lg border border-dashed border-surface-hi bg-surface/50 p-6 text-center text-sm text-fg-muted">
          No source wallets. Go to{" "}
          <Link to="/send/sources" className="text-accent hover:underline">
            Source wallets
          </Link>{" "}
          to connect a JoyID wallet first.
        </div>
      ) : (
        <section className="space-y-4 rounded-lg border border-surface-hi bg-surface p-4">
          <h2 className="font-medium">New send</h2>

          {/* Source selector */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-fg-muted">Source wallet</label>
            <select
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className={selectCls}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} · {s.address.slice(0, 20)}…
                </option>
              ))}
            </select>
          </div>

          {/* Payee rows */}
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_120px_120px_80px_auto] gap-2 text-xs font-medium text-fg-muted">
              <span>Payee address</span>
              <span>CKB amount</span>
              <span>Fiat value (required)</span>
              <span>Currency</span>
              <span />
            </div>
            {rows.map((r) => (
              <div key={r.id} className="grid grid-cols-[1fr_120px_120px_80px_auto] gap-2">
                <input
                  type="text"
                  placeholder="ckt1q..."
                  value={r.address}
                  onChange={(e) => updateRow(r.id, { address: e.target.value })}
                  className={inputCls}
                />
                <input
                  type="number"
                  min="61"
                  step="1"
                  placeholder="≥61"
                  value={r.amountCkb}
                  onChange={(e) => updateRow(r.id, { amountCkb: e.target.value })}
                  className={inputCls}
                />
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="0.01+"
                  value={r.fiatAmount}
                  onChange={(e) => updateRow(r.id, { fiatAmount: e.target.value })}
                  className={inputCls}
                />
                <input
                  type="text"
                  maxLength={4}
                  placeholder="USD"
                  value={r.currency}
                  onChange={(e) => updateRow(r.id, { currency: e.target.value.toUpperCase() })}
                  className={inputCls}
                />
                <button
                  type="button"
                  onClick={() => removeRow(r.id)}
                  disabled={rows.length <= 1}
                  className="rounded-md border border-surface-hi px-2 py-1 text-xs text-fg-muted hover:border-danger hover:text-danger disabled:opacity-30"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {/* Review summary */}
          <div className="space-y-1 rounded-md bg-bg px-3 py-2 text-xs text-fg-muted">
            <div>
              Total:{" "}
              <span className="font-medium text-fg tabular-nums">
                {shannonsToCkbString(outputsTotalShannons)}{" "}
                CKB
              </span>
            </div>
            <div>Fee rate: 1 200 shannons/KB (20% buffer over pool minimum)</div>
            <div>Min capacity per output: 61 CKB</div>
            {balanceError ? (
              <div className="text-warning">Balance check unavailable: {balanceError}</div>
            ) : affordability !== null && !affordability.affordable ? (
              <div className="font-medium text-danger">
                Insufficient balance — short by{" "}
                {shannonsToCkbString(affordability.shortfallShannons)} CKB
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={addRow}
              className="rounded-md border border-surface-hi px-3 py-1.5 text-sm text-fg-muted hover:text-fg"
            >
              + Add payee
            </button>
            <button
              type="button"
              onClick={() => void handleSend()}
              // Fail-open intent: affordability===null (balance fetch failed or rows empty)
              // does NOT block send — graceful degrade. Only explicit affordable===false blocks.
              disabled={sending || unlockModalOpen || !source || affordability?.affordable === false}
              className="rounded-md bg-accent px-5 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>

          {error ? <p className="text-xs text-danger">{error}</p> : null}
          {success ? <p className="text-xs text-accent">{success}</p> : null}
        </section>
      )}

      <SendHistory />
    </div>
  );
}
