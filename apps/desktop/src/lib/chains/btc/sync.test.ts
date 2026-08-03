import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BitcoinScanResponse, BitcoinWatchConfig } from "@chain-pay/shared";
import { useBitcoinWatchStore } from "@/stores/bitcoin-watch";
import { syncBitcoinWatch } from "./sync";
import type { BitcoinBridge } from "./ipc";

const CONFIG: BitcoinWatchConfig = {
  chain: "btc:mainnet",
  gapLimit: 20,
  source: {
    kind: "descriptor",
    descriptor: "tr(xpub)#checksum",
    scriptType: "p2tr",
    extendedPublicKey:
      "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ",
    derivationPath: [0],
  },
};

function response(addresses: string[], usedIndexes: number[], tip = "a"): BitcoinScanResponse {
  return {
    activity: addresses.map((address, index) => ({ address, used: usedIndexes.includes(index) })),
    snapshot: {
      tipHeight: 100,
      tipHash: tip.repeat(64),
      balanceSats: "0",
      addresses,
      utxos: [],
      transactions: [],
    },
  };
}

describe("Bitcoin watch synchronization", () => {
  beforeEach(() => {
    useBitcoinWatchStore.setState({ records: {} });
  });

  it("extends discovery until a full gap follows the highest used receive index", async () => {
    const scan = vi.fn<BitcoinBridge["scan"]>(async (request) =>
      response(request.addresses, [0, 5]),
    );
    const bridge: BitcoinBridge = {
      status: vi.fn(async () => ({ configured: true })),
      transactionStatus: vi.fn(),
      reviewBroadcast: vi.fn(),
      confirmBroadcast: vi.fn(),
      scan,
    };
    await syncBitcoinWatch({ treasuryId: "btc-1", config: CONFIG, bridge });

    expect(scan.mock.calls.map(([request]) => request.addresses.length)).toEqual([20, 26]);
    expect(useBitcoinWatchStore.getState().records["btc-1"]).toMatchObject({
      status: "ready",
      lastUsedIndex: 5,
      nextReceiveIndex: 6,
      scannedThrough: 25,
      consecutiveUnused: 20,
    });
  });

  it("recomputes discovery and replaces an old snapshot when a reorg removes usage", async () => {
    const bridge: BitcoinBridge = {
      status: vi.fn(async () => ({ configured: true })),
      transactionStatus: vi.fn(),
      reviewBroadcast: vi.fn(),
      confirmBroadcast: vi.fn(),
      scan: vi.fn(async (request) => response(request.addresses, [4], "a")),
    };
    await syncBitcoinWatch({ treasuryId: "btc-1", config: CONFIG, bridge });
    expect(useBitcoinWatchStore.getState().records["btc-1"]?.lastUsedIndex).toBe(4);

    bridge.scan = vi.fn(async (request) => response(request.addresses, [], "b"));
    await syncBitcoinWatch({ treasuryId: "btc-1", config: CONFIG, bridge });
    const record = useBitcoinWatchStore.getState().records["btc-1"];
    expect(record?.lastUsedIndex).toBeNull();
    expect(record?.nextReceiveIndex).toBe(0);
    expect(record?.tipHash).toBe("b".repeat(64));
    expect(record?.snapshot?.tipHash).toBe("b".repeat(64));
  });

  it("persists a safe error without leaking provider URLs or credentials", async () => {
    const bridge: BitcoinBridge = {
      status: vi.fn(async () => ({ configured: true })),
      transactionStatus: vi.fn(),
      reviewBroadcast: vi.fn(),
      confirmBroadcast: vi.fn(),
      scan: vi.fn(async () => {
        throw new Error("https://private.example Bearer top-secret");
      }),
    };
    await expect(syncBitcoinWatch({ treasuryId: "btc-1", config: CONFIG, bridge })).rejects.toThrow(
      "Bitcoin provider sync failed",
    );
    expect(useBitcoinWatchStore.getState().records["btc-1"]).toMatchObject({
      status: "error",
      error: "Bitcoin provider sync failed",
    });
  });

  it("rejects a provider response whose activity is not bound to the requested addresses", async () => {
    const bridge: BitcoinBridge = {
      status: vi.fn(async () => ({ configured: true })),
      transactionStatus: vi.fn(),
      reviewBroadcast: vi.fn(),
      confirmBroadcast: vi.fn(),
      scan: vi.fn(async (request) => ({
        ...response(request.addresses, []),
        activity: [{ address: "bc1qwrong", used: false }],
      })),
    };
    await expect(syncBitcoinWatch({ treasuryId: "btc-1", config: CONFIG, bridge })).rejects.toThrow(
      /mismatched/i,
    );
  });
});
