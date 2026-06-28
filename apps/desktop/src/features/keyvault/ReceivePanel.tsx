import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { Script, ScriptInfo } from "@ckb-ccc/core";
import {
  resolveSecp256k1ScriptInfo,
  secp256k1LockAndDeps,
} from "@/lib/chains/ckb/secp256k1-lock";
import { secp256k1AddressFromLockArgs } from "@/lib/chains/ckb/secp256k1-address";
import { useKeystoreBalance, type LightClientDeps } from "./useKeystoreBalance";
import { shannonsToCkbString } from "@/lib/send/ckb-amount";
import { useNetworkConfigStore } from "@/stores/network-config";
import type { CkbNetwork } from "@/lib/light-client/network-configs";

export interface ReceivePanelProps {
  /** 0x-prefixed 20-byte blake160 lock-args from the keyvault store. */
  lockArgs: string;
  /**
   * Inject the secp256k1 ScriptInfo directly (tests).
   * When omitted the component resolves it from the network via CCC's known-script lookup.
   */
  scriptInfo?: ScriptInfo;
  /**
   * Inject light-client deps (tests).
   * When omitted the component uses the real light-client IPC bridge via useKeystoreBalance.
   */
  balanceDeps?: LightClientDeps;
}

/** Map CkbNetwork → CCC address prefix. */
function networkToPrefix(network: CkbNetwork): "ckb" | "ckt" {
  return network === "mainnet" ? "ckb" : "ckt";
}

/**
 * Receive / Fund panel: shows the wallet address (with copy + QR), the live
 * CKB balance, and a "Syncing" hint so users don't mistake an unsynced 0 for
 * confirmed-empty.
 *
 * Dependencies (scriptInfo, balanceDeps) are injectable for tests so no real
 * network/IPC calls are made during unit tests.
 */
export function ReceivePanel({
  lockArgs,
  scriptInfo: injectedScriptInfo,
  balanceDeps,
}: ReceivePanelProps): React.ReactElement {
  const { network } = useNetworkConfigStore();
  const networkPrefix = networkToPrefix(network);

  // --- ScriptInfo resolution ---
  const [resolvedScriptInfo, setResolvedScriptInfo] = useState<ScriptInfo | null>(
    injectedScriptInfo ?? null,
  );

  useEffect(() => {
    if (injectedScriptInfo) return;
    let active = true;
    void resolveSecp256k1ScriptInfo(network).then((info) => {
      if (active) setResolvedScriptInfo(info);
    });
    return () => {
      active = false;
    };
  }, [injectedScriptInfo, network]);

  // --- Derived lock + address (stable reference for balance hook) ---
  const derived = useMemo<{ lock: Script; address: string } | null>(() => {
    if (!resolvedScriptInfo) return null;
    const { lock } = secp256k1LockAndDeps(resolvedScriptInfo, lockArgs);
    const address = secp256k1AddressFromLockArgs(lockArgs, networkPrefix, resolvedScriptInfo);
    return { lock, address };
  }, [resolvedScriptInfo, lockArgs, networkPrefix]);

  // --- Balance hook ---
  const { balance, loading, error, refresh } = useKeystoreBalance(
    derived?.lock ?? null,
    balanceDeps,
  );

  // --- QR code generation (same pattern as JoyIdSignModal) ---
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!derived?.address) {
      setQrDataUrl(null);
      return;
    }
    let active = true;
    void QRCode.toDataURL(derived.address, { width: 256 }).then((d) => {
      if (active) setQrDataUrl(d);
    });
    return () => {
      active = false;
    };
  }, [derived?.address]);

  // --- Copy-to-clipboard state ---
  const [copied, setCopied] = useState(false);

  function handleCopy(): void {
    if (!derived?.address) return;
    void navigator.clipboard.writeText(derived.address).then(() => {
      setCopied(true);
      // Reset label after 2 s — use a plain setTimeout (no cleanup needed for a label).
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // --- Loading guard: scriptInfo not yet resolved ---
  if (!resolvedScriptInfo) {
    return (
      <div className="space-y-2 text-sm text-fg-muted">
        <p>Resolving network info…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Fund this wallet</h3>

      {/* QR code */}
      {qrDataUrl && (
        <div className="flex justify-center">
          <img src={qrDataUrl} alt="Address QR code" width={192} height={192} />
        </div>
      )}

      {/* Address */}
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wide text-fg-muted">Address</div>
        <div className="break-all rounded-md bg-bg px-3 py-2 font-mono text-xs">
          {derived?.address ?? "—"}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded border border-surface-hi bg-bg px-3 py-1 text-xs hover:opacity-90"
        >
          {copied ? "Copied!" : "Copy address"}
        </button>
      </div>

      {/* Balance */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <div className="text-xs uppercase tracking-wide text-fg-muted">Balance</div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            aria-label="Refresh balance"
            className="rounded border border-surface-hi bg-bg px-2 py-0.5 text-xs hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "…" : "Refresh"}
          </button>
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}

        {balance !== null ? (
          <div className="font-mono text-sm">
            {shannonsToCkbString(balance)} CKB
          </div>
        ) : (
          !error && <div className="text-sm text-fg-muted">—</div>
        )}

        {/*
         * Syncing hint: always shown so users never mistake an unsynced 0 for
         * confirmed-empty. A freshly-watched lock can take several blocks to fully
         * sync. See memory `mobile-drain-debugging-traps`.
         */}
        <p className="text-xs text-fg-muted">
          ⓘ Syncing — balance may be incomplete while the light client scans the chain.
        </p>
      </div>

      {/* Fund hint */}
      <p className="text-xs text-fg-muted">
        Send {network === "mainnet" ? "mainnet" : "testnet"} CKB to this address to fund the
        wallet.
      </p>
    </div>
  );
}
