import { describe, it, expect } from "vitest";
import {
  recentWatchBlock,
  FRESH_WALLET_WATCH_MARGIN_BLOCKS,
} from "./recent-watch-block";

describe("recentWatchBlock", () => {
  it("starts margin blocks below a tip well past the margin", () => {
    expect(recentWatchBlock(1_000_000n, 10_000n)).toBe(990_000n);
  });

  it("clamps to genesis when the tip is below the margin", () => {
    expect(recentWatchBlock(5_000n, 10_000n)).toBe(0n);
  });

  it("clamps to genesis when tip equals the margin (no underflow)", () => {
    expect(recentWatchBlock(10_000n, 10_000n)).toBe(0n);
  });

  it("uses the fresh-wallet default margin when none is given", () => {
    expect(recentWatchBlock(21_574_767n)).toBe(
      21_574_767n - FRESH_WALLET_WATCH_MARGIN_BLOCKS,
    );
  });

  it("default margin is a small, recent window (not genesis)", () => {
    // Must be far below a real testnet tip so fresh wallets sync fast.
    expect(FRESH_WALLET_WATCH_MARGIN_BLOCKS).toBeGreaterThan(0n);
    expect(FRESH_WALLET_WATCH_MARGIN_BLOCKS).toBeLessThan(100_000n);
  });
});
