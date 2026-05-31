import { describe, expect, it } from "vitest";
import type { InvoiceRecord, Treasury } from "@chain-pay/shared";
import { isPayrollBatch, isVendorBatch } from "@chain-pay/shared";
import type { StoredInvoiceRecord } from "@/stores/invoices";
import { routeInvoiceToBatch, routeInvoicesToBatch } from "./route-to-batch";

function invoiceFixture(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  const now = new Date().toISOString();
  const base: InvoiceRecord = {
    id: "inv_1",
    createdAt: now,
    updatedAt: now,
    schema_version: "0.1.0",
    intake: {
      source: "manual-upload",
      received_at: now,
      raw_file: {
        sha256: "a".repeat(64),
        mime_type: "application/pdf",
        byte_size: 1,
        filename: "x.pdf",
        storage_uri: "file:///x",
      },
    },
    invoice: {
      flow: "one-off-vendor",
      payee: { kind: "vendor", id: "vendor_1", display_name: "Acme" },
      currency: "AUD",
      total: 1247.5,
    },
    extraction: { pipeline: { stages: [] }, extracted_at: now },
    approval: { status: "in-review" },
  };
  return {
    ...base,
    ...overrides,
    invoice: { ...base.invoice, ...(overrides.invoice ?? {}) },
  };
}

function treasuryFixture(): Treasury {
  return {
    id: "tr_1",
    label: "Test Treasury",
    createdAt: "2026-05-27T00:00:00Z",
    updatedAt: "2026-05-27T00:00:00Z",
    multisig: {
      chain: "ckb:testnet",
      s: 0,
      r: 0,
      m: 2,
      n: 3,
      pubkeyHashes: [
        "0x44fa9ab6fdacd4827f5ec169c31e9e7ef46ba908",
        "0x0463eacbe31265f36f1ac23d26b28755ed34a767",
        "0xe4d15db3846f6ecd38b760298419450b21391e73",
      ],
      address: "ckt1qtestnet",
    },
  };
}

describe("routeInvoiceToBatch", () => {
  it("one-off-vendor invoice → VendorPaymentBatch", () => {
    const inv = invoiceFixture();
    const batch = routeInvoiceToBatch(inv, treasuryFixture());
    expect(isVendorBatch(batch)).toBe(true);
    if (!isVendorBatch(batch)) throw new Error("type narrowing failed");
    expect(batch.invoiceIds[0]).toBe("inv_1");
    expect(batch.vendorId).toBe("vendor_1");
    expect(batch.line.fiat.currency).toBe("AUD");
    expect(batch.state).toBe("draft");
  });

  it("employee-payment invoice → PayrollBatch with 1 line", () => {
    const inv = invoiceFixture({
      invoice: {
        flow: "employee-payment",
        payee: { kind: "employee", id: "payee_42", display_name: "Sarah Chen" },
        currency: "AUD",
        total: 1247.5,
      },
    });
    const batch = routeInvoiceToBatch(inv, treasuryFixture());
    expect(isPayrollBatch(batch)).toBe(true);
    if (!isPayrollBatch(batch)) throw new Error("type narrowing failed");
    expect(batch.lines).toHaveLength(1);
    expect(batch.lines[0]?.payeeId).toBe("payee_42");
  });

  it("throws on unsupported flow (recurring-vendor)", () => {
    const inv = invoiceFixture({
      invoice: {
        flow: "recurring-vendor",
        payee: { kind: "vendor", id: "vendor_1", display_name: "Acme" },
        currency: "AUD",
        total: 1247.5,
      },
    });
    expect(() => routeInvoiceToBatch(inv, treasuryFixture())).toThrow(/unsupported flow/i);
  });

  it("throws on unsupported flow (unknown)", () => {
    const inv = invoiceFixture({
      invoice: {
        flow: "unknown",
        payee: { kind: "unknown", id: "vendor_1", display_name: "Acme" },
        currency: "AUD",
        total: 1247.5,
      },
    });
    expect(() => routeInvoiceToBatch(inv, treasuryFixture())).toThrow(/unsupported flow/i);
  });

  it("throws on employee-payment without a payee id", () => {
    const inv = invoiceFixture({
      invoice: {
        flow: "employee-payment",
        payee: { kind: "employee", display_name: "Unknown" },
        currency: "AUD",
        total: 1247.5,
      },
    });
    expect(() => routeInvoiceToBatch(inv, treasuryFixture())).toThrow(/payee id required/i);
  });

  it("throws on one-off-vendor without a payee id", () => {
    const inv = invoiceFixture({
      invoice: {
        flow: "one-off-vendor",
        payee: { kind: "vendor", display_name: "New Vendor" },
        currency: "AUD",
        total: 1247.5,
      },
    });
    expect(() => routeInvoiceToBatch(inv, treasuryFixture())).toThrow(/payee id required/i);
  });
});

// ---------------------------------------------------------------------------
// Plural builder
// ---------------------------------------------------------------------------

function storedInvoiceFixture(
  id: string,
  overrides: Partial<InvoiceRecord["invoice"]> = {},
): StoredInvoiceRecord {
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    schema_version: "0.1.0",
    intake: {
      source: "manual-upload",
      received_at: now,
      raw_file: {
        sha256: "a".repeat(64),
        mime_type: "application/pdf",
        byte_size: 1,
        filename: `${id}.pdf`,
        storage_uri: `file:///${id}`,
      },
    },
    invoice: {
      flow: "one-off-vendor",
      payee: { kind: "vendor", id: `vendor_${id}`, display_name: `Vendor ${id}` },
      currency: "AUD",
      total: 100,
      payment_details: { ckb_address: `ckt1${id}` },
      ...overrides,
    },
    extraction: { pipeline: { stages: [] }, extracted_at: now },
    approval: { status: "in-review" },
    extractionStatus: "extracted",
  };
}

describe("routeInvoicesToBatch", () => {
  it("produces one batch with N invoiceIds preserving input order", () => {
    const invA = storedInvoiceFixture("a");
    const invB = storedInvoiceFixture("b");
    const batch = routeInvoicesToBatch([invA, invB], treasuryFixture());
    expect(isVendorBatch(batch)).toBe(true);
    expect(batch.invoiceIds).toEqual(["a", "b"]);
    expect(batch.kind).toBe("vendor");
    expect(batch.state).toBe("draft");
    expect(batch.treasuryId).toBe("tr_1");
  });

  it("sums invoice totals into the consolidated line", () => {
    const invA = storedInvoiceFixture("a", { total: 200, currency: "AUD" });
    const invB = storedInvoiceFixture("b", { total: 350, currency: "AUD" });
    const batch = routeInvoicesToBatch([invA, invB], treasuryFixture());
    // 200 + 350 = 550 → 55000 minor
    expect(batch.line.fiat.minor).toBe(55000n);
    expect(batch.line.fiat.currency).toBe("AUD");
  });

  it("uses the first invoice's vendorId on batch.vendorId", () => {
    const invA = storedInvoiceFixture("a");
    const invB = storedInvoiceFixture("b");
    const batch = routeInvoicesToBatch([invA, invB], treasuryFixture());
    // first invoice has vendor_a
    expect(batch.vendorId).toBe("vendor_a");
    expect(batch.line.vendorId).toBe("vendor_a");
  });

  it("throws when any invoice lacks a payee id", () => {
    const invA = storedInvoiceFixture("a");
    const invB = storedInvoiceFixture("b", {
      payee: { kind: "vendor", display_name: "No ID Vendor" },
    });
    expect(() => routeInvoicesToBatch([invA, invB], treasuryFixture())).toThrow(/payee id required/i);
  });

  it("throws when the invoices array is empty", () => {
    expect(() => routeInvoicesToBatch([], treasuryFixture())).toThrow(/at least one invoice/i);
  });
});
