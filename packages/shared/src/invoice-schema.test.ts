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
