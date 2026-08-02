import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitcoinWatchConfig, BitcoinWatchSnapshot } from "@chain-pay/shared";
import { MemoryStorage } from "./test-utils/memory-storage";

const CONFIG: BitcoinWatchConfig = {
  chain: "btc:mainnet",
  gapLimit: 2,
  source: {
    kind: "descriptor",
    descriptor: "wpkh(xpub-example/0/*)#checksum",
    scriptType: "p2wpkh",
    extendedPublicKey: "xpub-example",
    derivationPath: [0],
  },
};

function snapshot(overrides: Partial<BitcoinWatchSnapshot> = {}): BitcoinWatchSnapshot {
  return {
    tipHeight: 100,
    tipHash: "a".repeat(64),
    balanceSats: "125000000",
    addresses: ["bc1qone", "bc1qtwo"],
    utxos: [
      {
        txid: "b".repeat(64),
        vout: 0,
        address: "bc1qone",
        valueSats: "125000000",
        confirmed: true,
        blockHeight: 99,
        blockHash: "c".repeat(64),
        confirmations: 2,
      },
    ],
    transactions: [],
    ...overrides,
  };
}

describe("Bitcoin watch sync persistence", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("persists every contiguous discovery cursor and resumes an interrupted scan", async () => {
    const first = await import("./bitcoin-watch");
    first.useBitcoinWatchStore.getState().ensure("btc-1", CONFIG);
    first.useBitcoinWatchStore.getState().beginSync("btc-1", CONFIG);
    first.useBitcoinWatchStore.getState().recordDiscovery("btc-1", { scannedIndex: 0, used: true });
    first.useBitcoinWatchStore.getState().recordDiscovery("btc-1", { scannedIndex: 1, used: false });

    vi.resetModules();
    const second = await import("./bitcoin-watch");
    const restored = second.useBitcoinWatchStore.getState().records["btc-1"];
    expect(restored).toMatchObject({
      status: "syncing",
      lastUsedIndex: 0,
      nextReceiveIndex: 1,
      scannedThrough: 1,
      nextScanIndex: 2,
      consecutiveUnused: 1,
    });

    second.useBitcoinWatchStore.getState().beginSync("btc-1", CONFIG);
    second.useBitcoinWatchStore.getState().recordDiscovery("btc-1", { scannedIndex: 2, used: false });
    expect(second.useBitcoinWatchStore.getState().records["btc-1"]?.consecutiveUnused).toBe(2);
  });

  it("rejects non-contiguous discovery progress", async () => {
    const { useBitcoinWatchStore } = await import("./bitcoin-watch");
    useBitcoinWatchStore.getState().ensure("btc-1", CONFIG);
    useBitcoinWatchStore.getState().beginSync("btc-1", CONFIG);
    expect(() =>
      useBitcoinWatchStore.getState().recordDiscovery("btc-1", { scannedIndex: 1, used: false }),
    ).toThrow(/contiguous/i);
  });

  it("atomically replaces the prior snapshot after a reorg-safe refresh", async () => {
    const { useBitcoinWatchStore } = await import("./bitcoin-watch");
    useBitcoinWatchStore.getState().ensure("btc-1", CONFIG);
    useBitcoinWatchStore.getState().beginSync("btc-1", CONFIG);
    useBitcoinWatchStore.getState().commitSync("btc-1", snapshot());

    const reorged = snapshot({
      tipHeight: 101,
      tipHash: "d".repeat(64),
      balanceSats: "0",
      utxos: [],
    });
    useBitcoinWatchStore.getState().beginSync("btc-1", CONFIG);
    useBitcoinWatchStore.getState().commitSync("btc-1", reorged);

    const record = useBitcoinWatchStore.getState().records["btc-1"];
    expect(record?.tipHash).toBe("d".repeat(64));
    expect(record?.snapshot).toEqual(reorged);
    expect(record?.snapshot?.utxos).toEqual([]);
  });

  it("rejects imprecise or malformed provider amounts before persistence", async () => {
    const { useBitcoinWatchStore } = await import("./bitcoin-watch");
    useBitcoinWatchStore.getState().ensure("btc-1", CONFIG);
    expect(() =>
      useBitcoinWatchStore.getState().commitSync("btc-1", snapshot({ balanceSats: "1.5" })),
    ).toThrow(/satoshi/i);
  });
});
