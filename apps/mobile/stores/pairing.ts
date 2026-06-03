import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

const KEY = "chainpay.pairing.v1";

export interface PairingPayload {
  rpc_url: string;
  auth_token: string;
  cert_fingerprint: string;
  desktop_comm_pubkey: string;
}

interface PairingState {
  pairing: PairingPayload | null;
  wasAutoCleared: boolean;
  savePairing: (p: PairingPayload) => Promise<void>;
  clearPairing: (reason?: "user" | "tls-mismatch") => Promise<void>;
  loadPairing: () => Promise<void>;
}

export const usePairingStore = create<PairingState>((set) => ({
  pairing: null,
  wasAutoCleared: false,
  savePairing: async (p) => {
    try {
      await SecureStore.setItemAsync(KEY, JSON.stringify(p));
      set({ pairing: p, wasAutoCleared: false });
    } catch (e) {
      set({ pairing: null });
      throw e;
    }
  },
  clearPairing: async (reason = "user") => {
    try {
      await SecureStore.deleteItemAsync(KEY);
    } finally {
      set({ pairing: null, wasAutoCleared: reason === "tls-mismatch" });
    }
  },
  loadPairing: async () => {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) {
      set({ pairing: null });
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { rpc_url?: unknown }).rpc_url !== "string" ||
        typeof (parsed as { auth_token?: unknown }).auth_token !== "string" ||
        typeof (parsed as { cert_fingerprint?: unknown }).cert_fingerprint !== "string" ||
        typeof (parsed as { desktop_comm_pubkey?: unknown }).desktop_comm_pubkey !== "string"
      ) {
        await SecureStore.deleteItemAsync(KEY);
        set({ pairing: null });
        return;
      }
      set({ pairing: parsed as PairingPayload });
    } catch {
      await SecureStore.deleteItemAsync(KEY);
      set({ pairing: null });
    }
  },
}));

export function _resetPairingStoreForTests(): void {
  usePairingStore.setState({ pairing: null, wasAutoCleared: false });
}
