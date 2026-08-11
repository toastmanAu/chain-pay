import { describe, expect, it } from "vitest";
import { formatThousands } from "./thousands";
import { formatCkb } from "./ckb";
import { formatBtc, formatSignedBtc } from "./btc";
import { formatSol, formatSignedSol, formatLamports } from "./sol";
import { formatEth } from "./evm";
import { chainBadge } from "./chain-badge";

describe("formatThousands", () => {
  it("groups digits in threes", () => {
    expect(formatThousands(1234567n)).toBe("1,234,567");
  });

  it("leaves short numbers alone", () => {
    expect(formatThousands(999n)).toBe("999");
  });
});

describe("formatCkb", () => {
  it("drops the fractional part when it is zero", () => {
    expect(formatCkb(100_000_000n)).toBe("1");
  });

  it("groups the whole part and trims trailing zeros", () => {
    expect(formatCkb(123_456_700_000_000n)).toBe("1,234,567");
    expect(formatCkb(150_000_000n)).toBe("1.5");
  });

  it("keeps leading fractional zeros", () => {
    expect(formatCkb(100_000_001n)).toBe("1.00000001");
  });

  it("formats zero", () => {
    expect(formatCkb(0n)).toBe("0");
  });
});

describe("formatBtc", () => {
  it("converts satoshis with 8 decimals", () => {
    expect(formatBtc("123456789")).toBe("1.23456789");
    expect(formatBtc("100000000")).toBe("1");
  });

  it("signs non-negative and negative values", () => {
    expect(formatSignedBtc("100000000")).toBe("+1");
    expect(formatSignedBtc("-100000000")).toBe("-1");
  });
});

describe("formatSol", () => {
  it("converts lamports with 9 decimals", () => {
    expect(formatSol("1500000000")).toBe("1.5");
    expect(formatSol("1000000000")).toBe("1");
  });

  it("signs values", () => {
    expect(formatSignedSol("1000000000")).toBe("+1");
    expect(formatSignedSol("-1000000000")).toBe("-1");
  });

  it("formats raw lamports with separators", () => {
    expect(formatLamports("1500000000")).toBe("1,500,000,000");
  });
});

describe("formatEth", () => {
  it("formats wei as ether", () => {
    expect(formatEth(1_000_000_000_000_000_000n)).toBe("1");
  });

  it("trims the fractional part to 6 digits", () => {
    expect(formatEth(1_234_567_890_123_456_789n)).toBe("1.234567");
  });

  it("re-strips trailing zeros produced by the 6-digit truncation", () => {
    expect(formatEth(1_150_000_234_000_000_000n)).toBe("1.15");
  });
});

describe("chainBadge", () => {
  it("labels every supported chain", () => {
    expect(chainBadge("ckb:mainnet")).toBe("CKB mainnet");
    expect(chainBadge("ckb:testnet")).toBe("CKB testnet");
    expect(chainBadge("btc:mainnet")).toBe("Bitcoin mainnet");
    expect(chainBadge("btc:testnet")).toBe("Bitcoin testnet");
    expect(chainBadge("sol:mainnet")).toBe("Solana mainnet");
    expect(chainBadge("sol:devnet")).toBe("Solana devnet");
  });

  it("labels evm chains by chain id suffix", () => {
    expect(chainBadge("evm:11155111")).toBe("EVM 11155111");
  });

  it("falls back to the raw chain string for unrecognised chains", () => {
    expect(chainBadge("unknown:foo")).toBe("unknown:foo");
  });
});
