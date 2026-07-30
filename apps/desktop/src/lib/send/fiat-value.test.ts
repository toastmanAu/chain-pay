import { describe, expect, it } from "vitest";
import { formatFiatMinor, parseFiatMajorToMinor } from "./fiat-value";

describe("fiat-value", () => {
  it.each([
    ["1", 100n],
    ["1.2", 120n],
    ["1.23", 123n],
    ["0.01", 1n],
    ["9007199254740993.99", 900719925474099399n],
  ])("parses %s exactly", (value, expected) => {
    expect(parseFiatMajorToMinor(value)).toBe(expected);
  });

  it.each(["", "-1", "1.234", "1e3", "NaN"])("rejects %s", (value) => {
    expect(parseFiatMajorToMinor(value)).toBeNull();
  });

  it("formats exact minor units", () => {
    expect(formatFiatMinor(12345n)).toBe("123.45");
    expect(formatFiatMinor(-1n)).toBe("-0.01");
  });
});
