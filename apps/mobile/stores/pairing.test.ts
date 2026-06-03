import { describe, it, expect, beforeEach, vi } from "vitest";
import * as SecureStore from "expo-secure-store";
import { usePairingStore, _resetPairingStoreForTests } from "./pairing";

const mockedSecureStore = SecureStore as unknown as {
  setItemAsync: ReturnType<typeof vi.fn>;
  getItemAsync: ReturnType<typeof vi.fn>;
  deleteItemAsync: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  _resetPairingStoreForTests();
  mockedSecureStore.setItemAsync.mockReset();
  mockedSecureStore.getItemAsync.mockReset();
  mockedSecureStore.deleteItemAsync.mockReset();
});

describe("pairing store", () => {
  it("savePairing persists payload and exposes it via getter", async () => {
    await usePairingStore.getState().savePairing({
      rpc_url: "https://desk:8233/",
      auth_token: "tok",
      cert_fingerprint: "AB",
      desktop_comm_pubkey: "0x" + "11".repeat(32),
    });
    expect(mockedSecureStore.setItemAsync).toHaveBeenCalled();
    expect(usePairingStore.getState().pairing?.auth_token).toBe("tok");
  });

  it("clearPairing wipes the payload and the secure-store entry", async () => {
    await usePairingStore.getState().savePairing({
      rpc_url: "https://desk:8233/",
      auth_token: "tok",
      cert_fingerprint: "AB",
      desktop_comm_pubkey: "0x" + "22".repeat(32),
    });
    await usePairingStore.getState().clearPairing();
    expect(usePairingStore.getState().pairing).toBeNull();
    expect(mockedSecureStore.deleteItemAsync).toHaveBeenCalled();
  });

  it("loadPairing hydrates from secure storage on init", async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue(
      JSON.stringify({
        rpc_url: "https://x:1/",
        auth_token: "t",
        cert_fingerprint: "F",
        desktop_comm_pubkey: "0x" + "33".repeat(32),
      }),
    );
    await usePairingStore.getState().loadPairing();
    expect(usePairingStore.getState().pairing?.auth_token).toBe("t");
  });

  it("loadPairing handles cold start (no stored value)", async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue(null);
    await usePairingStore.getState().loadPairing();
    expect(usePairingStore.getState().pairing).toBeNull();
  });

  it("loadPairing drops corrupted entries and clears storage", async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue(JSON.stringify({ rpc_url: "x" }));
    await usePairingStore.getState().loadPairing();
    expect(usePairingStore.getState().pairing).toBeNull();
    expect(mockedSecureStore.deleteItemAsync).toHaveBeenCalled();
  });

  it("loadPairing drops malformed JSON and clears storage", async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue("not-json-at-all");
    await usePairingStore.getState().loadPairing();
    expect(usePairingStore.getState().pairing).toBeNull();
    expect(mockedSecureStore.deleteItemAsync).toHaveBeenCalled();
  });

  it("clearPairing with reason 'tls-mismatch' sets wasAutoCleared", async () => {
    await usePairingStore.getState().savePairing({
      rpc_url: "https://d:1/", auth_token: "t", cert_fingerprint: "AB",
      desktop_comm_pubkey: "0x" + "11".repeat(32),
    });
    await usePairingStore.getState().clearPairing("tls-mismatch");
    expect(usePairingStore.getState().wasAutoCleared).toBe(true);
  });

  it("savePairing clears the wasAutoCleared flag", async () => {
    await usePairingStore.getState().clearPairing("tls-mismatch");
    expect(usePairingStore.getState().wasAutoCleared).toBe(true);
    await usePairingStore.getState().savePairing({
      rpc_url: "https://d:1/", auth_token: "t", cert_fingerprint: "AB",
      desktop_comm_pubkey: "0x" + "22".repeat(32),
    });
    expect(usePairingStore.getState().wasAutoCleared).toBe(false);
  });
});
