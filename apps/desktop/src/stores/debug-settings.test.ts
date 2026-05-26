import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryStorage } from "./test-utils/memory-storage";

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("debug-settings store", () => {
  it("defaults showClipboard to false", async () => {
    const { useDebugSettingsStore } = await import("./debug-settings");
    expect(useDebugSettingsStore.getState().showClipboard).toBe(false);
  });

  it("setShowClipboard toggles the value", async () => {
    const { useDebugSettingsStore } = await import("./debug-settings");
    useDebugSettingsStore.getState().setShowClipboard(true);
    expect(useDebugSettingsStore.getState().showClipboard).toBe(true);
    useDebugSettingsStore.getState().setShowClipboard(false);
    expect(useDebugSettingsStore.getState().showClipboard).toBe(false);
  });

  it("persists across module reloads", async () => {
    const first = await import("./debug-settings");
    first.useDebugSettingsStore.getState().setShowClipboard(true);

    vi.resetModules();
    const second = await import("./debug-settings");
    expect(second.useDebugSettingsStore.getState().showClipboard).toBe(true);
  });
});
