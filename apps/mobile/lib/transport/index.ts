import type { MobileInvoicePayload } from "@chain-pay/shared";
import type { PairingPayload } from "@/stores/pairing";
import type { QueueItem, QueueStatus } from "@/stores/sync-queue";
import { sendInvoiceViaIp } from "./ip-client";

// v1: always "ip". The signature accepts a status so v2 can introduce "cemp-pq"
// without changing call sites.
export function selectTransportFor(_status: QueueStatus): "ip" {
  return "ip";
}

export type DrainOutcome =
  | { kind: "synced"; invoiceId: string }
  | { kind: "rejected"; error: string }
  | { kind: "unauthorized" }
  | { kind: "tls-mismatch" }
  | { kind: "retry"; error: string };

export async function runDrainOnce(args: {
  item: QueueItem;
  pairing: PairingPayload;
  buildPayload: (item: QueueItem) => Promise<MobileInvoicePayload>;
}): Promise<DrainOutcome> {
  const payload = await args.buildPayload(args.item);
  const result = await sendInvoiceViaIp({ pairing: args.pairing, payload });
  if (result.ok) return { kind: "synced", invoiceId: result.invoiceId };
  if (result.kind === "unauthorized") return { kind: "unauthorized" };
  if (result.kind === "tls-mismatch") return { kind: "tls-mismatch" };
  if (result.kind === "client") return { kind: "rejected", error: result.detail ?? "client error" };
  return { kind: "retry", error: result.detail ?? result.kind };
}
