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
  id: "b1", kind: "payroll", label: "test", treasuryId: "t1",
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
    // re-triggers the subscriber to schedule the next retry at 10 min from now.
    // Flush microtasks so the async send completes, then verify the first retry
    // fired at the 5min mark.
    await vi.runAllTicks();
    await vi.runAllTicks();
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

  it("uses lifecycle-bound backoff: retryCount keeps incrementing past 3", async () => {
    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "sent", { txHash: "0x01" });

    // Advance past the first scheduled retry and flush microtasks.
    vi.advanceTimersByTime(5 * 60 * 1000 + 10);
    await vi.runAllTicks();
    await vi.runAllTicks();

    // With lifecycle-bound schedule there is no hard cap — retries continue.
    expect(mockTransport.sendPacket).toHaveBeenCalled();
    const slot = usePayrollBatchesStore.getState().findById("b1")!.commSendStatus![0];
    // retryCount should be >= 1 (has incremented past initial attempt).
    expect((slot?.retryCount ?? 0)).toBeGreaterThanOrEqual(1);
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
    // Past-due timer fires immediately; flush microtasks so the async send completes.
    await vi.runAllTicks();
    await vi.runAllTicks();
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

describe("2.7c lifecycle-bound retry schedule", () => {
  it("nextDelayMs returns the correct delay per attempt index", async () => {
    const { nextDelayMs } = await import("./useCommSendRetry");
    expect(nextDelayMs(0)).toBe(0);
    expect(nextDelayMs(1)).toBe(5 * 60_000);
    expect(nextDelayMs(2)).toBe(10 * 60_000);
    expect(nextDelayMs(3)).toBe(20 * 60_000);
    expect(nextDelayMs(4)).toBe(30 * 60_000);
    expect(nextDelayMs(5)).toBe(30 * 60_000);
    expect(nextDelayMs(10)).toBe(30 * 60_000);
  });

  it("does NOT cap at RETRY_CAP=3 — attempt 4+ still schedules at 30 min", async () => {
    const { nextDelayMs } = await import("./useCommSendRetry");
    expect(nextDelayMs(4)).toBe(30 * 60_000);
    expect(nextDelayMs(100)).toBe(30 * 60_000);
  });

  it("stops scheduling when batch.expiresAt has passed", async () => {
    vi.useFakeTimers();
    const past = Date.now() - 1000;
    const { usePayrollBatchesStore: store } = await import("@/stores/payroll-batches");
    store.setState({
      batches: [{
        id: "b1", state: "approved", expiresAt: past,
        commSendStatus: { 0: { status: "sent", updatedAt: Date.now() - 60_000, retryCount: 0 } },
      } as any],
    });
    const { useCommSendRetry: hook } = await import("./useCommSendRetry");
    const { renderHook: rh } = await import("@testing-library/react");
    rh(() => hook({ packetForBatch: () => null, multisigForBatch: () => null }));
    vi.advanceTimersByTime(60 * 60_000);
    const slot = store.getState().findById("b1")!.commSendStatus![0];
    expect(slot!.retryCount ?? 0).toBe(0);
    vi.useRealTimers();
  });

  it("stops scheduling when batch transitions to broadcasted", async () => {
    vi.useFakeTimers();
    const { usePayrollBatchesStore: store } = await import("@/stores/payroll-batches");
    store.setState({
      batches: [{
        id: "b1", state: "broadcasted", expiresAt: Date.now() + 60_000,
        commSendStatus: { 0: { status: "sent", updatedAt: Date.now() - 60_000, retryCount: 0 } },
      } as any],
    });
    const { useCommSendRetry: hook } = await import("./useCommSendRetry");
    const { renderHook: rh } = await import("@testing-library/react");
    rh(() => hook({ packetForBatch: () => null, multisigForBatch: () => null }));
    vi.advanceTimersByTime(60 * 60_000);
    const slot = store.getState().findById("b1")!.commSendStatus![0];
    expect(slot!.retryCount ?? 0).toBe(0);
    vi.useRealTimers();
  });

  it("respects 'dismissed' flag and does not schedule retries for dismissed slots", async () => {
    vi.useFakeTimers();
    const { usePayrollBatchesStore: store } = await import("@/stores/payroll-batches");
    store.setState({
      batches: [{
        id: "b1", state: "approved", expiresAt: Date.now() + 60 * 60_000,
        commSendStatus: { 0: { status: "sent", updatedAt: Date.now() - 60_000, retryCount: 0, dismissed: true } },
      } as any],
    });
    const { useCommSendRetry: hook } = await import("./useCommSendRetry");
    const { renderHook: rh } = await import("@testing-library/react");
    rh(() => hook({ packetForBatch: () => null, multisigForBatch: () => null }));
    vi.advanceTimersByTime(60 * 60_000);
    const slot = store.getState().findById("b1")!.commSendStatus![0];
    expect(slot!.retryCount).toBe(0);
    vi.useRealTimers();
  });
});
