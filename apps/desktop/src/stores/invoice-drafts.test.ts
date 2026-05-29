import { beforeEach, describe, expect, it } from "vitest";
import { useInvoiceDraftsStore } from "./invoice-drafts";

describe("useInvoiceDraftsStore", () => {
  beforeEach(() => {
    useInvoiceDraftsStore.setState({ drafts: {} });
    globalThis.localStorage?.clear();
  });

  it("upsertDraft stores under invoiceId", () => {
    useInvoiceDraftsStore.getState().upsertDraft("inv_1", { invoice: { flow: "one-off-vendor", total: 50, payee: { kind: "vendor", display_name: "X" }, currency: "AUD" } } as never);
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")).toBeDefined();
  });

  it("upsertDraft merges over existing partial", () => {
    useInvoiceDraftsStore.getState().upsertDraft("inv_1", { invoice: { flow: "one-off-vendor", total: 50, payee: { kind: "vendor", display_name: "X" }, currency: "AUD" } } as never);
    useInvoiceDraftsStore.getState().upsertDraft("inv_1", { invoice: { flow: "one-off-vendor", total: 75, payee: { kind: "vendor", display_name: "X" }, currency: "AUD" } } as never);
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")?.invoice?.total).toBe(75);
  });

  it("clearDraft removes the entry", () => {
    useInvoiceDraftsStore.getState().upsertDraft("inv_1", {} as never);
    useInvoiceDraftsStore.getState().clearDraft("inv_1");
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")).toBeUndefined();
  });

  it("getDraft returns undefined for unknown id", () => {
    expect(useInvoiceDraftsStore.getState().getDraft("nope")).toBeUndefined();
  });
});
