import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SolanaWatchConfig, SolanaWatchSnapshot } from "@chain-pay/shared";
import { MemoryStorage } from "./test-utils/memory-storage";

const config: SolanaWatchConfig = { chain: "sol:devnet", address: "11111111111111111111111111111111" };

function snapshot(overrides: Partial<SolanaWatchSnapshot> = {}): SolanaWatchSnapshot {
  return {
    address: config.address,
    slot: "9007199254740993",
    blockhash: "11111111111111111111111111111111",
    lastValidBlockHeight: "9007199254741100",
    balanceLamports: "9007199254740995",
    historyCursor: null,
    historyTruncated: false,
    transactions: [{
      signature: "signature-one",
      slot: "9007199254740992",
      blockTime: 1_700_000_000,
      state: "finalized",
      netLamports: "2",
      feeLamports: "5000",
      feePaidByWatched: true,
    }],
    ...overrides,
  };
}

describe("Solana watch persistence", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
    vi.resetModules();
  });
  afterEach(() => { delete (globalThis as { localStorage?: Storage }).localStorage; });

  it("persists exact decimal amounts and atomically replaces snapshots", async () => {
    const { useSolanaWatchStore } = await import("./solana-watch");
    useSolanaWatchStore.getState().ensure("sol-1", config);
    useSolanaWatchStore.getState().beginSync("sol-1", config);
    useSolanaWatchStore.getState().commitSync("sol-1", snapshot());
    const replacement = snapshot({ slot: "9007199254741000", balanceLamports: "0", transactions: [] });
    useSolanaWatchStore.getState().beginSync("sol-1", config);
    useSolanaWatchStore.getState().commitSync("sol-1", replacement);
    expect(useSolanaWatchStore.getState().records["sol-1"]?.snapshot).toEqual(replacement);
  });

  it("flags a finalized transaction that disappears or regresses", async () => {
    const { useSolanaWatchStore } = await import("./solana-watch");
    useSolanaWatchStore.getState().ensure("sol-1", config);
    useSolanaWatchStore.getState().commitSync("sol-1", snapshot());
    useSolanaWatchStore.getState().commitSync("sol-1", snapshot({ transactions: [] }));
    expect(useSolanaWatchStore.getState().records["sol-1"]).toMatchObject({ rollbackDetected: true, rollbackSignatures: ["signature-one"] });

    useSolanaWatchStore.getState().commitSync("sol-1", snapshot());
    useSolanaWatchStore.getState().updateTransactionStatus("sol-1", "signature-one", "confirmed");
    expect(useSolanaWatchStore.getState().records["sol-1"]?.rollbackDetected).toBe(true);
  });

  it("does not treat omissions from bounded history as rollbacks", async () => {
    const { useSolanaWatchStore } = await import("./solana-watch");
    useSolanaWatchStore.getState().ensure("sol-1", config);
    useSolanaWatchStore.getState().commitSync("sol-1", snapshot());
    useSolanaWatchStore.getState().commitSync("sol-1", snapshot({ transactions: [], historyTruncated: true, historyCursor: "cursor" }));
    expect(useSolanaWatchStore.getState().records["sol-1"]?.rollbackDetected).toBe(false);
  });

  it("detects backward or conflicting finalized contexts", async () => {
    const { useSolanaWatchStore } = await import("./solana-watch");
    useSolanaWatchStore.getState().ensure("sol-1", config);
    useSolanaWatchStore.getState().commitSync("sol-1", snapshot({ transactions: [] }));
    useSolanaWatchStore.getState().commitSync("sol-1", snapshot({
      transactions: [],
      blockhash: "22222222222222222222222222222222",
    }));
    expect(useSolanaWatchStore.getState().records["sol-1"]).toMatchObject({ rollbackDetected: true, rollbackSignatures: [] });
  });

  it("rejects malformed lamport text before persistence", async () => {
    const { useSolanaWatchStore } = await import("./solana-watch");
    useSolanaWatchStore.getState().ensure("sol-1", config);
    expect(() => useSolanaWatchStore.getState().commitSync("sol-1", snapshot({ balanceLamports: "1.5" }))).toThrow(/balance/i);
  });

  it("recovers an interrupted sync to a restart-safe idle state", async () => {
    const first = await import("./solana-watch");
    first.useSolanaWatchStore.getState().ensure("sol-1", config);
    first.useSolanaWatchStore.getState().beginSync("sol-1", config);
    first.useSolanaWatchStore.getState().commitSync("sol-1", snapshot());
    first.useSolanaWatchStore.getState().beginSync("sol-1", config);

    vi.resetModules();
    const second = await import("./solana-watch");
    expect(second.useSolanaWatchStore.getState().records["sol-1"]).toMatchObject({
      status: "idle",
      error: "The previous sync was interrupted",
      snapshot: { balanceLamports: "9007199254740995" },
    });
  });
});
