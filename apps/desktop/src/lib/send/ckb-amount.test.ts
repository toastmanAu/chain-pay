// apps/desktop/src/lib/send/ckb-amount.test.ts
import { describe, it, expect } from "vitest";
import { ckbStringToShannons, shannonsToCkbString } from "./ckb-amount";

describe("ckbStringToShannons", () => {
  it('parses "70" → 7_000_000_000n', () => {
    expect(ckbStringToShannons("70")).toBe(7_000_000_000n);
  });

  it('parses "70.5" → 7_050_000_000n', () => {
    expect(ckbStringToShannons("70.5")).toBe(7_050_000_000n);
  });

  it('parses "0.00000001" → 1n (minimum shannon)', () => {
    expect(ckbStringToShannons("0.00000001")).toBe(1n);
  });

  it('returns null for ""', () => {
    expect(ckbStringToShannons("")).toBeNull();
  });

  it('returns null for "abc"', () => {
    expect(ckbStringToShannons("abc")).toBeNull();
  });

  it('returns null for "-5" (negative)', () => {
    expect(ckbStringToShannons("-5")).toBeNull();
  });

  it('returns null for "1.123456789" (9 fractional digits > 8)', () => {
    expect(ckbStringToShannons("1.123456789")).toBeNull();
  });

  it('parses "  70  " (whitespace) → 7_000_000_000n', () => {
    expect(ckbStringToShannons("  70  ")).toBe(7_000_000_000n);
  });

  it('parses "0" → 0n', () => {
    expect(ckbStringToShannons("0")).toBe(0n);
  });

  it('parses "1.12345678" (exactly 8 frac digits) → 112_345_678n', () => {
    expect(ckbStringToShannons("1.12345678")).toBe(112_345_678n);
  });

  it('parses "100.00000000" (trailing zeros in frac) → 10_000_000_000n', () => {
    expect(ckbStringToShannons("100.00000000")).toBe(10_000_000_000n);
  });
});

describe("shannonsToCkbString", () => {
  it("7_000_000_000n → \"70\"", () => {
    expect(shannonsToCkbString(7_000_000_000n)).toBe("70");
  });

  it("7_050_000_000n → \"70.5\"", () => {
    expect(shannonsToCkbString(7_050_000_000n)).toBe("70.5");
  });

  it("1n → \"0.00000001\"", () => {
    expect(shannonsToCkbString(1n)).toBe("0.00000001");
  });

  it("0n → \"0\"", () => {
    expect(shannonsToCkbString(0n)).toBe("0");
  });

  it("large value beyond Number.MAX_SAFE_INTEGER round-trips exactly", () => {
    // 100_000_000 CKB = 100_000_000_00_000_000 shannons (beyond Number.MAX_SAFE_INTEGER ~9e15)
    const shannons = 100_000_000_00_000_000n;
    expect(shannonsToCkbString(shannons)).toBe("100000000");
  });
});

describe("round-trip", () => {
  it('"70" normalizes correctly', () => {
    expect(shannonsToCkbString(ckbStringToShannons("70")!)).toBe("70");
  });

  it('"70.5" normalizes correctly', () => {
    expect(shannonsToCkbString(ckbStringToShannons("70.5")!)).toBe("70.5");
  });

  it('"0.00000001" normalizes correctly', () => {
    expect(shannonsToCkbString(ckbStringToShannons("0.00000001")!)).toBe("0.00000001");
  });

  it('"100.00000000" normalizes to "100" (trailing zeros stripped)', () => {
    expect(shannonsToCkbString(ckbStringToShannons("100.00000000")!)).toBe("100");
  });
});
