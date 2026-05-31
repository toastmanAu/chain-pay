import type {
  AnyBatch,
  InvoiceRecord,
  PayrollBatch,
  PayrollBatchLine,
  Treasury,
  VendorPaymentBatch,
  VendorPaymentLine,
} from "@chain-pay/shared";
import type { StoredInvoiceRecord } from "@/stores/invoices";

/**
 * Build a batch from an approved invoice. Pure — no side effects, no persistence.
 * Caller is responsible for: persisting the batch, transitioning the invoice
 * state, navigating to PayPanel. See `approve-and-queue.ts` for the orchestration.
 */
export function routeInvoiceToBatch(invoice: InvoiceRecord, treasury: Treasury): AnyBatch {
  if (invoice.invoice.flow === "employee-payment") {
    return buildPayrollBatchFromInvoice(invoice, treasury);
  }
  if (invoice.invoice.flow === "one-off-vendor") {
    return buildVendorPaymentBatch(invoice, treasury);
  }
  throw new Error(`unsupported flow for batch handoff: ${invoice.invoice.flow}`);
}

function buildPayrollBatchFromInvoice(invoice: InvoiceRecord, treasury: Treasury): PayrollBatch {
  const payeeId = invoice.invoice.payee.id;
  if (!payeeId) {
    throw new Error(`payee id required for employee-payment invoice ${invoice.id}`);
  }
  const now = new Date().toISOString();
  const totalMinor = BigInt(Math.round(invoice.invoice.total * 100));
  const line: PayrollBatchLine = {
    payeeId,
    fiat: { minor: totalMinor, currency: invoice.invoice.currency },
    crypto: { asset: "CKB", value: 0n, decimals: 8 },
    fxRate: "0",
    feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
  };
  const id = `pb_${crypto.randomUUID()}`;
  return {
    kind: "payroll",
    id,
    createdAt: now,
    updatedAt: now,
    label: invoice.invoice.invoice_number ?? `Invoice ${invoice.id}`,
    treasuryId: treasury.id,
    cycleStart: invoice.invoice.issue_date ?? now.slice(0, 10),
    cycleEnd: invoice.invoice.due_date ?? now.slice(0, 10),
    fxSnapshot: [],
    lines: [line],
    state: "draft",
  };
}

/**
 * Build a single VendorPaymentBatch from a selection of ≥1 vendor invoices.
 * Pure — no side effects, no persistence. Caller must persist the batch first,
 * then mark each invoice queued-for-signing (same safe-ordered handoff as
 * approve-and-queue.ts).
 *
 * Constraints enforced by canBundle (caller's gate):
 * - All invoices share the same currency
 * - All are one-off-vendor or recurring-vendor flow
 * - All have a CKB address
 *
 * Produces one VendorPaymentLine per invoice; ordering matches invoiceIds so
 * batch.invoiceIds[i] ↔ batch.lines[i] (load-bearing for Phase 4 journal entries).
 * batch.vendorId reflects the first invoice's vendorId for label/display purposes.
 */
export function routeInvoicesToBatch(
  invoices: StoredInvoiceRecord[],
  treasury: Treasury,
): VendorPaymentBatch {
  if (invoices.length === 0) {
    throw new Error("routeInvoicesToBatch requires at least one invoice");
  }

  const now = new Date().toISOString();

  // Validate all invoices have a payee id (same check as singular path)
  for (const invoice of invoices) {
    if (!invoice.invoice.payee.id) {
      throw new Error(`payee id required for one-off-vendor invoice ${invoice.id}`);
    }
  }

  const primaryVendorId = invoices[0]!.invoice.payee.id!;

  // One line per invoice — preserves per-vendor output mapping for signing path
  const lines: VendorPaymentLine[] = invoices.map((inv) => ({
    vendorId: inv.invoice.payee.id!,
    fiat: {
      minor: BigInt(Math.round(inv.invoice.total * 100)),
      currency: inv.invoice.currency,
    },
    crypto: { asset: "CKB", value: 0n, decimals: 8 },
    fxRate: "0",
    feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
  }));

  const id = `vb_${crypto.randomUUID()}`;
  const invoiceIds = invoices.map((i) => i.id);

  return {
    kind: "vendor",
    id,
    createdAt: now,
    updatedAt: now,
    label: `Bundle (${invoices.length} invoices)`,
    treasuryId: treasury.id,
    invoiceIds,
    vendorId: primaryVendorId,
    fxSnapshot: [],
    lines,
    state: "draft",
  };
}

function buildVendorPaymentBatch(invoice: InvoiceRecord, treasury: Treasury): VendorPaymentBatch {
  const vendorId = invoice.invoice.payee.id;
  if (!vendorId) {
    throw new Error(`payee id required for one-off-vendor invoice ${invoice.id}`);
  }
  const now = new Date().toISOString();
  const totalMinor = BigInt(Math.round(invoice.invoice.total * 100));
  const line: VendorPaymentLine = {
    vendorId,
    fiat: { minor: totalMinor, currency: invoice.invoice.currency },
    crypto: { asset: "CKB", value: 0n, decimals: 8 },
    fxRate: "0",
    feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
  };
  const id = `vb_${crypto.randomUUID()}`;
  return {
    kind: "vendor",
    id,
    createdAt: now,
    updatedAt: now,
    label: `${invoice.invoice.payee.display_name} ${invoice.invoice.invoice_number ?? invoice.id}`,
    treasuryId: treasury.id,
    invoiceIds: [invoice.id],
    vendorId,
    fxSnapshot: [],
    lines: [line],
    state: "draft",
  };
}
