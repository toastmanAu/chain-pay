import { describe, expect, it } from "vitest";
import { InvoiceSchema } from "@chain-pay/shared";
import type { MobileInboxEntry } from "../../../electron/main/mobile-inbox-host";
import { invoiceFromMobileInbox } from "./mobile-inbox";

const entry: MobileInboxEntry = {
  invoiceId: "inv_01hxyzabcdefghjkmnpqrstvwx",
  mobileId: "01HXYZABCDEFGHJKMNPQRSTVWX",
  capturedAt: 1717286400000,
  receivedAt: "2026-11-03T00:00:00.000Z",
  sourceLabel: "a53-smoke",
  extraction: { body: { invoice_number: "INV-001", total: 12.5, currency: "USD" }, field_confidences: {}, warnings: [] },
  imageUri: "file:///tmp/test.jpg",
  imageSha256: "a".repeat(64),
  imageBytes: 10,
  imageMime: "image/jpeg",
};

describe("mobile invoice intake mapping", () => {
  it("creates a schema-valid, visible review record with the saved image", () => {
    const record = invoiceFromMobileInbox(entry);
    expect(record.approval.status).toBe("in-review");
    expect(record.invoice).toMatchObject({ invoice_number: "INV-001", total: 12.5, currency: "USD" });
    expect(record.intake.raw_file.storage_uri).toBe(entry.imageUri);
    expect(record.intake.raw_file.mime_type).toBe("image/jpeg");
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...schemaShape } = record;
    expect(InvoiceSchema.safeParse(schemaShape).success).toBe(true);
  });

  it("does not trust invalid OCR currency or amount", () => {
    const record = invoiceFromMobileInbox({ ...entry, extraction: { ...entry.extraction, body: { currency: "usd", total: Number.POSITIVE_INFINITY } } });
    expect(record.invoice.currency).toBe("AUD");
    expect(record.invoice.total).toBe(0);
  });
});
