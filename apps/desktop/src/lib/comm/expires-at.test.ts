import { describe, it, expect } from "vitest";
import { isExpired } from "./expires-at";

describe("isExpired", () => {
  it("returns true when expiresAt (epoch s) is before now (epoch ms)", () => {
    const now = 1_700_000_000_000;
    const past = Math.floor(now / 1000) - 60;
    expect(isExpired(past, now)).toBe(true);
  });

  it("returns false when expiresAt is in the future", () => {
    const now = 1_700_000_000_000;
    const future = Math.floor(now / 1000) + 60;
    expect(isExpired(future, now)).toBe(false);
  });

  it("returns false when expiresAt is undefined or zero", () => {
    expect(isExpired(undefined)).toBe(false);
    expect(isExpired(0)).toBe(false);
  });
});
