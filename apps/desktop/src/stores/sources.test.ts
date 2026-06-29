import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Source } from "@chain-pay/shared";
import { MemoryStorage } from "./test-utils/memory-storage";

function makeSource(id: string): Source {
  return {
    id,
    label: `wallet ${id}`,
    chain: "ckb:testnet",
    address: `ckt1q${id}`,
    joyidLockArgs: "0x1234567890123456789012345678901234567890",
    createdAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z",
  };
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("useSourcesStore", () => {
  it("starts with an empty sources list", async () => {
    const { useSourcesStore } = await import("./sources");
    expect(useSourcesStore.getState().sources).toEqual([]);
  });

  it("adds a source and auto-selects the first one", async () => {
    const { useSourcesStore } = await import("./sources");
    useSourcesStore.getState().addSource(makeSource("a"));
    const s = useSourcesStore.getState();
    expect(s.sources).toHaveLength(1);
    expect(s.activeSourceId).toBe("a");
  });

  it("adds multiple sources and keeps the first one active", async () => {
    const { useSourcesStore } = await import("./sources");
    useSourcesStore.getState().addSource(makeSource("a"));
    useSourcesStore.getState().addSource(makeSource("b"));
    const s = useSourcesStore.getState();
    expect(s.sources).toHaveLength(2);
    expect(s.activeSourceId).toBe("a");
  });

  it("removes a source and clears active when it was active", async () => {
    const { useSourcesStore } = await import("./sources");
    useSourcesStore.getState().addSource(makeSource("a"));
    useSourcesStore.getState().removeSource("a");
    expect(useSourcesStore.getState().sources).toHaveLength(0);
    expect(useSourcesStore.getState().activeSourceId).toBeNull();
  });

  it("removes a non-active source without affecting activeSourceId", async () => {
    const { useSourcesStore } = await import("./sources");
    useSourcesStore.getState().addSource(makeSource("a"));
    useSourcesStore.getState().addSource(makeSource("b"));
    useSourcesStore.getState().removeSource("b");
    expect(useSourcesStore.getState().sources).toHaveLength(1);
    expect(useSourcesStore.getState().activeSourceId).toBe("a");
  });

  it("setActiveSource changes the active source", async () => {
    const { useSourcesStore } = await import("./sources");
    useSourcesStore.getState().addSource(makeSource("a"));
    useSourcesStore.getState().addSource(makeSource("b"));
    useSourcesStore.getState().setActiveSource("b");
    expect(useSourcesStore.getState().activeSourceId).toBe("b");
  });

  it("setActiveSource can clear the active source with null", async () => {
    const { useSourcesStore } = await import("./sources");
    useSourcesStore.getState().addSource(makeSource("a"));
    useSourcesStore.getState().setActiveSource(null);
    expect(useSourcesStore.getState().activeSourceId).toBeNull();
  });

  it("finds by id", async () => {
    const { useSourcesStore } = await import("./sources");
    useSourcesStore.getState().addSource(makeSource("a"));
    expect(useSourcesStore.getState().findById("a")?.label).toBe("wallet a");
    expect(useSourcesStore.getState().findById("z")).toBeUndefined();
  });

  it("persists sources across re-imports", async () => {
    const first = await import("./sources");
    first.useSourcesStore.getState().addSource(makeSource("persist-a"));
    expect(first.useSourcesStore.getState().sources).toHaveLength(1);

    vi.resetModules();
    const second = await import("./sources");
    const got = second.useSourcesStore.getState().sources[0];
    expect(got?.id).toBe("persist-a");
    expect(got?.label).toBe("wallet persist-a");
    expect(second.useSourcesStore.getState().activeSourceId).toBe("persist-a");
  });
});
