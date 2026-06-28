import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useJoyIdSignStore } from "@/stores/joyid-sign";

export function JoyIdSignModal() {
  const { open, qrUrl, kind, phase, error } = useJoyIdSignStore();
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (qrUrl) {
      void QRCode.toDataURL(qrUrl, { width: 256 }).then((d) => {
        if (active) setDataUrl(d);
      });
    } else {
      setDataUrl(null);
    }
    return () => {
      active = false;
    };
  }, [qrUrl]);

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" className="joyid-sign-modal">
      <h2>{kind === "connect" ? "Connect JoyID wallet" : "Approve this send"}</h2>
      {dataUrl && <img src={dataUrl} alt="JoyID QR code" width={256} height={256} />}
      <p>Scan with your phone and approve in JoyID.</p>
      <p data-testid="phase">{phaseLabel(phase)}</p>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "awaiting-scan":
      return "Waiting for you to scan…";
    case "awaiting-confirm":
      return "Waiting for approval on your phone…";
    case "assembling":
      return "Building the signed transaction…";
    case "done":
      return "Done.";
    case "error":
      return "Something went wrong.";
    default:
      return "";
  }
}
