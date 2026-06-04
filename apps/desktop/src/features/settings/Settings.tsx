import { useEffect, useState } from "react";
import { useNetworkConfigStore } from "@/stores/network-config";
import { useDebugSettingsStore } from "@/stores/debug-settings";
import { lightClient } from "@/lib/light-client/client";
import { NetworkSection } from "./NetworkSection";
import { CommChannelSection } from "./CommChannelSection";
import { PeerBookSection } from "./PeerBookSection";
import { ExtractionSection } from "./ExtractionSection";
import { PairingSection } from "./PairingSection";

export function Settings() {
  const broadcastRpcUrl = useNetworkConfigStore((s) => s.broadcastRpcUrl);
  const setBroadcastRpcUrl = useNetworkConfigStore((s) => s.setBroadcastRpcUrl);
  const showClipboard = useDebugSettingsStore((s) => s.showClipboard);
  const setShowClipboard = useDebugSettingsStore((s) => s.setShowClipboard);
  const [draft, setDraft] = useState(broadcastRpcUrl);
  const [pairInfo, setPairInfo] = useState<{ certFingerprint: string; port: number } | null>(null);

  useEffect(() => {
    setDraft(broadcastRpcUrl);
  }, [broadcastRpcUrl]);

  useEffect(() => {
    void window.chainpay.pair.info().then(setPairInfo);
  }, []);

  function save() {
    setBroadcastRpcUrl(draft);
    lightClient().setBroadcastRpcUrl(draft.trim());
  }

  const dirty = draft.trim() !== broadcastRpcUrl;
  const using = broadcastRpcUrl ? "full-node JSON-RPC" : "embedded light client (unreliable on public testnet)";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <NetworkSection />

      <ExtractionSection />

      <section className="space-y-3 rounded-lg border border-surface-hi bg-surface p-5">
        <header>
          <div className="text-xs uppercase tracking-wide text-fg-muted">Transaction broadcast</div>
          <p className="mt-1 text-sm text-fg-muted">
            Override the broadcast path with a full-node CKB JSON-RPC URL. The light
            client stays in charge of reads (balance, watching, history), but
            transactions are submitted through this endpoint — necessary on public
            testnet, where peers reject tx relay from light clients.
          </p>
        </header>

        <label className="block">
          <span className="text-xs text-fg-muted">Broadcast RPC URL</span>
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="http://192.168.68.134:8114"
              spellCheck={false}
              className="flex-1 rounded-md border border-surface-hi bg-bg px-3 py-2 font-mono text-xs text-fg"
            />
            <button
              type="button"
              onClick={save}
              disabled={!dirty}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save
            </button>
          </div>
          <p className="mt-2 text-xs text-fg-muted">
            Currently using: <span className="text-fg">{using}</span>
          </p>
          {broadcastRpcUrl ? (
            <button
              type="button"
              onClick={() => {
                setDraft("");
                setBroadcastRpcUrl("");
                lightClient().setBroadcastRpcUrl("");
              }}
              className="mt-2 text-xs text-fg-muted underline hover:text-fg"
            >
              clear · fall back to light client
            </button>
          ) : null}
        </label>

        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer hover:text-fg">Why this is needed</summary>
          <p className="mt-2">
            The embedded ckb-light-client computes a tx hash locally and submits to its
            P2P peers, but most testnet peers drop tx relay from light clients to
            prevent spam — so "Broadcast successful" can be a false positive. Pointing
            broadcasts at a node you control (or any full node with{" "}
            <code>rpc.allow_methods = ["send_transaction", …]</code> enabled and
            permissive CORS) makes the broadcast deterministic.
          </p>
        </details>
      </section>

      <div className="grid grid-cols-2 gap-4">
        <Card title="CKB network" body="Testnet · embedded light client (reads)" />
        <Card title="EVM chains" body="Phase 3 — not connected" />
        <Card title="Signer transports" body="ckb-cli keystore (CKB). JoyID, Ledger, MetaMask, WalletConnect — Phase 3+" />
        <Card title="Frappe backend" body="Not connected · Phase 4" />
      </div>
      <CommChannelSection />
      <PeerBookSection />

      {pairInfo && (
        <PairingSection
          rpcHost="192.168.68.102"
          rpcPort={pairInfo.port}
          certFingerprint={pairInfo.certFingerprint}
          onCertRotated={(info) =>
            setPairInfo({ certFingerprint: info.fingerprint, port: info.port })
          }
        />
      )}

      <section className="space-y-3 rounded-lg border border-surface-hi bg-surface p-5" aria-label="Debug">
        <header>
          <div className="text-xs uppercase tracking-wide text-fg-muted">Debug</div>
          <p className="mt-1 text-sm text-fg-muted">
            Tools for debugging, generally not needed in normal operation.
          </p>
        </header>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showClipboard}
            onChange={(e) => setShowClipboard(e.target.checked)}
          />
          Show clipboard bottom-bar (overrides auto-hide when comm is configured)
        </label>
      </section>
    </div>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-surface-hi bg-surface p-5">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{title}</div>
      <div className="mt-2 text-sm">{body}</div>
    </div>
  );
}
