// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { useSourcesStore } from "@/stores/sources";
import { useSendsStore } from "@/stores/sends";
import { useNetworkConfigStore } from "@/stores/network-config";
import type { Source } from "@chain-pay/shared";

// ---------------------------------------------------------------------------
// Hoisted spy so the factory can reference it
// ---------------------------------------------------------------------------

const buildAndSendSpy = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/send/build-and-send", () => ({
  buildAndSend: buildAndSendSpy,
}));

vi.mock("@/lib/chains/ckb/joyid-lock", () => ({
  resolveJoyIdScriptInfo: vi.fn().mockResolvedValue({
    codeHash: "0x" + "aa".repeat(32),
    hashType: "type",
    cellDeps: [],
  }),
  joyidLockAndDeps: vi.fn().mockReturnValue({
    lock: { codeHash: "0x" + "aa".repeat(32), hashType: "type", args: "0x" + "ab".repeat(20) },
    cellDeps: [],
  }),
}));

vi.mock("@/lib/chains/ckb/secp256k1-lock", () => ({
  resolveSecp256k1ScriptInfo: vi.fn().mockResolvedValue({
    codeHash: "0x" + "bb".repeat(32),
    hashType: "type",
    cellDeps: [],
  }),
  secp256k1LockAndDeps: vi.fn().mockReturnValue({
    lock: { codeHash: "0x" + "bb".repeat(32), hashType: "type", args: "0x" + "ab".repeat(20) },
    cellDeps: [],
  }),
}));

vi.mock("@/lib/signers/joyid-relay-ckb-tx-signer", () => ({
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  JoyIdRelaySigner: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this["kind"] = "joyid";
    this["connect"] = vi.fn();
    this["signTransaction"] = vi.fn();
  }),
}));

vi.mock("@/lib/signers/local-keystore-ckb-tx-signer", () => ({
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  LocalKeystoreCkbTxSigner: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this["kind"] = "local-keystore";
    this["connect"] = vi.fn();
    this["signTransaction"] = vi.fn();
  }),
}));

vi.mock("@/stores/joyid-sign", () => ({
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  useJoyIdSignStore: () => ({
    open: false,
    qrUrl: null,
    kind: "sign",
    phase: "idle",
    error: null,
  }),
  makePresenter: vi.fn().mockReturnValue({
    showQr: vi.fn(),
    updateStatus: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock("@/lib/light-client/client", () => ({
  lightClient: vi.fn().mockReturnValue({
    getLockBalance: vi.fn().mockResolvedValue(100_000_000_000n),
    listCellsForLock: vi.fn().mockResolvedValue([]),
    broadcastTransaction: vi.fn().mockResolvedValue("0xtesttxhash"),
  }),
}));

vi.mock("@ckb-ccc/core", () => ({
  Address: {
    fromString: vi.fn().mockResolvedValue({
      script: { codeHash: "0x" + "cc".repeat(32), hashType: "type", args: "0x" },
    }),
  },
  ClientPublicTestnet: vi.fn(),
  ClientPublicMainnet: vi.fn(),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,mock") },
}));

// accounting/ipc calls window.chainpay.accounting, which isn't wired in tests.
// Mock it so SendHistory (which imports send-journal → accounting/ipc) can render
// without trying to reach the Electron IPC bridge.
vi.mock("@/lib/accounting/ipc", () => ({
  postJournal: vi.fn().mockResolvedValue({ jeName: "JE-test", idempotent: false }),
}));

// ---------------------------------------------------------------------------
// Import the component AFTER mocks are registered
// ---------------------------------------------------------------------------

// eslint-disable-next-line import/first
import { SendPanel } from "./SendPanel";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECP256K1_SOURCE: Source = {
  id: "kv-src-1",
  label: "Local wallet",
  chain: "ckb:testnet",
  address: "ckt1qtest",
  joyidLockArgs: ("0x" + "ab".repeat(20)) as `0x${string}`,
  lockKind: "secp256k1",
  keyvaultId: "main",
  derivationIndex: 0,
  createdAt: "2026-06-28T00:00:00Z",
  updatedAt: "2026-06-28T00:00:00Z",
};

const JOYID_SOURCE: Source = {
  id: "joy-src-1",
  label: "JoyID wallet",
  chain: "ckb:testnet",
  address: "ckt1qjoyid",
  joyidLockArgs: ("0x" + "ab".repeat(20)) as `0x${string}`,
  lockKind: "joyid",
  createdAt: "2026-06-28T00:00:00Z",
  updatedAt: "2026-06-28T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupLocalStorage(): void {
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

function mountKeyvaultBridge(): void {
  (globalThis as Record<string, unknown>)["chainpay"] = {
    keyvault: {
      signTx: vi.fn().mockResolvedValue({ signedTx: "{}" }),
      status: vi.fn().mockResolvedValue({ exists: true }),
      create: vi.fn(),
      import: vi.fn(),
      delete: vi.fn(),
      unlockDerive: vi.fn(),
      export: vi.fn(),
      changePassword: vi.fn(),
    },
  };
}

function renderSend(): void {
  render(
    <MemoryRouter>
      <SendPanel />
    </MemoryRouter>,
  );
}

/** Fill the first payee row with an address and a CKB amount (as a string). */
function fillRow(address: string, ckb: string): void {
  // Address is the first text input
  const textInputs = screen.getAllByRole("textbox");
  fireEvent.change(textInputs[0]!, { target: { value: address } });
  // CKB amount is the first number (spinbutton) input
  const numberInputs = screen.getAllByRole("spinbutton");
  fireEvent.change(numberInputs[0]!, { target: { value: ckb } });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupLocalStorage();
  mountKeyvaultBridge();
  buildAndSendSpy.mockResolvedValue({ txHash: "0xtesthash" });
  useSourcesStore.setState({ sources: [], activeSourceId: null });
  useSendsStore.setState({ sends: [] });
  useNetworkConfigStore.setState({
    network: "testnet",
    broadcastRpcUrl: "",
    setNetwork: useNetworkConfigStore.getState().setNetwork,
    setBroadcastRpcUrl: useNetworkConfigStore.getState().setBroadcastRpcUrl,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  buildAndSendSpy.mockResolvedValue({ txHash: "0xtesthash" });
  delete (globalThis as Record<string, unknown>)["chainpay"];
});

// ---------------------------------------------------------------------------
// Tests: secp256k1 source path
// ---------------------------------------------------------------------------

describe("SendPanel — secp256k1 (local keystore) path", () => {
  it("opens UnlockModal when Send is clicked with a secp256k1 source and valid rows", async () => {
    useSourcesStore.getState().addSource(SECP256K1_SOURCE);
    renderSend();
    fillRow("ckt1qrecipient", "100");

    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.getByText(/unlock wallet to sign/i)).toBeInTheDocument();
  });

  it("calls buildAndSend with a local-keystore signer after password confirm", async () => {
    useSourcesStore.getState().addSource(SECP256K1_SOURCE);
    renderSend();
    fillRow("ckt1qrecipient", "100");

    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Enter a password and confirm
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "wallet-pw-123" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    });

    await waitFor(() => {
      expect(buildAndSendSpy).toHaveBeenCalled();
    });

    // The third argument to buildAndSend is the signer
    const calls = buildAndSendSpy.mock.calls as Array<[unknown, unknown, { kind: string }]>;
    const signer = calls[0]![2];
    expect(signer!.kind).toBe("local-keystore");
  });

  it("closes the modal after password is confirmed", async () => {
    useSourcesStore.getState().addSource(SECP256K1_SOURCE);
    renderSend();
    fillRow("ckt1qrecipient", "100");

    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "wallet-pw-123" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    });

    // Modal should close
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("does NOT open the modal if row validation fails first", () => {
    useSourcesStore.getState().addSource(SECP256K1_SOURCE);
    renderSend();
    // Don't fill in any valid rows — validation will reject

    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    // Modal should NOT open
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Validation error should be shown (address is checked before amount)
    expect(
      screen.getByText(/each payee must have an address/i),
    ).toBeInTheDocument();
  });

  it("closes the modal on Cancel without sending", async () => {
    useSourcesStore.getState().addSource(SECP256K1_SOURCE);
    renderSend();
    fillRow("ckt1qrecipient", "100");

    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(buildAndSendSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: JoyID source path (existing behaviour preserved)
// ---------------------------------------------------------------------------

describe("SendPanel — JoyID path (existing behaviour)", () => {
  it("calls buildAndSend directly (no modal) for a JoyID source", async () => {
    useSourcesStore.getState().addSource(JOYID_SOURCE);
    renderSend();
    fillRow("ckt1qrecipient", "100");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    });

    await waitFor(() => {
      expect(buildAndSendSpy).toHaveBeenCalled();
    });

    // UnlockModal must NOT appear for JoyID sends
    expect(screen.queryByText(/unlock wallet to sign/i)).not.toBeInTheDocument();
  });

  it("calls buildAndSend with a joyid signer for a JoyID source", async () => {
    useSourcesStore.getState().addSource(JOYID_SOURCE);
    renderSend();
    fillRow("ckt1qrecipient", "100");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    });

    await waitFor(() => {
      expect(buildAndSendSpy).toHaveBeenCalled();
    });

    const calls = buildAndSendSpy.mock.calls as Array<[unknown, unknown, { kind: string }]>;
    const signer = calls[0]![2];
    expect(signer!.kind).toBe("joyid");
  });

  it("shows an error when there is no source selected", () => {
    renderSend();
    // No sources → "No source wallets" message, Send button not in DOM
    expect(screen.getByText(/no source wallets/i)).toBeInTheDocument();
  });
});
