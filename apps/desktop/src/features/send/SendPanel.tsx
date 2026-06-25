import { useState } from "react";
import { useSourcesStore } from "@/stores/sources";
import { useSendsStore } from "@/stores/sends";
import { useNetworkConfigStore } from "@/stores/network-config";
import { SendHistory } from "./SendHistory";
import type { SendOutput, SendRecord } from "@chain-pay/shared";

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
    fiatAmount: "0",
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
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const source = sources.find((s) => s.id === sourceId);

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
      const ckb = parseFloat(r.amountCkb);
      if (isNaN(ckb) || ckb <= 0) return "Each payee must have a positive CKB amount.";
      if (BigInt(Math.round(ckb * 1e8)) < MIN_RECIPIENT_CKB * SHANNONS_PER_CKB) {
        return `Minimum send per payee is ${MIN_RECIPIENT_CKB} CKB (minimum cell capacity).`;
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
          value: BigInt(Math.round(parseFloat(r.amountCkb) * 1e8)),
          decimals: 8,
        },
        fiat: {
          currency: r.currency,
          minor: BigInt(Math.round(parseFloat(r.fiatAmount) * 100)),
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

      const { useSendsStore: sendsStore } = await import("@/stores/sends");
      sendsStore.getState().addSend(draft);
      sendsStore.getState().markBuilt(draft.id, 0n);

      const { resolveJoyIdScriptInfo } = await import("@/lib/chains/ckb/joyid-lock");
      const { JoyIdCkbTxSigner } = await import("@/lib/signers/joyid-ckb-tx-signer");
      const { buildAndSend } = await import("@/lib/send/build-and-send");
      const { lightClient } = await import("@/lib/light-client/client");
      const { Address, ClientPublicTestnet, ClientPublicMainnet } = await import("@ckb-ccc/core");

      const host = lightClient();
      const client =
        network === "mainnet" ? new ClientPublicMainnet() : new ClientPublicTestnet();
      const scriptInfo = await resolveJoyIdScriptInfo(network);

      // Forward-note #1: MUST pass source.address so signTransaction doesn't throw.
      const signer = new JoyIdCkbTxSigner({
        name: "ChainPay",
        logo: "https://chainpay.local/logo.png",
        joyidAppURL: "https://app.joy.id",
        address: source.address,
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

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Send</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Single-sig JoyID payments. Select a source wallet and add payee rows.
        </p>
      </header>

      {sources.length === 0 ? (
        <div className="rounded-lg border border-dashed border-surface-hi bg-surface/50 p-6 text-center text-sm text-fg-muted">
          No source wallets. Go to{" "}
          <a href="/send/sources" className="text-accent hover:underline">
            Source wallets
          </a>{" "}
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
              <span>Fiat amount</span>
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
                  min="0"
                  step="0.01"
                  placeholder="0.00"
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
                {rows
                  .reduce((acc, r) => acc + (parseFloat(r.amountCkb) || 0), 0)
                  .toFixed(4)}{" "}
                CKB
              </span>
            </div>
            <div>Fee rate: 1 200 shannons/KB (20% buffer over pool minimum)</div>
            <div>Min capacity per output: 61 CKB</div>
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
              disabled={sending || !source}
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
