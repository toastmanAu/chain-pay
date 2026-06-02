import { z } from "zod";

export const IMAGE_CHUNK_BYTES = 256 * 1024;

const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
// Lowercase hex on the wire; callers must normalize before validation.
const HexBytes32 = z.string().regex(/^0x[a-f0-9]{64}$/);
const Base64 = z.string().regex(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/,
);

export const MobileInvoicePayloadSchema = z.object({
  id: Ulid,
  capturedAt: z.number().int().nonnegative(),
  extraction: z.object({
    body: z.record(z.unknown()),
    field_confidences: z.record(z.number().min(0).max(1)),
    warnings: z.array(z.unknown()),
  }),
  image_chunks: z.array(Base64),
  image_mime: z.enum(["image/jpeg", "image/png"]),
});
export type MobileInvoicePayload = z.infer<typeof MobileInvoicePayloadSchema>;

export const MobileInvoiceResponseSchema = z.object({
  invoiceId: z.string(),
});
export type MobileInvoiceResponse = z.infer<typeof MobileInvoiceResponseSchema>;

export const MobilePairRequestSchema = z.object({
  phone_comm_pubkey: HexBytes32,
  device_label: z.string().min(1).max(64),
});
export type MobilePairRequest = z.infer<typeof MobilePairRequestSchema>;

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  app: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const CommPubkeyResponseSchema = z.object({
  comm_pubkey: HexBytes32,
});
export type CommPubkeyResponse = z.infer<typeof CommPubkeyResponseSchema>;

export const MOBILE_ROUTES = {
  health: "/health",
  pair: "/pair",
  commPubkey: "/comm-pubkey",
  invoices: "/invoices",
} as const;
