import { useState } from "react";
import { useNetworkConfigStore } from "@/stores/network-config";
import { NetworkRestartModal } from "./NetworkRestartModal";
import type { CkbNetwork } from "@/lib/light-client/network-configs";

const WIPE_FLAG_KEY = "chain-pay:wipe-lc-on-next-boot";

export function NetworkSection() {
  const persistedNetwork = useNetworkConfigStore((s) => s.network);
  const setNetworkPersisted = useNetworkConfigStore((s) => s.setNetwork);
  const broadcastRpcUrl = useNetworkConfigStore((s) => s.broadcastRpcUrl);
  const setBroadcastRpcUrl = useNetworkConfigStore((s) => s.setBroadcastRpcUrl);

  const [pending, setPending] = useState<CkbNetwork>(persistedNetwork);
  const [modalOpen, setModalOpen] = useState(false);
  const [rpcDraft, setRpcDraft] = useState(broadcastRpcUrl);

  const canApply = pending !== persistedNetwork;

  function onPick(next: CkbNetwork): void {
    setPending(next);
  }

  function onApply(): void {
    if (!canApply) return;
    setModalOpen(true);
  }

  function onCancelModal(): void {
    setModalOpen(false);
    setPending(persistedNetwork);
  }

  async function confirmAndQuit(): Promise<void> {
    setNetworkPersisted(pending);
    globalThis.localStorage?.setItem(WIPE_FLAG_KEY, "true");
    await (
      globalThis as unknown as {
        electron: { network: { set: (n: CkbNetwork) => Promise<void> } };
      }
    ).electron.network.set(pending);
    (
      globalThis as unknown as { electron: { app: { quit: () => void } } }
    ).electron.app.quit();
  }

  function onConfirmModal(): void {
    void confirmAndQuit();
  }

  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold">Network</h2>
      <fieldset className="space-y-2">
        <legend className="text-xs uppercase tracking-wide text-neutral-400 mb-1">
          CKB Network (requires restart)
        </legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="ckb-network"
            value="testnet"
            checked={pending === "testnet"}
            onChange={() => onPick("testnet")}
          />
          <span>Testnet</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="ckb-network"
            value="mainnet"
            checked={pending === "mainnet"}
            onChange={() => onPick("mainnet")}
          />
          <span>Mainnet</span>
        </label>
        <button
          type="button"
          onClick={onApply}
          disabled={!canApply}
          className="mt-2 px-3 py-1.5 text-sm rounded bg-amber-600 disabled:bg-neutral-700 disabled:text-neutral-500 hover:bg-amber-500"
        >
          Apply network change
        </button>
      </fieldset>
      <div className="space-y-1">
        <label
          htmlFor="broadcast-rpc-url"
          className="text-xs uppercase tracking-wide text-neutral-400 block"
        >
          Transaction broadcast RPC URL
        </label>
        <input
          id="broadcast-rpc-url"
          type="text"
          value={rpcDraft}
          onChange={(e) => setRpcDraft(e.target.value)}
          onBlur={() => setBroadcastRpcUrl(rpcDraft)}
          placeholder="http://localhost:8114"
          className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm"
        />
        <p className="text-xs text-neutral-500">
          Empty = use embedded light client (unreliable for relay on public networks).
        </p>
      </div>
      {modalOpen ? (
        <NetworkRestartModal
          fromNetwork={persistedNetwork}
          toNetwork={pending}
          onCancel={onCancelModal}
          onConfirm={onConfirmModal}
        />
      ) : null}
    </section>
  );
}
