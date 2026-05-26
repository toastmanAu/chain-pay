import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "./test-utils/memory-storage";

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("clipboard store", () => {
  it("starts with four empty bins", async () => {
    const { useClipboardStore } = await import("./clipboard");
    const bins = useClipboardStore.getState().bins;
    expect(bins).toHaveLength(4);
    expect(bins.every((b) => b.value === "")).toBe(true);
  });

  it("persists bin contents across re-imports", async () => {
    const first = await import("./clipboard");
    first.useClipboardStore.getState().setBin(0, "ckt1qpw...", "treasury");

    vi.resetModules();
    const second = await import("./clipboard");
    const bin = second.useClipboardStore.getState().bins[0];
    expect(bin?.value).toBe("ckt1qpw...");
    expect(bin?.label).toBe("treasury");
    expect(bin?.savedAt).not.toBeNull();
  });

  it("saveToNextOpen fills the first empty slot", async () => {
    const { useClipboardStore } = await import("./clipboard");
    useClipboardStore.getState().setBin(0, "first");
    const id = useClipboardStore.getState().saveToNextOpen("second");
    expect(id).toBe(1);
    expect(useClipboardStore.getState().bins[1]?.value).toBe("second");
  });

  it("saveToNextOpen rotates the oldest bin when all are full", async () => {
    const { useClipboardStore } = await import("./clipboard");
    const store = useClipboardStore.getState();
    store.setBin(0, "a");
    await new Promise((r) => setTimeout(r, 2));
    store.setBin(1, "b");
    await new Promise((r) => setTimeout(r, 2));
    store.setBin(2, "c");
    await new Promise((r) => setTimeout(r, 2));
    store.setBin(3, "d");
    const id = useClipboardStore.getState().saveToNextOpen("rotated");
    expect(id).toBe(0);
    expect(useClipboardStore.getState().bins[0]?.value).toBe("rotated");
  });

  it("clearBin resets one bin to empty state without touching others", async () => {
    const { useClipboardStore } = await import("./clipboard");
    useClipboardStore.getState().setBin(0, "keep");
    useClipboardStore.getState().setBin(1, "remove");
    useClipboardStore.getState().clearBin(1);
    const bins = useClipboardStore.getState().bins;
    expect(bins[0]?.value).toBe("keep");
    expect(bins[1]?.value).toBe("");
    expect(bins[1]?.label).toBe("Bin 2");
  });
});
