import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { createFiberConnectUri } from "@chain-pay/shared";
import type { PairedDevice } from "../../../electron/main/pair-store";

interface PairingSectionProps {
  rpcHost: string;
  rpcPort: number;
  certFingerprint: string;
}

export function PairingSection({
  rpcHost,
  rpcPort,
  certFingerprint,
}: PairingSectionProps) {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [label, setLabel] = useState("");
  const [uri, setUri] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDevices(await window.chainpay.pair.list());
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load paired devices");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!uri || !canvasRef.current) return;
    void QRCode.toCanvas(canvasRef.current, uri, {
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 6,
    });
  }, [uri]);

  const onIssue = async (): Promise<void> => {
    if (!label.trim()) return;
    setErrorMsg(null);
    // Set issuing BEFORE the await so a rapid second click is blocked by the disabled prop.
    setIssuing(true);
    try {
      const { token } = await window.chainpay.pair.issue(label.trim());
      const newUri = createFiberConnectUri({
        rpc_url: `https://${rpcHost}:${rpcPort}`,
        auth_token: token,
        cert_fingerprint: certFingerprint,
      });
      setUri(newUri);
      await refresh();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to issue token");
    } finally {
      setIssuing(false);
    }
  };

  const onRevoke = async (tokenId: string): Promise<void> => {
    setErrorMsg(null);
    try {
      await window.chainpay.pair.revoke(tokenId);
      await refresh();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to revoke");
    }
  };

  return (
    <section
      className="space-y-3 rounded-lg border border-surface-hi bg-surface p-5"
      aria-label="Pair mobile devices"
    >
      <header>
        <div className="text-xs uppercase tracking-wide text-fg-muted">Pair mobile</div>
        <p className="mt-1 text-sm text-fg-muted">
          Generate a one-time QR code to pair the ChainPay mobile companion app over the
          local network.
        </p>
      </header>

      <div className="flex items-end gap-2">
        <label htmlFor="pair-device-label" className="flex-1 block">
          <span className="text-xs text-fg-muted">Device label</span>
          <input
            id="pair-device-label"
            type="text"
            placeholder="e.g. phill-pixel-8"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="mt-1 w-full rounded-md border border-surface-hi bg-bg px-3 py-2 font-mono text-xs text-fg"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            void onIssue();
          }}
          disabled={!label.trim() || issuing}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Generate QR
        </button>
      </div>

      {errorMsg && (
        <p role="alert" data-testid="pair-error" className="text-xs text-red-600">
          {errorMsg}
        </p>
      )}

      {uri && (
        <div className="flex flex-col items-start gap-2">
          <canvas data-testid="pair-qr-canvas" ref={canvasRef} />
          <input
            data-testid="pair-copy-link"
            readOnly
            value={uri}
            className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2 font-mono text-xs text-fg"
          />
        </div>
      )}

      <h4 className="text-xs uppercase tracking-wide text-fg-muted">Paired devices</h4>
      {devices.length === 0 ? (
        <p className="text-sm text-fg-muted">No devices paired.</p>
      ) : (
        <ul className="space-y-2">
          {devices.map((d) => (
            <li
              key={d.tokenId}
              className="flex items-center justify-between rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm"
            >
              <span className="font-medium">{d.deviceLabel}</span>
              <span className="text-xs text-fg-muted">
                expires {new Date(d.expiresAt).toLocaleDateString()}
              </span>
              <button
                type="button"
                onClick={() => {
                  void onRevoke(d.tokenId);
                }}
                aria-label={`Revoke ${d.deviceLabel}`}
                className="rounded-md border border-surface-hi px-3 py-1 text-xs text-fg hover:bg-surface-hi"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
