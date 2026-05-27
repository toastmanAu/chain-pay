import type {
  AnyBatch,
  InvoiceRecord,
  PayrollBatch,
  PayrollBatchLine,
  Treasury,
  VendorPaymentBatch,
  VendorPaymentLine,
} from "@chain-pay/shared";

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
    invoiceId: invoice.id,
    vendorId,
    fxSnapshot: [],
    line,
    state: "draft",
  };
}
