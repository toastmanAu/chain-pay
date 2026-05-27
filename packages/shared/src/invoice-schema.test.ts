import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvoiceSchema } from "./invoice-schema";

describe("InvoiceSchema", () => {
  it("accepts a minimal valid invoice", () => {
    const minimal = {
      schema_version: "0.1.0",
      intake: {
        source: "manual-upload",
        received_at: "2026-05-27T00:00:00Z",
        raw_file: {
          sha256: "a".repeat(64),
          mime_type: "application/pdf",
          byte_size: 12345,
          filename: "test.pdf",
          storage_uri: "file:///tmp/test.pdf",
        },
      },
      invoice: {
        flow: "one-off-vendor",
        payee: { kind: "vendor", display_name: "Acme Pty" },
        currency: "AUD",
        total: 1247.5,
      },
      extraction: {
        pipeline: { stages: [] },
        extracted_at: "2026-05-27T00:00:00Z",
      },
      approval: { status: "draft" },
    };
    const result = InvoiceSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects wrong schema_version", () => {
    const bad = {
      schema_version: "0.2.0",
      intake: {
        source: "manual-upload",
        received_at: "2026-05-27T00:00:00Z",
        raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" },
      },
      invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "X" }, currency: "AUD", total: 1 },
      extraction: { pipeline: { stages: [] }, extracted_at: "2026-05-27T00:00:00Z" },
      approval: { status: "draft" },
    };
    expect(InvoiceSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects bad currency code", () => {
    const bad = {
      schema_version: "0.1.0",
      intake: { source: "manual-upload", received_at: "2026-05-27T00:00:00Z", raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
      invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "X" }, currency: "aud", total: 1 },
      extraction: { pipeline: { stages: [] }, extracted_at: "2026-05-27T00:00:00Z" },
      approval: { status: "draft" },
    };
    expect(InvoiceSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects bad sha256 (not 64 hex chars)", () => {
    const bad = {
      schema_version: "0.1.0",
      intake: { source: "manual-upload", received_at: "2026-05-27T00:00:00Z", raw_file: { sha256: "abc", mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
      invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "X" }, currency: "AUD", total: 1 },
      extraction: { pipeline: { stages: [] }, extracted_at: "2026-05-27T00:00:00Z" },
      approval: { status: "draft" },
    };
    expect(InvoiceSchema.safeParse(bad).success).toBe(false);
  });
});

describe("InvoiceSchema completeness vs vault file", () => {
  it("parses a maximal invoice covering every field from the vault JSON schema", () => {
    // Sanity: vault file must be present and pin schema_version
    const vaultSchemaPath = join(
      homedir(),
      "Documents/loacal-vault/Projects/ChainPay/schemas/invoice-extraction-v0.schema.json",
    );
    const vaultSchema = JSON.parse(readFileSync(vaultSchemaPath, "utf8")) as { properties: { schema_version: { const: string } } };
    expect(vaultSchema.properties.schema_version.const).toBe("0.1.0");

    // Maximal invoice — every optional field populated
    const maximal = {
      schema_version: "0.1.0",
      org_id: "acme-pty",
      intake: {
        source: "manual-upload",
        uploaded_by: "user_42",
        received_at: "2026-05-27T03:14:15Z",
        sender_identity: null,
        raw_file: {
          sha256: "f".repeat(64),
          mime_type: "application/pdf",
          byte_size: 247000,
          filename: "acme-may-2025.pdf",
          storage_uri: "file:///home/phill/.local/share/chain-pay/invoice-pdfs/ff/ffff…ffff.pdf",
          page_count: 2,
        },
      },
      invoice: {
        flow: "one-off-vendor",
        payee: {
          kind: "vendor",
          id: "vendor_acme",
          display_name: "Acme Pty Ltd",
          tax_id: "12 345 678 901",
          tax_id_country: "AU",
        },
        invoice_number: "INV-2025-001",
        issue_date: "2026-05-15",
        due_date: "2026-05-30",
        currency: "AUD",
        subtotal: 1133.18,
        tax_total: 113.32,
        tax_label: "GST",
        total: 1247.5,
        line_items: [
          {
            description: "Consulting — May",
            quantity: 1,
            unit_price: 1133.18,
            line_total: 1133.18,
            tax_amount: 113.32,
            account_hint: "expense:consulting",
          },
        ],
        payment_details: {
          method_hint: "bank-transfer",
          bank: { bsb: "012-345", account_number: "12345678", iban: null, swift: null, account_name: "Acme Pty Ltd" },
          ckb_address: null,
          evm_address: null,
          reference: "INV-2025-001",
        },
        notes: "Pay within 14 days net",
      },
      extraction: {
        pipeline: {
          stages: [
            { name: "layout-ocr", model: "PaddleOCR-VL", version: "1.0", elapsed_ms: 850 },
            { name: "schema-extraction", model: "NuExtract-2.0-8B", version: "2.0", elapsed_ms: 1200 },
          ],
        },
        extracted_at: "2026-05-27T03:14:20Z",
        field_confidences: { "invoice.total": 0.99, "invoice.tax_total": 0.87 },
        warnings: [{ field: "payment_details.bsb", severity: "warn", message: "low confidence" }],
      },
      approval: {
        status: "queued-for-signing",
        reviewed_by: "user_42",
        reviewed_at: "2026-05-27T03:20:00Z",
        rejection_reason: null,
        edits_made: [
          { field: "invoice.total", before: 1247, after: 1247.5, edited_at: "2026-05-27T03:18:00Z", edited_by: "user_42" },
        ],
      },
      chainpay_link: { tx_hash: null, chain: null, frappe_doctype: null, frappe_docname: null },
    };

    const result = InvoiceSchema.safeParse(maximal);
    if (!result.success) console.error(JSON.stringify(result.error.issues, null, 2));
    expect(result.success).toBe(true);
  });

  it("rejects unknown top-level fields (strict mode)", () => {
    const withExtra = {
      schema_version: "0.1.0",
      intake: { source: "manual-upload", received_at: "2026-05-27T00:00:00Z", raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
      invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "X" }, currency: "AUD", total: 1 },
      extraction: { pipeline: { stages: [] }, extracted_at: "2026-05-27T00:00:00Z" },
      approval: { status: "draft" },
      unknown_field: "boom",
    };
    expect(InvoiceSchema.safeParse(withExtra).success).toBe(false);
  });
});
