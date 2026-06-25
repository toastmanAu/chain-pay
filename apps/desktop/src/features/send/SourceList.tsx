import { useState } from "react";
import { useSourcesStore } from "@/stores/sources";
import type { Source } from "@chain-pay/shared";

export function SourceList() {
  const sources = useSourcesStore((s) => s.sources);
  const activeSourceId = useSourcesStore((s) => s.activeSourceId);
  const setActiveSource = useSourcesStore((s) => s.setActiveSource);
  const removeSource = useSourcesStore((s) => s.removeSource);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    try {
      const { JoyIdCkbTxSigner } = await import("@/lib/signers/joyid-ckb-tx-signer");
      const { Address, ClientPublicTestnet } = await import("@ckb-ccc/core");
      const signer = new JoyIdCkbTxSigner({
        name: "ChainPay",
        logo: "https://chainpay.local/logo.png",
        joyidAppURL: "https://app.joy.id",
      });
      const { address } = await signer.connect();
      const client = new ClientPublicTestnet();
      const parsed = await Address.fromString(address, client);
      const now = new Date().toISOString();
      const src: Source = {
        id: crypto.randomUUID(),
        label: address.slice(0, 10),
        chain: "ckb:testnet",
        address,
        joyidLockArgs: parsed.script.args as `0x${string}`,
        createdAt: now,
        updatedAt: now,
      };
      useSourcesStore.getState().addSource(src);
      const { lightClient } = await import("@/lib/light-client/client");
      await lightClient().watchLockScript(parsed.script);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setConnecting(false);
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Source wallets</h1>
        <button
          type="button"
          onClick={() => void handleConnect()}
          disabled={connecting}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          {connecting ? "Connecting…" : "Connect JoyID wallet"}
        </button>
      </header>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {sources.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No source wallets yet. Connect a JoyID wallet to send.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded border border-border">
          {sources.map((s) => (
            <li
              key={s.id}
              className={`flex items-center justify-between px-4 py-3 ${
                s.id === activeSourceId ? "bg-surface" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => setActiveSource(s.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <span className="font-medium text-fg">{s.label}</span>
                <span className="truncate font-mono text-xs text-fg-muted">
                  {s.address.slice(0, 20)}…
                </span>
                {s.id === activeSourceId ? (
                  <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[10px] text-accent">
                    active
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                onClick={() => removeSource(s.id)}
                className="ml-3 shrink-0 rounded-md border border-surface-hi px-2 py-1 text-xs text-fg-muted hover:border-danger hover:text-danger"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
