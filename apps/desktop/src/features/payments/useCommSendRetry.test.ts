// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { PayrollBatch, TransferPacket } from "@chain-pay/shared";
import type { CommTransport, OutgoingPacket } from "@/lib/comm/types";

const mockTransport = {
  start: vi.fn(),
  stop: vi.fn(),
  isRunning: vi.fn().mockReturnValue(true),
  publishProfile: vi.fn(),
  resolveProfile: vi.fn().mockResolvedValue({
    address: "ckt1qx", mlDsaPubKey: new Uint8Array(), mlKemPubKey: new Uint8Array(), fetchedAt: 0,
  }),
  sendPacket: vi.fn().mockResolvedValue("0x" + "01".repeat(32)),
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

import { useCommSendRetry } from "./useCommSendRetry";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { usePeerBookStore } from "@/stores/peer-book";

const HASH_A = `0x${"a1".repeat(20)}` as const;
const PACKET: OutgoingPacket = {
  txHash: `0x${"dd".repeat(32)}`,
  treasuryAddress: "ckt1qtrz",
  expiresAt: 9_999_999_999,
  packet: "encoded" as TransferPacket,
};
const sampleBatch: PayrollBatch = {
  id: "b1", label: "test", treasuryId: "t1",
  cycleStart: "2026-05-01", cycleEnd: "2026-05-31",
  fxSnapshot: [], lines: [], state: "calculated",
  sighashDigest: PACKET.txHash,
  createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z",
};

function reset(): void {
  vi.clearAllMocks();
  usePayrollBatchesStore.setState({ batches: [sampleBatch], selectedDraftId: null });
  usePeerBookStore.setState({ peers: [], knownSignersGetter: () => [] });
  usePeerBookStore.getState().addPeer(
    { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
    new Uint8Array(20).fill(0xaa),
  );
  vi.useFakeTimers();
}

describe("useCommSendRetry", () => {
  beforeEach(reset);
  afterEach(() => { vi.useRealTimers(); });

  it("schedules a retry 5min after a slot enters status='sent' with retryCount=0", async () => {
    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "sent", { txHash: "0x01" });

    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(mockTransport.sendPacket).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    // After the first timer fires, fireRetry writes a new "sent" status which
    // re-triggers the subscriber to schedule the next retry. runAllTimersAsync
    // drains the entire cascade up to RETRY_CAP=3. Asserting >= 1 here is the
    // load-bearing check — the first retry fired at the 5min mark.
    await vi.runAllTimersAsync();
    expect(mockTransport.sendPacket).toHaveBeenCalled();
  });

  it("cancels the pending retry when status flips to acked", () => {
    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "sent", { txHash: "0x01" });
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "acked");

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(mockTransport.sendPacket).not.toHaveBeenCalled();
  });

  it("uses exponential backoff capped at RETRY_CAP=3 retries", async () => {
    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "sent", { txHash: "0x01" });

    // Advance past the first scheduled retry. runAllTimersAsync cascades
    // through the chain because each fireRetry write re-arms the next slot.
    vi.advanceTimersByTime(5 * 60 * 1000 + 10);
    await vi.runAllTimersAsync();

    // Final retryCount should be capped at 3 — no further sends.
    expect(mockTransport.sendPacket).toHaveBeenCalledTimes(3);
    const slot = usePayrollBatchesStore.getState().findById("b1")!.commSendStatus![0];
    expect(slot?.retryCount).toBe(3);

    // Subsequent advancement should not produce any more sends — cap holds.
    vi.advanceTimersByTime(60 * 60 * 1000);
    await vi.runAllTimersAsync();
    expect(mockTransport.sendPacket).toHaveBeenCalledTimes(3);
  });

  it("stops scheduling after 3 retries", async () => {
    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "sent", { txHash: "0x01", retryCount: 3 });

    vi.advanceTimersByTime(60 * 60 * 1000);
    await vi.runAllTimersAsync();
    expect(mockTransport.sendPacket).not.toHaveBeenCalled();
  });

  it("rehydrates schedule from persisted updatedAt — if next-delay window passed, fires immediately", async () => {
    const past = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    usePayrollBatchesStore.setState({
      batches: [
        {
          ...sampleBatch,
          commSendStatus: {
            0: { status: "sent", txHash: "0x01", updatedAt: Date.parse(past), retryCount: 0 },
          },
          updatedAt: past,
        },
      ],
      selectedDraftId: null,
    });

    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    vi.advanceTimersByTime(100);
    // Past-due timer fires immediately; cascade then runs to cap.
    await vi.runAllTimersAsync();
    expect(mockTransport.sendPacket).toHaveBeenCalled();
  });

  it("does not schedule for status='acked'", () => {
    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "acked");
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(mockTransport.sendPacket).not.toHaveBeenCalled();
  });
});
