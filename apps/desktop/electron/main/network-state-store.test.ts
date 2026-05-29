import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "chainpay-net-state-"));
  process.env.NETWORK_STATE_DIR = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NETWORK_STATE_DIR;
});

describe("network-state-store", () => {
  it("returns 'testnet' on missing file", async () => {
    const { loadNetworkState } = await import("./network-state-store");
    expect(loadNetworkState()).toBe("testnet");
  });

  it("writes then reads roundtrip", async () => {
    const { loadNetworkState, saveNetworkState } = await import("./network-state-store");
    saveNetworkState("mainnet");
    expect(loadNetworkState()).toBe("mainnet");
  });

  it("returns 'testnet' on malformed JSON", async () => {
    writeFileSync(join(tmpDir, "network-state.json"), "{ not valid json");
    const { loadNetworkState } = await import("./network-state-store");
    expect(loadNetworkState()).toBe("testnet");
  });

  it("returns 'testnet' on a file with an unexpected network value", async () => {
    writeFileSync(
      join(tmpDir, "network-state.json"),
      JSON.stringify({ network: "sepolia" }),
    );
    const { loadNetworkState } = await import("./network-state-store");
    expect(loadNetworkState()).toBe("testnet");
  });
});
