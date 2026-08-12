import { describe, expect, it } from "vitest";
import { ckbToShannons, toCkbInputValue } from "./units";
import { formatCkb } from "@/lib/format/ckb";

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

describe("toCkbInputValue", () => {
  it("round-trips through ckbToShannons — including amounts at and above the", () => {
    // 1000 CKB thousands-separator boundary that broke fillAmountsFromFx when
    // it was wired to formatCkb instead of this function (see PayPanel.tsx
    // regression, fixed in feat/consolidation-refactor).
    const values = [
      1n, // 1 shannon — smallest sub-unit
      99_999_999n, // just under 1 CKB
      100_000_000n, // exactly 1 CKB
      99_999_999_999n, // just under 1000 CKB
      100_000_000_000_000n, // exactly 1,000,000 CKB
      123_450_000_000n, // 1234.5 CKB
      1_000_000n * 100_000_000n, // 1,000,000 CKB, round
    ];
    for (const shannons of values) {
      expect(ckbToShannons(toCkbInputValue(shannons))).toBe(shannons);
    }
  });

  it("never emits thousands separators, unlike formatCkb", () => {
    expect(toCkbInputValue(100_000_000_000n)).toBe("1000");
    expect(toCkbInputValue(123_450_000_000n)).toBe("1234.5");
  });
});

describe("formatCkb and ckbToShannons are not interchangeable", () => {
  it("ckbToShannons rejects formatCkb's thousands-separated output at >= 1000 CKB", () => {
    // Pins WHY shannonsToCkbDisplay/toCkbInputValue must stay a distinct
    // function from formatCkb: formatCkb's separators fail ckbToShannons's
    // /^\d+(\.\d+)?$/ regex, so feeding a form field with formatCkb's output
    // silently drops the row downstream (buildBatchLinesFromRecipients skips
    // any row whose amount fails to parse).
    const oneThousandCkbInShannons = 100_000_000_000n;
    expect(formatCkb(oneThousandCkbInShannons)).toBe("1,000");
    expect(ckbToShannons(formatCkb(oneThousandCkbInShannons))).toBeNull();
    // The safe counterpart round-trips fine.
    expect(ckbToShannons(toCkbInputValue(oneThousandCkbInShannons))).toBe(oneThousandCkbInShannons);
  });
});
