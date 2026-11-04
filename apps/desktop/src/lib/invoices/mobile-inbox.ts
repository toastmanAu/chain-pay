import { InvoiceSchema, type InvoiceRecord } from "@chain-pay/shared";
import type { MobileInboxEntry } from "../../../electron/main/mobile-inbox-host";

/** Convert a durable mobile inbox entry into the existing invoice review shape. */
export function invoiceFromMobileInbox(entry: MobileInboxEntry): InvoiceRecord {
  const body = entry.extraction.body;
  const now = new Date().toISOString();
  const invoiceNumber = typeof body.invoice_number === "string"
    ? body.invoice_number.trim().slice(0, 140) : "";
  const currency = typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency)
    ? body.currency : "AUD";
  const total = typeof body.total === "number" && Number.isFinite(body.total) && body.total >= 0
    ? body.total : 0;
  const record: InvoiceRecord = {
    id: entry.invoiceId,
    createdAt: now,
    updatedAt: now,
    schema_version: "0.1.0",
    intake: {
      source: "api",
      uploaded_by: entry.sourceLabel,
      received_at: entry.receivedAt,
      raw_file: {
        sha256: entry.imageSha256,
        mime_type: entry.imageMime,
        byte_size: entry.imageBytes,
        filename: `mobile-${entry.mobileId.toLowerCase()}.${entry.imageMime === "image/png" ? "png" : "jpg"}`,
        storage_uri: entry.imageUri,
      },
    },
    invoice: {
      flow: "one-off-vendor",
      payee: { kind: "vendor", display_name: "" },
      ...(invoiceNumber ? { invoice_number: invoiceNumber } : {}),
      currency,
      total,
    },
    extraction: {
      pipeline: { stages: [{ name: "single-shot", model: "mobile-ocr", version: "1" }] },
      extracted_at: now,
      field_confidences: entry.extraction.field_confidences,
      warnings: [],
    },
    approval: { status: "in-review" },
  };
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...schemaShape } = record;
  InvoiceSchema.parse(schemaShape);
  return record;
}
