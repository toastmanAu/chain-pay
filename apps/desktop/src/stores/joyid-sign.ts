import { create } from "zustand";
import type { SignPhase, SignPreview, SignPresenter } from "@/lib/signers/joyid-relay/types";

interface JoyIdSignState {
  open: boolean;
  qrUrl: string | null;
  kind: "connect" | "sign" | null;
  phase: SignPhase;
  preview: SignPreview | undefined;
  error: string | undefined;
  showQr(url: string, kind: "connect" | "sign", preview?: SignPreview): void;
  updateStatus(phase: SignPhase): void;
  setError(message: string): void;
  dismiss(): void;
}

export const useJoyIdSignStore = create<JoyIdSignState>((set) => ({
  open: false,
  qrUrl: null,
  kind: null,
  phase: "idle",
  preview: undefined,
  error: undefined,
  showQr: (qrUrl, kind, preview) => set({ open: true, qrUrl, kind, preview: preview ?? undefined, phase: "awaiting-scan", error: undefined }),
  updateStatus: (phase) => set({ phase }),
  setError: (error) => set({ phase: "error", error }),
  dismiss: () => set({ open: false, qrUrl: null, kind: null, phase: "idle", preview: undefined, error: undefined }),
}));

export function makePresenter(): SignPresenter {
  const s = useJoyIdSignStore.getState();
  return {
    showQr: s.showQr,
    updateStatus: s.updateStatus,
    dismiss: s.dismiss,
  };
}
