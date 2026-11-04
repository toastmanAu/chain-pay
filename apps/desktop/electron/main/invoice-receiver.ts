import { MobileInvoicePayloadSchema, type MobileInvoicePayload } from "@chain-pay/shared";
import { persistMobileInvoice } from "./mobile-inbox-host";

export interface ReceiveResult {
  status: "created" | "duplicate";
  invoiceId: string;
}

/** Only acknowledge the phone after the image and intake metadata are on disk. */
export async function receiveMobileInvoice(args: {
  payload: MobileInvoicePayload;
  deviceLabel: string;
  sendToRenderer: Electron.WebContents;
}): Promise<ReceiveResult> {
  const parsed = MobileInvoicePayloadSchema.safeParse(args.payload);
  if (!parsed.success) {
    throw new Error(`invalid mobile invoice payload: ${parsed.error.message}`);
  }
  const stored = await persistMobileInvoice(parsed.data, args.deviceLabel);
  args.sendToRenderer.send("mobile-invoice:received", { invoiceId: stored.entry.invoiceId });
  return { status: stored.status, invoiceId: stored.entry.invoiceId };
}
