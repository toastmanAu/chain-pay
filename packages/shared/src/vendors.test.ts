import { describe, expect, it, expectTypeOf } from "vitest";
import type { VendorProfile } from "./vendors";

describe("VendorProfile", () => {
  it("has required fields", () => {
    expectTypeOf<VendorProfile>().toHaveProperty("id").toEqualTypeOf<string>();
    expectTypeOf<VendorProfile>().toHaveProperty("displayName").toEqualTypeOf<string>();
    expectTypeOf<VendorProfile>().toHaveProperty("active").toEqualTypeOf<boolean>();
  });

  it("constructs with minimal required fields", () => {
    const v: VendorProfile = {
      id: "vendor_1",
      displayName: "Acme Pty",
      preferredChain: "ckb:testnet",
      active: true,
      createdAt: "2026-05-27T00:00:00Z",
      updatedAt: "2026-05-27T00:00:00Z",
    };
    expect(v.displayName).toBe("Acme Pty");
  });
});
