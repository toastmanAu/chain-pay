import { describe, it, expect } from "vitest";
import type { StoredInvoiceRecord } from "@/stores/invoices";
import { canBundle } from "./bundling";

function inv(overrides: Partial<StoredInvoiceRecord> = {}): StoredInvoiceRecord {
  return {
    id: overrides.id ?? "inv_x",
    createdAt: "t", updatedAt: "t", schema_version: "0.1.0",
    intake: { source: "manual-upload", received_at: "t", raw_file: { sha256: "0".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "s://x" } },
    invoice: {
      flow: "one-off-vendor",
      payee: { kind: "vendor", display_name: "" },
      currency: "AUD",
      total: 100,
      payment_details: { ckb_address: "ckt1abc" },
    },
    extraction: { pipeline: { stages: [] }, extracted_at: "t" },
    approval: { status: "in-review" },
    extractionStatus: "extracted",
    ...overrides,
  };
}

describe("canBundle", () => {
  it("ok: two AUD one-off-vendor invoices with CKB addresses", () => {
    expect(canBundle([inv({ id: "a" }), inv({ id: "b" })])).toEqual({ ok: true });
  });

  it("fail: mixed currencies", () => {
    const r = canBundle([inv({ id: "a" }), inv({ id: "b", invoice: { ...inv().invoice, currency: "USD" } })]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/currency/i);
  });

  it("fail: extraction still running", () => {
    const r = canBundle([inv({ id: "a" }), inv({ id: "b", extractionStatus: "running" })]);
    expect(r.ok).toBe(false);
  });

  it("fail: employee-payment flow not bundle-eligible (use PayrollBatch)", () => {
    const r = canBundle([inv({ id: "a", invoice: { ...inv().invoice, flow: "employee-payment" } })]);
    expect(r.ok).toBe(false);
  });

  it("fail: missing CKB address", () => {
    const r = canBundle([inv({ id: "a", invoice: { ...inv().invoice, payment_details: {} } })]);
    expect(r.ok).toBe(false);
  });

  it("fail: fewer than 2", () => {
    expect(canBundle([inv()]).ok).toBe(false);
    expect(canBundle([]).ok).toBe(false);
  });
});
