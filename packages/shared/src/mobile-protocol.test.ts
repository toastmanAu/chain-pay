import { describe, expect, it } from "vitest";
import {
  MobileInvoicePayloadSchema,
  MobilePairRequestSchema,
  HealthResponseSchema,
  CommPubkeyResponseSchema,
  IMAGE_CHUNK_BYTES,
} from "./mobile-protocol";

describe("mobile protocol schemas", () => {
  it("validates a well-formed invoice payload", () => {
    const ok = MobileInvoicePayloadSchema.safeParse({
      id: "01HXYZABCDEFGHJKMNPQRSTVWX",
      capturedAt: 1717286400000,
      extraction: { body: { invoice_number: "INV-001" }, field_confidences: {}, warnings: [] },
      image_chunks: ["AAAA"],
      image_mime: "image/jpeg",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects ids that are not ulid-shaped", () => {
    const bad = MobileInvoicePayloadSchema.safeParse({
      id: "not-a-ulid",
      capturedAt: 1,
      extraction: { body: {}, field_confidences: {}, warnings: [] },
      image_chunks: [],
      image_mime: "image/jpeg",
    });
    expect(bad.success).toBe(false);
  });

  it("validates pair request", () => {
    const ok = MobilePairRequestSchema.safeParse({
      phone_comm_pubkey: "0x" + "ab".repeat(32),
      device_label: "phill-pixel-8",
    });
    expect(ok.success).toBe(true);
  });

  it("validates health and comm-pubkey responses", () => {
    expect(HealthResponseSchema.safeParse({ ok: true, app: "chainpay", version: "0.4.0" }).success).toBe(true);
    expect(CommPubkeyResponseSchema.safeParse({ comm_pubkey: "0x" + "cd".repeat(32) }).success).toBe(true);
  });

  it("exposes the chunk size constant matching desktop", () => {
    expect(IMAGE_CHUNK_BYTES).toBe(256 * 1024);
  });

  it("rejects malformed base64 in image_chunks", () => {
    const bad = MobileInvoicePayloadSchema.safeParse({
      id: "01HXYZABCDEFGHJKMNPQRSTVWX",
      capturedAt: 1,
      extraction: { body: {}, field_confidences: {}, warnings: [] },
      image_chunks: ["not!base64"],
      image_mime: "image/jpeg",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects field_confidences outside [0,1]", () => {
    const bad = MobileInvoicePayloadSchema.safeParse({
      id: "01HXYZABCDEFGHJKMNPQRSTVWX",
      capturedAt: 1,
      extraction: { body: {}, field_confidences: { x: 9999 }, warnings: [] },
      image_chunks: ["AAAA"],
      image_mime: "image/jpeg",
    });
    expect(bad.success).toBe(false);
  });
});
