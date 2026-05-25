import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "./test-utils/memory-storage";

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("network-config store", () => {
  it("defaults network to 'testnet'", async () => {
    const { useNetworkConfigStore } = await import("./network-config");
    expect(useNetworkConfigStore.getState().network).toBe("testnet");
  });

  it("setNetwork updates the field", async () => {
    const { useNetworkConfigStore } = await import("./network-config");
    useNetworkConfigStore.getState().setNetwork("mainnet");
    expect(useNetworkConfigStore.getState().network).toBe("mainnet");
  });

  it("persists network across re-imports", async () => {
    const first = await import("./network-config");
    first.useNetworkConfigStore.getState().setNetwork("mainnet");
    vi.resetModules();
    const second = await import("./network-config");
    expect(second.useNetworkConfigStore.getState().network).toBe("mainnet");
  });

  it("migrates v1 (no network field) → v2 by backfilling 'testnet'", async () => {
    // Seed localStorage with v1 shape — only broadcastRpcUrl, no network.
    globalThis.localStorage.setItem(
      "chain-pay:network-config",
      JSON.stringify({
        state: { broadcastRpcUrl: "http://1.2.3.4:8114" },
        version: 1,
      }),
    );
    const { useNetworkConfigStore } = await import("./network-config");
    expect(useNetworkConfigStore.getState().network).toBe("testnet");
    expect(useNetworkConfigStore.getState().broadcastRpcUrl).toBe("http://1.2.3.4:8114");
  });

  it("preserves broadcastRpcUrl setter independently of network", async () => {
    const { useNetworkConfigStore } = await import("./network-config");
    useNetworkConfigStore.getState().setBroadcastRpcUrl("http://5.6.7.8:8114");
    useNetworkConfigStore.getState().setNetwork("mainnet");
    expect(useNetworkConfigStore.getState().broadcastRpcUrl).toBe("http://5.6.7.8:8114");
    expect(useNetworkConfigStore.getState().network).toBe("mainnet");
  });
});
