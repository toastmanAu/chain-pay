// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { PayrollBatch, TransferPacket } from "@chain-pay/shared";
import type { CommTransport, OutgoingPacket, PeerProfile } from "@/lib/comm/types";

// Mock the transport factory so tests control sendPacket / resolveProfile behavior.
const mockTransport = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  isRunning: vi.fn().mockReturnValue(true),
  publishProfile: vi.fn(),
  resolveProfile: vi.fn(),
  sendPacket: vi.fn(),
  sendSignature: vi.fn(),
  sendAck: vi.fn(),
  onIncomingPacket: vi.fn(),
  onIncomingSignature: vi.fn(),
  onIncomingAck: vi.fn(),
} satisfies CommTransport;

let transportFactoryReturns: CommTransport | null = mockTransport;

vi.mock("@/lib/comm", async () => {
  const real = await vi.importActual<typeof import("@/lib/comm")>("@/lib/comm");
  return {
    ...real,
    createCommTransport: (): CommTransport | null => transportFactoryReturns,
  };
});

import { usePeerBookStore } from "@/stores/peer-book";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { useCommSendDispatch } from "./useCommSendDispatch";

const HASH_A = `0x${"a1".repeat(20)}` as const;
const HASH_B = `0x${"b2".repeat(20)}` as const;
const HASH_C = `0x${"c3".repeat(20)}` as const;
const PACKET: OutgoingPacket = {
  txHash: `0x${"dd".repeat(32)}`,
  treasuryAddress: "ckt1qtrz",
  expiresAt: 9_999_999_999,
  packet: "encoded-packet" as TransferPacket,
};
const MULTISIG = { pubkeyHashes: [HASH_A, HASH_B] as const };

const sampleBatch: PayrollBatch = {
  id: "send-1",
  kind: "payroll",
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

function fakeProfile(address: string): PeerProfile {
  return {
    address,
    mlDsaPubKey: new Uint8Array(1952),
    mlKemPubKey: new Uint8Array(1184),
    fetchedAt: Date.now(),
  };
}

function reset(): void {
  vi.clearAllMocks();
  transportFactoryReturns = mockTransport;
  usePeerBookStore.setState({ peers: [], knownSignersGetter: () => [] });
  usePayrollBatchesStore.setState({ batches: [], selectedDraftId: null });
  globalThis.localStorage?.removeItem("chain-pay:peer-book");
  globalThis.localStorage?.removeItem("chain-pay:payroll-batches");
  mockTransport.resolveProfile.mockImplementation(async (addr: string) => fakeProfile(addr));
  mockTransport.sendPacket.mockResolvedValue(`0x${"01".repeat(32)}`);
}

describe("useCommSendDispatch", () => {
  beforeEach(reset);

  it("sendAll dispatches to every mapped peer and records 'sent' per slot", async () => {
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
      new Uint8Array(20),
    );
    usePeerBookStore.getState().addPeer(
      { nickname: "Bob", address: "ckt1qbob", pairedAt: 0, associatedSignerHash: HASH_B },
      new Uint8Array(20),
    );
    usePayrollBatchesStore.getState().addBatch(sampleBatch);

    const { result } = renderHook(() => useCommSendDispatch());
    await act(async () => {
      await result.current.sendAll("send-1", PACKET, MULTISIG);
    });

    expect(mockTransport.sendPacket).toHaveBeenCalledTimes(2);
    const batch = usePayrollBatchesStore.getState().findById("send-1");
    expect(batch?.commSendStatus?.[0]?.status).toBe("sent");
    expect(batch?.commSendStatus?.[1]?.status).toBe("sent");
  });

  it("sendAll records 'error: no peer mapped' for a slot with no associated peer", async () => {
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
      new Uint8Array(20),
    );
    usePayrollBatchesStore.getState().addBatch(sampleBatch);

    const { result } = renderHook(() => useCommSendDispatch());
    await act(async () => {
      await result.current.sendAll("send-1", PACKET, MULTISIG);
    });

    const batch = usePayrollBatchesStore.getState().findById("send-1");
    expect(batch?.commSendStatus?.[0]?.status).toBe("sent");
    expect(batch?.commSendStatus?.[1]?.status).toBe("error");
    expect(batch?.commSendStatus?.[1]?.error).toMatch(/no peer mapped/i);
  });

  it("sendAll allows partial sends — mapped slots still dispatch when others lack peers", async () => {
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
      new Uint8Array(20),
    );
    usePayrollBatchesStore.getState().addBatch(sampleBatch);

    const { result } = renderHook(() => useCommSendDispatch());
    await act(async () => {
      await result.current.sendAll("send-1", PACKET, { pubkeyHashes: [HASH_A, HASH_B, HASH_C] });
    });

    expect(mockTransport.sendPacket).toHaveBeenCalledTimes(1);
    const batch = usePayrollBatchesStore.getState().findById("send-1");
    expect(batch?.commSendStatus?.[0]?.status).toBe("sent");
    expect(batch?.commSendStatus?.[1]?.status).toBe("error");
    expect(batch?.commSendStatus?.[2]?.status).toBe("error");
  });

  it("retry re-dispatches only the named slot", async () => {
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
      new Uint8Array(20),
    );
    usePeerBookStore.getState().addPeer(
      { nickname: "Bob", address: "ckt1qbob", pairedAt: 0, associatedSignerHash: HASH_B },
      new Uint8Array(20),
    );
    usePayrollBatchesStore.getState().addBatch(sampleBatch);

    const { result } = renderHook(() => useCommSendDispatch());
    await act(async () => {
      await result.current.retry("send-1", 1, PACKET, MULTISIG);
    });

    expect(mockTransport.sendPacket).toHaveBeenCalledTimes(1);
    const batch = usePayrollBatchesStore.getState().findById("send-1");
    expect(batch?.commSendStatus?.[0]).toBeUndefined();
    expect(batch?.commSendStatus?.[1]?.status).toBe("sent");
  });

  it("sendPacket throwing records 'error' with the thrown message on that slot", async () => {
    mockTransport.sendPacket.mockRejectedValueOnce(new Error("ipc broke"));
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
      new Uint8Array(20),
    );
    usePayrollBatchesStore.getState().addBatch(sampleBatch);

    const { result } = renderHook(() => useCommSendDispatch());
    await act(async () => {
      await result.current.sendAll("send-1", PACKET, { pubkeyHashes: [HASH_A] });
    });

    const batch = usePayrollBatchesStore.getState().findById("send-1");
    expect(batch?.commSendStatus?.[0]?.status).toBe("error");
    expect(batch?.commSendStatus?.[0]?.error).toBe("ipc broke");
  });

  it("resolveProfile throwing records 'error' (no profile published)", async () => {
    mockTransport.resolveProfile.mockRejectedValueOnce(new Error("profile not found"));
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
      new Uint8Array(20),
    );
    usePayrollBatchesStore.getState().addBatch(sampleBatch);

    const { result } = renderHook(() => useCommSendDispatch());
    await act(async () => {
      await result.current.sendAll("send-1", PACKET, { pubkeyHashes: [HASH_A] });
    });

    const batch = usePayrollBatchesStore.getState().findById("send-1");
    expect(batch?.commSendStatus?.[0]?.status).toBe("error");
    expect(batch?.commSendStatus?.[0]?.error).toMatch(/profile not found/);
  });

  it("returns 'error: comm channel not started' when the transport factory returns null", async () => {
    transportFactoryReturns = null;
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
      new Uint8Array(20),
    );
    usePayrollBatchesStore.getState().addBatch(sampleBatch);

    const { result } = renderHook(() => useCommSendDispatch());
    await act(async () => {
      await result.current.sendAll("send-1", PACKET, { pubkeyHashes: [HASH_A] });
    });

    const batch = usePayrollBatchesStore.getState().findById("send-1");
    expect(batch?.commSendStatus?.[0]?.status).toBe("error");
    expect(batch?.commSendStatus?.[0]?.error).toMatch(/comm channel not started/i);
  });
});
