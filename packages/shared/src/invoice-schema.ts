import { z } from "zod";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const IsoDateTime = z.string().datetime({ offset: true });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);

const RawFileSchema = z.object({
  sha256: Sha256,
  mime_type: z.string(),
  byte_size: z.number().int().min(1),
  filename: z.string(),
  storage_uri: z.string(),
  page_count: z.number().int().min(1).nullable().optional(),
});

const SenderIdentitySchema = z.object({
  email: z.string().email().optional(),
  display_name: z.string().optional(),
  verified_via: z.enum(["dmarc", "spf", "allowlist", "none"]).optional(),
}).nullable().optional();

const IntakeSchema = z.object({
  source: z.enum(["manual-upload", "email", "api", "batch-import"]),
  uploaded_by: z.string().nullable().optional(),
  received_at: IsoDateTime,
  sender_identity: SenderIdentitySchema,
  raw_file: RawFileSchema,
});

const PayeeSchema = z.object({
  kind: z.enum(["vendor", "employee", "contractor", "unknown"]),
  id: z.string().nullable().optional(),
  display_name: z.string(),
  tax_id: z.string().nullable().optional(),
  tax_id_country: z.string().nullable().optional(),
});

const LineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable().optional(),
  unit_price: z.number().nullable().optional(),
  line_total: z.number(),
  tax_amount: z.number().nullable().optional(),
  account_hint: z.string().nullable().optional(),
});

const BankDetailsSchema = z.object({
  bsb: z.string().nullable().optional(),
  account_number: z.string().nullable().optional(),
  iban: z.string().nullable().optional(),
  swift: z.string().nullable().optional(),
  account_name: z.string().nullable().optional(),
}).nullable().optional();

const PaymentDetailsSchema = z.object({
  method_hint: z.enum(["bank-transfer", "ckb", "evm", "cheque", "cash", "unknown"]).optional(),
  bank: BankDetailsSchema,
  ckb_address: z.string().nullable().optional(),
  evm_address: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
}).optional();

const InvoiceBodySchema = z.object({
  flow: z.enum(["one-off-vendor", "employee-payment", "recurring-vendor", "unknown"]),
  payee: PayeeSchema,
  invoice_number: z.string().nullable().optional(),
  issue_date: IsoDate.nullable().optional(),
  due_date: IsoDate.nullable().optional(),
  currency: CurrencyCode,
  subtotal: z.number().nullable().optional(),
  tax_total: z.number().nullable().optional(),
  tax_label: z.string().nullable().optional(),
  total: z.number(),
  line_items: z.array(LineItemSchema).optional(),
  payment_details: PaymentDetailsSchema,
  notes: z.string().nullable().optional(),
});

const PipelineStageSchema = z.object({
  name: z.enum(["layout-ocr", "schema-extraction", "page-routing", "single-shot"]),
  model: z.string(),
  version: z.string(),
  elapsed_ms: z.number().int().min(0).nullable().optional(),
});

const ExtractionSchema = z.object({
  pipeline: z.object({ stages: z.array(PipelineStageSchema) }),
  extracted_at: IsoDateTime,
  field_confidences: z.record(z.string(), z.number().min(0).max(1)).optional(),
  warnings: z.array(z.object({
    field: z.string(),
    severity: z.enum(["info", "warn", "error"]),
    message: z.string(),
  })).optional(),
});

const EditEntrySchema = z.object({
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  edited_at: IsoDateTime,
  edited_by: z.string(),
});

const ApprovalSchema = z.object({
  status: z.enum(["draft", "in-review", "queued-for-signing", "signed", "rejected", "auto-rejected"]),
  reviewed_by: z.string().nullable().optional(),
  reviewed_at: IsoDateTime.nullable().optional(),
  rejection_reason: z.string().nullable().optional(),
  edits_made: z.array(EditEntrySchema).optional(),
});

const ChainpayLinkSchema = z.object({
  tx_hash: z.string().nullable().optional(),
  chain: z.enum(["ckb", "evm"]).nullable().optional(),
  frappe_doctype: z.string().nullable().optional(),
  frappe_docname: z.string().nullable().optional(),
}).optional();

export const InvoiceSchema = z.object({
  schema_version: z.literal("0.1.0"),
  org_id: z.string().nullable().optional(),
  intake: IntakeSchema,
  invoice: InvoiceBodySchema,
  extraction: ExtractionSchema,
  approval: ApprovalSchema,
  chainpay_link: ChainpayLinkSchema,
}).strict();

export type Invoice = z.infer<typeof InvoiceSchema>;
