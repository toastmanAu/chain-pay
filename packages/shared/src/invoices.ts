import type { Invoice } from "./invoice-schema";

export type { Invoice } from "./invoice-schema";
export { InvoiceSchema } from "./invoice-schema";

/**
 * Chain-pay-local wrapper. Adds an id and timestamps to the bare schema so we
 * can persist + index records without polluting the durable schema contract.
 */
export interface InvoiceRecord extends Invoice {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export const INVOICE_SCHEMA_VERSION = "0.1.0" as const;

export type InvoiceFlow = Invoice["invoice"]["flow"];
export type InvoiceApprovalStatus = Invoice["approval"]["status"];
