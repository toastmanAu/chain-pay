// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCommChannelSetup } from "./useCommChannelSetup";
import { useCommIdentityStore } from "../../stores/comm-identity";

const FIXTURE_ID = {
  mlDsaPub: "0x" + "11".repeat(1952),
  mlKemPub: "0x" + "22".repeat(1184),
  address: "ckt1qmldsa-x",
  addrHash: "0x" + "33".repeat(20),
  createdAt: 1747900000_000,
  fundedAt: null,
  profileTxHash: null,
  profilePublishedAt: null,
};

function resetStore(): void {
  useCommIdentityStore.setState({ identity: null });
  globalThis.localStorage?.removeItem("chain-pay:comm-identity");
}

function mockChainpay(generateOverride?: typeof window.chainpay.commIdentity.generate) {
  (globalThis as unknown as { window: Window }).window = {
    chainpay: {
      commIdentity: {
        exists: vi.fn().mockResolvedValue(false),
        publicInfo: vi.fn().mockResolvedValue(null),
        generate: generateOverride ?? vi.fn().mockResolvedValue(FIXTURE_ID),
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

describe("useCommChannelSetup", () => {
  beforeEach(() => {
    resetStore();
    mockChainpay();
  });

  it("state.kind = 'not-configured' when no identity", () => {
    const { result } = renderHook(() => useCommChannelSetup());
    expect(result.current.state.kind).toBe("not-configured");
  });

  it("state.kind = 'funding' when identity exists without profileTxHash", () => {
    useCommIdentityStore.setState({ identity: FIXTURE_ID });
    const { result } = renderHook(() => useCommChannelSetup());
    expect(result.current.state.kind).toBe("funding");
    if (result.current.state.kind === "funding") {
      expect(result.current.state.address).toBe(FIXTURE_ID.address);
    }
  });

  it("state.kind = 'ready' when profileTxHash is set", () => {
    useCommIdentityStore.setState({
      identity: { ...FIXTURE_ID, profileTxHash: "0xpubtx", profilePublishedAt: Date.now() },
    });
    const { result } = renderHook(() => useCommChannelSetup());
    expect(result.current.state.kind).toBe("ready");
  });

  it("generate() calls the IPC verb and sets identity in store", async () => {
    const { result } = renderHook(() => useCommChannelSetup());
    await act(async () => {
      await result.current.generate();
    });
    expect(window.chainpay.commIdentity.generate).toHaveBeenCalledTimes(1);
    expect(useCommIdentityStore.getState().identity?.address).toBe(FIXTURE_ID.address);
  });

  it("deleteIdentity() calls the IPC verb and clears the store", async () => {
    useCommIdentityStore.setState({ identity: FIXTURE_ID });
    const { result } = renderHook(() => useCommChannelSetup());
    await act(async () => {
      await result.current.deleteIdentity();
    });
    expect(window.chainpay.commIdentity.delete).toHaveBeenCalledTimes(1);
    expect(useCommIdentityStore.getState().identity).toBeNull();
  });

  it("generate() surfaces errors as IdentityGenerationError", async () => {
    mockChainpay(vi.fn().mockRejectedValue(new Error("safeStorage unavailable")));
    const { result } = renderHook(() => useCommChannelSetup());
    await expect(
      act(async () => {
        await result.current.generate();
      }),
    ).rejects.toThrow();
  });
});
