import { describe, expect, it } from "vitest";
import { bytesEqual, bytesHex } from "./bytes";

describe("bytesEqual", () => {
  it("is true for identical contents", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("is false for different lengths", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("is false for a single differing byte", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it("is true for two empty arrays", () => {
    expect(bytesEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});

describe("bytesHex", () => {
  it("pads each byte to two hex digits without a 0x prefix", () => {
    expect(bytesHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });

  it("returns an empty string for empty input", () => {
    expect(bytesHex(new Uint8Array())).toBe("");
  });
});
