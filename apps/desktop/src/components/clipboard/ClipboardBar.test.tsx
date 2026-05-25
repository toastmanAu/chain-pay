// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ClipboardBar } from "./ClipboardBar";
import { useClipboardStore } from "@/stores/clipboard";
import { useCommIdentityStore } from "@/stores/comm-identity";
import { useDebugSettingsStore } from "@/stores/debug-settings";
import { useNetworkConfigStore } from "@/stores/network-config";
import { MemoryStorage } from "@/stores/test-utils/memory-storage";

const FIXTURE_IDENTITY = {
  mlDsaPub: "0x" + "11".repeat(1952),
  mlKemPub: "0x" + "22".repeat(1184),
  address: "ckt1qmldsa-fixture",
  addrHash: "0x" + "33".repeat(20),
  createdAt: 1747900000_000,
  fundedAt: 1747901000_000,
  profileTxHash: "0xprofile_tx_hash",
  profilePublishedAt: 1747902000_000,
};

function resetStores(): void {
  useClipboardStore.setState({
    bins: [
      { id: 0, value: "test-value-0", label: "A", savedAt: Date.now() },
      { id: 1, value: "test-value-1", label: "B", savedAt: Date.now() },
      { id: 2, value: "", label: "C", savedAt: Date.now() },
      { id: 3, value: "", label: "D", savedAt: Date.now() },
    ],
  });
  useCommIdentityStore.setState({ identity: null });
  useDebugSettingsStore.setState({ showClipboard: false });
  useNetworkConfigStore.setState({ network: "testnet", broadcastRpcUrl: "" });
  // Clear localStorage
  globalThis.localStorage?.removeItem("chain-pay:clipboard");
  globalThis.localStorage?.removeItem("chain-pay:comm-identity");
  globalThis.localStorage?.removeItem("chain-pay:debug-settings");
  globalThis.localStorage?.removeItem("chain-pay:network-config");
}

describe("ClipboardBar", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
    vi.resetModules();
    resetStores();
  });

  afterEach(() => {
    cleanup();
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("renders the clipboard bar with bin count", () => {
    render(<ClipboardBar />);
    expect(screen.getByLabelText("clipboard")).toBeInTheDocument();
    expect(screen.getByText(/Clipboard/)).toBeInTheDocument();
    expect(screen.getByText(/2\/4/)).toBeInTheDocument(); // 2 filled, 4 total
  });

  describe("testnet visibility", () => {
    it("hides the bar when commActive=true and showClipboard=false", () => {
      useNetworkConfigStore.setState({ network: "testnet" });
      useCommIdentityStore.setState({ identity: FIXTURE_IDENTITY });
      useDebugSettingsStore.setState({ showClipboard: false });

      const { container } = render(<ClipboardBar />);
      expect(container.firstChild).toBeNull();
    });

    it("shows the bar when commActive=true and showClipboard=true", () => {
      useNetworkConfigStore.setState({ network: "testnet" });
      useCommIdentityStore.setState({ identity: FIXTURE_IDENTITY });
      useDebugSettingsStore.setState({ showClipboard: true });

      render(<ClipboardBar />);
      expect(screen.getByLabelText("clipboard")).toBeInTheDocument();
    });

    it("shows the bar when commActive=false regardless of showClipboard", () => {
      useNetworkConfigStore.setState({ network: "testnet" });
      useCommIdentityStore.setState({ identity: null });
      useDebugSettingsStore.setState({ showClipboard: false });

      render(<ClipboardBar />);
      expect(screen.getByLabelText("clipboard")).toBeInTheDocument();
    });
  });

  describe("mainnet visibility (commAvailable always false)", () => {
    it("shows the bar on mainnet even when commActive=true and showClipboard=false", () => {
      useNetworkConfigStore.setState({ network: "mainnet" });
      useCommIdentityStore.setState({ identity: FIXTURE_IDENTITY });
      useDebugSettingsStore.setState({ showClipboard: false });

      render(<ClipboardBar />);
      expect(screen.getByLabelText("clipboard")).toBeInTheDocument();
    });

    it("shows the bar on mainnet when commActive=false", () => {
      useNetworkConfigStore.setState({ network: "mainnet" });
      useCommIdentityStore.setState({ identity: null });
      useDebugSettingsStore.setState({ showClipboard: false });

      render(<ClipboardBar />);
      expect(screen.getByLabelText("clipboard")).toBeInTheDocument();
    });
  });
});
