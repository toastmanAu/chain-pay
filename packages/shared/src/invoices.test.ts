import { describe, expect, it, expectTypeOf } from "vitest";
import type { Invoice, InvoiceRecord } from "./invoices";

describe("InvoiceRecord", () => {
  it("extends Invoice with id, createdAt, updatedAt", () => {
    expectTypeOf<InvoiceRecord>().toHaveProperty("id").toEqualTypeOf<string>();
    expectTypeOf<InvoiceRecord>().toHaveProperty("createdAt").toEqualTypeOf<string>();
    expectTypeOf<InvoiceRecord>().toHaveProperty("updatedAt").toEqualTypeOf<string>();
    expectTypeOf<InvoiceRecord>().toHaveProperty("schema_version").toEqualTypeOf<"0.1.0">();
  });

  it("Invoice type is structurally compatible with what z.infer returns", () => {
    const sample: Invoice = {
      schema_version: "0.1.0",
      intake: {
        source: "manual-upload",
        received_at: "2026-05-27T00:00:00Z",
        raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" },
      },
      invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "X" }, currency: "AUD", total: 1 },
      extraction: { pipeline: { stages: [] }, extracted_at: "2026-05-27T00:00:00Z" },
      approval: { status: "draft" },
    };
    expect(sample.schema_version).toBe("0.1.0");
  });
});
