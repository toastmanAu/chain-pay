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
});
