import type { StoredInvoiceRecord } from "@/stores/invoices";

export type CanBundleResult = { ok: true } | { ok: false; reason: string };

const BUNDLE_FLOWS = new Set(["one-off-vendor", "recurring-vendor"]);

export function canBundle(invoices: StoredInvoiceRecord[]): CanBundleResult {
  if (invoices.length < 2) {
    return { ok: false, reason: "Select at least two invoices to bundle." };
  }

  for (const i of invoices) {
    if (i.extractionStatus !== "extracted") {
      return { ok: false, reason: "All selected invoices must finish extracting first." };
    }
    if (i.approval.status !== "draft" && i.approval.status !== "in-review") {
      return { ok: false, reason: "Only draft or in-review invoices can be bundled." };
    }
    if (!BUNDLE_FLOWS.has(i.invoice.flow)) {
      return { ok: false, reason: "Bundling supports one-off-vendor and recurring-vendor only." };
    }
    if (!i.invoice.payment_details?.ckb_address) {
      return { ok: false, reason: "Each invoice needs a CKB address (EVM bundling lands in Phase 3)." };
    }
  }

  const currencies = new Set(invoices.map((i) => i.invoice.currency));
  if (currencies.size > 1) {
    return { ok: false, reason: `Bundling needs one currency. Found ${[...currencies].join(", ")}.` };
  }

  return { ok: true };
}
