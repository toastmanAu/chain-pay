import { beforeEach, describe, expect, it } from "vitest";
import type { VendorProfile } from "@chain-pay/shared";
import { useVendorsStore } from "./vendors";

function v(overrides: Partial<VendorProfile> = {}): VendorProfile {
  const now = new Date().toISOString();
  return {
    id: "vendor_1",
    displayName: "Acme Pty",
    preferredChain: "ckb:testnet",
    active: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("useVendorsStore", () => {
  beforeEach(() => {
    useVendorsStore.setState({ vendors: [] });
    globalThis.localStorage?.clear();
  });

  it("addVendor appends", () => {
    useVendorsStore.getState().addVendor(v());
    expect(useVendorsStore.getState().vendors).toHaveLength(1);
  });

  it("findById returns the matching vendor", () => {
    useVendorsStore.getState().addVendor(v({ id: "vendor_42" }));
    expect(useVendorsStore.getState().findById("vendor_42")?.displayName).toBe("Acme Pty");
  });

  it("updateVendor patches but preserves id + createdAt", () => {
    const created = v({ id: "vendor_42", createdAt: "2026-01-01T00:00:00Z" });
    useVendorsStore.getState().addVendor(created);
    useVendorsStore.getState().updateVendor("vendor_42", { displayName: "Acme Pty Ltd" });
    const after = useVendorsStore.getState().findById("vendor_42")!;
    expect(after.displayName).toBe("Acme Pty Ltd");
    expect(after.id).toBe("vendor_42");
    expect(after.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(after.updatedAt).not.toBe("2026-01-01T00:00:00Z");
  });

  it("removeVendor drops it from the list", () => {
    useVendorsStore.getState().addVendor(v({ id: "vendor_1" }));
    useVendorsStore.getState().addVendor(v({ id: "vendor_2", displayName: "Other" }));
    useVendorsStore.getState().removeVendor("vendor_1");
    expect(useVendorsStore.getState().vendors).toHaveLength(1);
    expect(useVendorsStore.getState().vendors[0]?.id).toBe("vendor_2");
  });

  it("findByDisplayNameAndTaxId matches exact name+taxId", () => {
    useVendorsStore.getState().addVendor(v({ id: "v1", displayName: "Acme Pty", taxId: "12345" }));
    useVendorsStore.getState().addVendor(v({ id: "v2", displayName: "Acme Pty", taxId: "67890" }));
    expect(useVendorsStore.getState().findByDisplayNameAndTaxId("Acme Pty", "12345")?.id).toBe("v1");
    expect(useVendorsStore.getState().findByDisplayNameAndTaxId("Acme Pty", "99999")).toBeUndefined();
  });

  it("findByDisplayNameAndTaxId matches name when taxId omitted on both", () => {
    useVendorsStore.getState().addVendor(v({ id: "v1", displayName: "Sole Trader" }));
    expect(useVendorsStore.getState().findByDisplayNameAndTaxId("Sole Trader", undefined)?.id).toBe("v1");
  });
});
