import { create } from "zustand";
import type { SignPhase, SignPreview, SignPresenter } from "@/lib/signers/joyid-relay/types";

interface JoyIdSignState {
  open: boolean;
  qrUrl: string | null;
  kind: "connect" | "sign" | null;
  phase: SignPhase;
  preview?: SignPreview;
  error?: string;
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
  showQr: (qrUrl, kind, preview) => set({ open: true, qrUrl, kind, ...(preview ? { preview } : {}), phase: "awaiting-scan" }),
  updateStatus: (phase) => set({ phase }),
  setError: (error) => set({ phase: "error", error }),
  dismiss: () => set({ open: false, qrUrl: null, kind: null, phase: "idle" }),
}));

export function makePresenter(): SignPresenter {
  const s = useJoyIdSignStore.getState();
  return {
    showQr: s.showQr,
    updateStatus: s.updateStatus,
    dismiss: s.dismiss,
  };
}
