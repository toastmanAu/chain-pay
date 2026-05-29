// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CommChannelSection } from "./CommChannelSection";
import { useCommIdentityStore } from "../../stores/comm-identity";
import { useNetworkConfigStore } from "../../stores/network-config";

const FIXTURE_ID = {
  mlDsaPub: "0x" + "11".repeat(1952),
  mlKemPub: "0x" + "22".repeat(1184),
  address: "ckt1qmldsa-fixture",
  addrHash: "0x" + "33".repeat(20),
  createdAt: 1747900000_000,
  fundedAt: null,
  profileTxHash: null,
  profilePublishedAt: null,
};

function resetStore(): void {
  useCommIdentityStore.setState({ identity: null });
  globalThis.localStorage?.removeItem("chain-pay:comm-identity");
  useNetworkConfigStore.setState({ network: "testnet" });
  globalThis.localStorage?.removeItem("chain-pay:network-config");
}

function mockChainpay(opts?: { generateReject?: Error }) {
  (globalThis as unknown as { window: Window }).window = {
    chainpay: {
      commIdentity: {
        exists: vi.fn().mockResolvedValue(false),
        publicInfo: vi.fn().mockResolvedValue(null),
        generate: opts?.generateReject
          ? vi.fn().mockRejectedValue(opts.generateReject)
          : vi.fn().mockResolvedValue(FIXTURE_ID),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      commTransport: {
        publishProfile: vi.fn().mockResolvedValue({ txHash: "0xpubtx", txBytes: "0x00" }),
        sendMessage: vi.fn(),
        decryptIncoming: vi.fn(),
        resolveProfile: vi.fn(),
      },
    },
  } as never;
}

describe("CommChannelSection", () => {
  beforeEach(() => {
    resetStore();
    mockChainpay();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders NotConfiguredStep when no identity", () => {
    render(<CommChannelSection />);
    expect(screen.getByText(/Set up comm channel/i)).toBeInTheDocument();
  });

  it("renders FundingStep when identity exists without profileTxHash", () => {
    useCommIdentityStore.setState({ identity: FIXTURE_ID });
    render(<CommChannelSection />);
    expect(screen.getByText(/Comm channel address/i)).toBeInTheDocument();
  });

  it("renders ReadyStep when profileTxHash is set", () => {
    useCommIdentityStore.setState({
      identity: { ...FIXTURE_ID, profileTxHash: "0xtx", profilePublishedAt: Date.now() },
    });
    render(<CommChannelSection />);
    expect(screen.getByText(/Comm channel ready/i)).toBeInTheDocument();
  });

  it("clicking Set up button calls generate IPC", async () => {
    render(<CommChannelSection />);
    const button = screen.getByRole("button", { name: /Set up comm channel/i });
    fireEvent.click(button);
    // microtask flush
    await Promise.resolve();
    await Promise.resolve();
    expect(window.chainpay.commIdentity.generate).toHaveBeenCalledTimes(1);
  });

  it("generate error renders error banner in NotConfiguredStep", async () => {
    mockChainpay({ generateReject: new Error("safeStorage unavailable") });
    render(<CommChannelSection />);
    const button = screen.getByRole("button", { name: /Set up comm channel/i });
    fireEvent.click(button);
    // Allow promise chain in handleSetup to complete and React to re-render
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(/Setup failed/i)).toBeInTheDocument();
    expect(screen.getByText(/safeStorage unavailable/i)).toBeInTheDocument();
  });

  it("Delete identity confirmation flow", async () => {
    useCommIdentityStore.setState({
      identity: { ...FIXTURE_ID, profileTxHash: "0xtx", profilePublishedAt: Date.now() },
    });
    render(<CommChannelSection />);
    fireEvent.click(screen.getByRole("button", { name: /Delete identity/i }));
    expect(
      screen.getByText(/permanently delete your comm-channel identity/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Yes, delete/i }));
    await new Promise((r) => setTimeout(r, 0));
    expect(window.chainpay.commIdentity.delete).toHaveBeenCalledTimes(1);
    expect(useCommIdentityStore.getState().identity).toBeNull();
  });
});

describe("mainnet soft-fail", () => {
  beforeEach(() => {
    resetStore();
    mockChainpay();
  });

  afterEach(() => {
    cleanup();
    resetStore();
  });

  it("renders the soft-fail banner and hides the ceremony when network === 'mainnet'", () => {
    useNetworkConfigStore.setState({ network: "mainnet" });
    render(<CommChannelSection />);
    expect(screen.getByText(/Comm-channel unavailable on mainnet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/post-quantum signature contract has not yet been deployed/i),
    ).toBeInTheDocument();
    // Ceremony controls hidden
    expect(screen.queryByRole("button", { name: /Set up comm channel/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Generate identity/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Publish Profile/i })).not.toBeInTheDocument();
  });
});
