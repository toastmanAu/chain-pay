// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { PayrollBatch, TransferPacket } from "@chain-pay/shared";
import type { CommTransport, OutgoingPacket } from "@/lib/comm/types";

const mockTransport = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  isRunning: vi.fn().mockReturnValue(true),
  publishProfile: vi.fn(),
  resolveProfile: vi.fn().mockImplementation(async (addr: string) => ({
    address: addr,
    mlDsaPubKey: new Uint8Array(1952),
    mlKemPubKey: new Uint8Array(1184),
    fetchedAt: Date.now(),
  })),
  sendPacket: vi.fn().mockResolvedValue(`0x${"01".repeat(32)}`),
  sendSignature: vi.fn(),
  sendAck: vi.fn(),
  onIncomingPacket: vi.fn(),
  onIncomingSignature: vi.fn(),
  onIncomingAck: vi.fn(),
} satisfies CommTransport;

vi.mock("@/lib/comm", async () => {
  const real = await vi.importActual<typeof import("@/lib/comm")>("@/lib/comm");
  return { ...real, createCommTransport: () => mockTransport };
});

import { CommSendSection } from "./CommSendSection";
import { usePeerBookStore } from "@/stores/peer-book";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";

const HASH_A = `0x${"a1".repeat(20)}` as const;
const HASH_B = `0x${"b2".repeat(20)}` as const;
const PACKET: OutgoingPacket = {
  txHash: `0x${"dd".repeat(32)}`,
  treasuryAddress: "ckt1qtrz",
  expiresAt: 9_999_999_999,
  packet: "encoded" as TransferPacket,
};
const MULTISIG = { pubkeyHashes: [HASH_A, HASH_B] as const };

const baseBatch: PayrollBatch = {
  id: "b1",
  label: "test",
  treasuryId: "t1",
  cycleStart: "2026-05-01",
  cycleEnd: "2026-05-31",
  fxSnapshot: [],
  lines: [],
  state: "calculated",
  sighashDigest: PACKET.txHash,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
};

function reset(): void {
  vi.clearAllMocks();
  mockTransport.sendPacket.mockResolvedValue(`0x${"01".repeat(32)}`);
  mockTransport.resolveProfile.mockImplementation(async (addr: string) => ({
    address: addr,
    mlDsaPubKey: new Uint8Array(1952),
    mlKemPubKey: new Uint8Array(1184),
    fetchedAt: Date.now(),
  }));
  usePeerBookStore.setState({ peers: [], knownSignersGetter: () => [] });
  usePayrollBatchesStore.setState({ batches: [baseBatch], selectedDraftId: null });
  globalThis.localStorage?.clear?.();
}

describe("CommSendSection", () => {
  beforeEach(reset);
  afterEach(cleanup);

  it("renders one row per multisig slot with peer nickname when mapped", () => {
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
      new Uint8Array(20),
    );
    render(<CommSendSection batchId="b1" packet={PACKET} multisig={MULTISIG} />);
    expect(screen.getByText(/Slot 0 — Alice/)).toBeInTheDocument();
    expect(screen.getByText(/Slot 1 — .* \(no peer mapped\)/)).toBeInTheDocument();
  });

  it("Send button is disabled when no slots are mapped to peers", () => {
    render(<CommSendSection batchId="b1" packet={PACKET} multisig={MULTISIG} />);
    const btn = screen.getByRole("button", { name: /send packet to mapped signers/i });
    expect(btn).toBeDisabled();
  });

  it("clicking Send triggers sendPacket on every mapped slot", async () => {
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
      new Uint8Array(20),
    );
    usePeerBookStore.getState().addPeer(
      { nickname: "Bob", address: "ckt1qbob", pairedAt: 0, associatedSignerHash: HASH_B },
      new Uint8Array(20).fill(1),
    );
    render(<CommSendSection batchId="b1" packet={PACKET} multisig={MULTISIG} />);

    fireEvent.click(screen.getByRole("button", { name: /send packet to mapped signers/i }));
    await waitFor(() => expect(mockTransport.sendPacket).toHaveBeenCalledTimes(2));
  });

  it("error rows surface a Retry button that re-dispatches only that slot", async () => {
    mockTransport.sendPacket.mockRejectedValueOnce(new Error("ipc broke"));
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
      new Uint8Array(20),
    );
    render(<CommSendSection batchId="b1" packet={PACKET} multisig={{ pubkeyHashes: [HASH_A] }} />);

    fireEvent.click(screen.getByRole("button", { name: /send packet to mapped signers/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(mockTransport.sendPacket).toHaveBeenCalledTimes(2));
  });

  it("renders a disabledReason banner when disabled prop is set", () => {
    render(
      <CommSendSection
        batchId="b1"
        packet={PACKET}
        multisig={MULTISIG}
        disabled
        disabledReason="Comm channel not started — set up in Settings"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/comm channel not started/i);
    expect(screen.getByRole("button", { name: /send packet to mapped signers/i })).toBeDisabled();
  });

  it("status pill reflects per-slot commSendStatus from the batch store", () => {
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
      new Uint8Array(20),
    );
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "sent", {
      txHash: "0xdead",
    });

    render(<CommSendSection batchId="b1" packet={PACKET} multisig={{ pubkeyHashes: [HASH_A] }} />);
    expect(screen.getByTestId("pill-0")).toHaveTextContent(/sent/);
  });

  describe("mainnet fallback", () => {
    it("replaces comm-send UI with a fallback note when network === 'mainnet'", async () => {
      const { useNetworkConfigStore } = await import("@/stores/network-config");
      useNetworkConfigStore.setState({ network: "mainnet" });
      render(
        <CommSendSection
          batchId="b1"
          packet={PACKET}
          multisig={{
            pubkeyHashes: [HASH_A, HASH_B],
          }}
        />,
      );
      expect(screen.getByText(/comm channel unavailable; use clipboard/i)).toBeInTheDocument();
      // No pills rendered
      expect(screen.queryAllByTestId(/pill-\d+/)).toHaveLength(0);
    });

    it("resets network to testnet after mainnet fallback test", async () => {
      const { useNetworkConfigStore } = await import("@/stores/network-config");
      useNetworkConfigStore.setState({ network: "testnet" });
    });
  });
});
