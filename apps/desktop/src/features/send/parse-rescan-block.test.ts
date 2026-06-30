import { describe, it, expect } from "vitest";
import { parseRescanBlock } from "./parse-rescan-block";

describe("parseRescanBlock", () => {
  it("accepts a plain non-negative integer", () => {
    expect(parseRescanBlock("12345", null)).toEqual({ ok: true, block: 12_345n });
  });

  it("accepts 0 (genesis)", () => {
    expect(parseRescanBlock("0", null)).toEqual({ ok: true, block: 0n });
  });

  it("trims surrounding whitespace", () => {
    expect(parseRescanBlock("  42  ", null)).toEqual({ ok: true, block: 42n });
  });

  it("rejects an empty string", () => {
    const r = parseRescanBlock("   ", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/enter a block/i);
  });

  it("rejects non-digit input", () => {
    const r = parseRescanBlock("12.5", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/whole number/i);
  });

  it("rejects negatives", () => {
    expect(parseRescanBlock("-5", null).ok).toBe(false);
  });

  it("rejects a block above the known tip", () => {
    const r = parseRescanBlock("2000000", 1_000_000n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/above the current tip/i);
  });

  it("allows a block equal to the tip", () => {
    expect(parseRescanBlock("1000000", 1_000_000n)).toEqual({ ok: true, block: 1_000_000n });
  });

  it("skips the upper-bound check when tip is unknown (null)", () => {
    expect(parseRescanBlock("999999999", null)).toEqual({ ok: true, block: 999_999_999n });
  });
});
