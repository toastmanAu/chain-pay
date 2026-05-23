import { describe, expect, it } from "vitest";
import type { FiatAmount, FxQuote } from "@chain-pay/shared";
import { fiatToCkbShannons, formatFxQuote, parseRate } from "./coingecko";

describe("parseRate", () => {
  it("parses a sub-1 rate with trailing decimals", () => {
    expect(parseRate("0.0042")).toEqual({ intRate: 42n, rateDecimals: 4 });
  });

  it("parses a single-decimal rate", () => {
    expect(parseRate("1.5")).toEqual({ intRate: 15n, rateDecimals: 1 });
  });

  it("parses an integer rate", () => {
    expect(parseRate("100")).toEqual({ intRate: 100n, rateDecimals: 0 });
  });

  it("parses a multi-decimal precise rate", () => {
    expect(parseRate("0.00420718")).toEqual({ intRate: 420718n, rateDecimals: 8 });
  });

  it("rejects malformed strings", () => {
    expect(() => parseRate("abc")).toThrow(/malformed/);
    expect(() => parseRate("1.2.3")).toThrow(/malformed/);
    expect(() => parseRate("")).toThrow(/malformed/);
    expect(() => parseRate("-1.5")).toThrow(/malformed/);
  });
});

describe("fiatToCkbShannons", () => {
  const usdAt0_0042: FxQuote = {
    base: "CKB",
    quote: "USD",
    rate: "0.0042",
    source: "test",
    takenAt: 1,
  };

  it("converts $5000.00 at 0.0042 USD/CKB to the expected shannon amount", () => {
    // 5000 / 0.0042 = 1,190,476.19...
    // ×10^8 → 119,047,619,047,619 shannons (integer floor)
    const fiat: FiatAmount = { currency: "USD", minor: 500000n };
    expect(fiatToCkbShannons(fiat, usdAt0_0042)).toBe(119047619047619n);
  });

  it("converts $100.00 at 0.0042 to the correct shannons", () => {
    // 100 / 0.0042 = 23,809.523... CKB → 2,380,952,380,952 shannons
    const fiat: FiatAmount = { currency: "USD", minor: 10000n };
    expect(fiatToCkbShannons(fiat, usdAt0_0042)).toBe(2380952380952n);
  });

  it("converts $1.00 at $1/CKB to 1 CKB (100_000_000 shannons)", () => {
    const fiat: FiatAmount = { currency: "USD", minor: 100n };
    const usdAt1: FxQuote = {
      base: "CKB",
      quote: "USD",
      rate: "1",
      source: "test",
      takenAt: 1,
    };
    expect(fiatToCkbShannons(fiat, usdAt1)).toBe(100_000_000n);
  });

  it("handles high-precision rates without intermediate float drift", () => {
    // Rate from a real CoinGecko response.
    const usdAtPrecise: FxQuote = {
      base: "CKB",
      quote: "USD",
      rate: "0.00420718",
      source: "test",
      takenAt: 1,
    };
    const fiat: FiatAmount = { currency: "USD", minor: 500000n };
    // 5000 ÷ 0.00420718 = 1,188,444.516… CKB (integer floor at shannon precision)
    // ×10^8 = 118,844,451,627,931 shannons
    //   numerator   = 500000 × 10^8 × 10^8 = 5×10^21
    //   denominator = 420718 × 10^2 = 42,071,800
    //   5×10^21 ÷ 42,071,800 = 118,844,451,627,931 (verified by bigint)
    const got = fiatToCkbShannons(fiat, usdAtPrecise);
    expect(got).toBe(118844451627931n);
  });

  it("throws when currencies don't match", () => {
    const fiat: FiatAmount = { currency: "EUR", minor: 500000n };
    expect(() => fiatToCkbShannons(fiat, usdAt0_0042)).toThrow(/currency mismatch/);
  });

  it("throws on zero rate", () => {
    const zero: FxQuote = {
      base: "CKB",
      quote: "USD",
      rate: "0",
      source: "test",
      takenAt: 1,
    };
    const fiat: FiatAmount = { currency: "USD", minor: 100n };
    expect(() => fiatToCkbShannons(fiat, zero)).toThrow(/zero/);
  });

  it("throws when the quote is not CKB-based", () => {
    const reversed: FxQuote = {
      base: "USD",
      quote: "CKB",
      rate: "238",
      source: "test",
      takenAt: 1,
    };
    const fiat: FiatAmount = { currency: "USD", minor: 100n };
    expect(() => fiatToCkbShannons(fiat, reversed)).toThrow(/CKB-based/);
  });

  it("supports JPY-style currencies via opts.fiatMinorDecimals=0", () => {
    // ¥10,000 at 1 CKB = ¥0.5 → 20,000 CKB → 20,000 × 10^8 shannons.
    const fiat: FiatAmount = { currency: "JPY", minor: 10000n };
    const jpyAt0_5: FxQuote = {
      base: "CKB",
      quote: "JPY",
      rate: "0.5",
      source: "test",
      takenAt: 1,
    };
    const got = fiatToCkbShannons(fiat, jpyAt0_5, { fiatMinorDecimals: 0 });
    expect(got).toBe(2_000_000_000_000n);
  });
});

describe("formatFxQuote", () => {
  it("formats CKB/USD nicely", () => {
    const q: FxQuote = {
      base: "CKB",
      quote: "USD",
      rate: "0.0042",
      source: "coingecko",
      takenAt: 0,
    };
    expect(formatFxQuote(q)).toBe("1 CKB = 0.0042 USD");
  });
});
