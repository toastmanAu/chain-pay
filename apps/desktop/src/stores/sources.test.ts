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

  it("ignores addSource for an address that already exists (keeps the original)", async () => {
    const { useSourcesStore } = await import("./sources");
    const first = makeSource("a"); // address ckt1qa
    const dupAddr = { ...makeSource("b"), address: first.address }; // same address, different id
    useSourcesStore.getState().addSource(first);
    useSourcesStore.getState().addSource(dupAddr);
    const s = useSourcesStore.getState();
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]?.id).toBe("a");
    expect(s.activeSourceId).toBe("a");
  });

  it("still adds sources with distinct addresses", async () => {
    const { useSourcesStore } = await import("./sources");
    useSourcesStore.getState().addSource(makeSource("a")); // ckt1qa
    useSourcesStore.getState().addSource(makeSource("b")); // ckt1qb
    expect(useSourcesStore.getState().sources).toHaveLength(2);
  });
});

describe("dedupeSourcesByAddress", () => {
  it("collapses duplicates by address keeping the oldest createdAt", async () => {
    const { dedupeSourcesByAddress } = await import("./sources");
    const older: Source = { ...makeSource("old"), address: "ckt1qdup", createdAt: "2026-06-01T00:00:00Z" };
    const newer: Source = { ...makeSource("new"), address: "ckt1qdup", createdAt: "2026-06-29T00:00:00Z" };
    const solo: Source = { ...makeSource("solo"), address: "ckt1qsolo" };
    const { sources } = dedupeSourcesByAddress([newer, older, solo], "new");
    expect(sources.map((s) => s.id).sort()).toEqual(["old", "solo"]);
  });

  it("repoints activeSourceId to the surviving entry when the active one was dropped", async () => {
    const { dedupeSourcesByAddress } = await import("./sources");
    const older: Source = { ...makeSource("old"), address: "ckt1qdup", createdAt: "2026-06-01T00:00:00Z" };
    const newer: Source = { ...makeSource("new"), address: "ckt1qdup", createdAt: "2026-06-29T00:00:00Z" };
    const { activeSourceId } = dedupeSourcesByAddress([older, newer], "new");
    expect(activeSourceId).toBe("old"); // "new" dropped → repoint to same-address survivor
  });

  it("leaves a still-present activeSourceId untouched", async () => {
    const { dedupeSourcesByAddress } = await import("./sources");
    const a: Source = { ...makeSource("a"), address: "ckt1qa" };
    const b: Source = { ...makeSource("b"), address: "ckt1qb" };
    const { activeSourceId } = dedupeSourcesByAddress([a, b], "b");
    expect(activeSourceId).toBe("b");
  });

  it("handles empty input and null active without throwing", async () => {
    const { dedupeSourcesByAddress } = await import("./sources");
    expect(dedupeSourcesByAddress([], null)).toEqual({ sources: [], activeSourceId: null });
  });

  it("migrates persisted v1 state by collapsing duplicates on load", async () => {
    // Seed a v1 persisted payload with two same-address entries before import.
    const dup = (id: string, createdAt: string) => ({
      id,
      label: `w ${id}`,
      chain: "ckb:testnet",
      address: "ckt1qmig",
      joyidLockArgs: "0x" + "11".repeat(20),
      createdAt,
      updatedAt: createdAt,
    });
    const v1 = {
      state: { sources: [dup("new", "2026-06-29T00:00:00Z"), dup("old", "2026-06-01T00:00:00Z")], activeSourceId: "new" },
      version: 1,
    };
    globalThis.localStorage?.setItem("chain-pay:sources", JSON.stringify(v1));
    vi.resetModules();
    const { useSourcesStore } = await import("./sources");
    const s = useSourcesStore.getState();
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]?.id).toBe("old");
    expect(s.activeSourceId).toBe("old");
  });

  it("migrates v1 with non-array sources (corrupt) without throwing", async () => {
    // Seed a v1 persisted payload where sources is tampered (e.g., a number or object)
    // instead of an array. Migration must be total — never throw on untrusted state.
    const v1Corrupt = {
      state: { sources: 42, activeSourceId: "active" },
      version: 1,
    };
    globalThis.localStorage?.setItem("chain-pay:sources", JSON.stringify(v1Corrupt));
    vi.resetModules();
    const { useSourcesStore } = await import("./sources");
    const s = useSourcesStore.getState();
    expect(s.sources).toEqual([]);
    expect(s.activeSourceId).toBeNull();
  });
});
