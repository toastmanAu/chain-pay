import { afterEach, describe, expect, it, vi } from "vitest";
import { bitcoinAdapter } from "./adapter";

const MAINNET = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const TESTNET = "tb1qfm4w4trj4g5du3zpmz58fkxk3vnvsq4wq7wc9f";

function installBridge(): {
  scan: ReturnType<typeof vi.fn>;
  transactionStatus: ReturnType<typeof vi.fn>;
  reviewBroadcast: ReturnType<typeof vi.fn>;
  confirmBroadcast: ReturnType<typeof vi.fn>;
} {
  const scan = vi.fn(async (request: { addresses: string[] }) => ({
    activity: request.addresses.map((address) => ({ address, used: true })),
    snapshot: {
      tipHeight: 100,
      tipHash: "a".repeat(64),
      balanceSats: "2100000000000000",
      addresses: request.addresses,
      utxos: [],
      transactions: [],
    },
  }));
  const transactionStatus = vi.fn(async () => ({
    state: "confirming" as const,
    confirmations: 2,
    blockHeight: 99,
    blockHash: "b".repeat(64),
  }));
  const reviewBroadcast = vi.fn();
  const confirmBroadcast = vi.fn();
  (globalThis as unknown as { window: { chainpay: { bitcoin: unknown } } }).window = {
    chainpay: {
      bitcoin: {
        status: vi.fn(async () => ({ configured: true })),
        scan,
        transactionStatus,
        reviewBroadcast,
        confirmBroadcast,
      },
    },
  };
  return { scan, transactionStatus, reviewBroadcast, confirmBroadcast };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("Bitcoin ChainAdapter", () => {
  it("validates addresses against the selected network", () => {
    const mainnet = bitcoinAdapter("btc:mainnet");
    expect(mainnet.validateAddress(MAINNET)).toEqual({ valid: true, normalized: MAINNET });
    expect(mainnet.validateAddress(TESTNET)).toMatchObject({ valid: false });
  });

  it("reads exact satoshi balances and canonical transaction status through IPC", async () => {
    const bridge = installBridge();
    const adapter = bitcoinAdapter("btc:mainnet");
    await expect(adapter.getBalance(MAINNET)).resolves.toEqual({
      asset: "BTC",
      value: 2_100_000_000_000_000n,
      decimals: 8,
    });
    const hash = `0x${"c".repeat(64)}` as `0x${string}`;
    await expect(adapter.getTransactionStatus(hash)).resolves.toEqual({
      hash,
      state: "confirming",
      confirmations: 2,
      blockNumber: 99n,
    });
    expect(bridge.transactionStatus).toHaveBeenCalledWith({
      chain: "btc:mainnet",
      txid: "c".repeat(64),
    });
  });

  it("refuses every transaction construction and broadcast surface", async () => {
    const adapter = bitcoinAdapter("btc:mainnet");
    const request = {
      from: MAINNET,
      outputs: [{ to: MAINNET, amount: { asset: "BTC", value: 1n, decimals: 8 } }],
    };
    await expect(adapter.estimateFee(request)).rejects.toThrow(/watch-only/i);
    await expect(adapter.createUnsignedTransaction(request)).rejects.toThrow(/watch-only/i);
    await expect(adapter.broadcastTransaction({ payload: "00" })).rejects.toThrow(/watch-only/i);
  });
});
