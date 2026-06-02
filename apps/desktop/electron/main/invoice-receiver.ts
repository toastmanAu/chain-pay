import { Buffer } from "node:buffer";
import { MobileInvoicePayloadSchema, type MobileInvoicePayload } from "@chain-pay/shared";

const DEDUP_CAPACITY = 1000;
// FIFO dedup cache: insertion-ordered Map; oldest entry evicted when capacity reached.
const seenIds: Map<string, string> = new Map();

export function _resetSeenIdsForTests(): void {
  seenIds.clear();
}

function recordSeen(mobileId: string, invoiceId: string): void {
  if (seenIds.size >= DEDUP_CAPACITY) {
    const oldest = seenIds.keys().next().value as string | undefined;
    if (oldest) seenIds.delete(oldest);
  }
  seenIds.set(mobileId, invoiceId);
}

export interface ReceiveResult {
  status: "created" | "duplicate";
  invoiceId: string;
}

export async function receiveMobileInvoice(args: {
  payload: MobileInvoicePayload;
  deviceLabel: string;
  sendToRenderer: Electron.WebContents;
}): Promise<ReceiveResult> {
  const parsed = MobileInvoicePayloadSchema.safeParse(args.payload);
  if (!parsed.success) {
    throw new Error(`invalid mobile invoice payload: ${parsed.error.message}`);
  }
  const seen = seenIds.get(parsed.data.id);
  if (seen) return { status: "duplicate", invoiceId: seen };

  const imageBuffer = Buffer.concat(parsed.data.image_chunks.map((c) => Buffer.from(c, "base64")));
  const invoiceId = `inv_${parsed.data.id.toLowerCase()}`;
  recordSeen(parsed.data.id, invoiceId);

  args.sendToRenderer.send("mobile-invoice:received", {
    invoiceId,
    mobileId: parsed.data.id,
    capturedAt: parsed.data.capturedAt,
    extraction: parsed.data.extraction,
    image: { bytes: imageBuffer.toString("base64"), mime: parsed.data.image_mime },
    sourceLabel: args.deviceLabel,
  });

  return { status: "created", invoiceId };
}
