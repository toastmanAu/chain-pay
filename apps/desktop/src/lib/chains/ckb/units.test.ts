import { describe, expect, it } from "vitest";
import { ckbToShannons } from "./units";

describe("ckbToShannons", () => {
  it("converts whole CKB", () => {
    expect(ckbToShannons("1")).toBe(100_000_000n);
  });

  it("converts fractional CKB, padding to 8 decimals", () => {
    expect(ckbToShannons("1.5")).toBe(150_000_000n);
    expect(ckbToShannons("0.00000001")).toBe(1n);
  });

  it("truncates beyond 8 decimals rather than rounding", () => {
    expect(ckbToShannons("1.123456789")).toBe(112_345_678n);
  });

  it("trims surrounding whitespace", () => {
    expect(ckbToShannons("  1  ")).toBe(100_000_000n);
  });

  it("returns null for zero, negatives, and non-numeric input", () => {
    expect(ckbToShannons("0")).toBeNull();
    expect(ckbToShannons("-1")).toBeNull();
    expect(ckbToShannons("abc")).toBeNull();
    expect(ckbToShannons("")).toBeNull();
  });
});
