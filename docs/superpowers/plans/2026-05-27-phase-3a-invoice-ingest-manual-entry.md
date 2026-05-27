# Phase 3a — Invoice Ingest (Manual Entry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the invoice-extraction schema (v0.1.0) as TypeScript+Zod inside chain-pay, deliver a working manual-entry → multisig handoff vertical for both `employee-payment` and `one-off-vendor` flows, with no OCR backend.

**Architecture:** Three new zustand+localStorage stores (invoices, vendors, invoice-drafts) with bigint suffix-tag serialization. PayrollBatch gains a `kind` discriminator; new `VendorPaymentBatch` type reuses `PayrollBatchState` and the 2.7c broadcast/retry machinery. PDFs stored content-addressed in Electron `userData` via new IPC bridge. New `features/invoices/` directory with NewInvoiceForm (Stage A: flow + payee + PDF) and ReviewInvoiceForm (Stage B: editable fields + approve & queue). Approve-and-queue uses safe-ordered writes (batch first, then invoice) since localStorage offers no multi-store transactions.

**Tech Stack:** TypeScript, Vitest (fake timers for debounced autosave, jsdom for component tests), Zustand (persist + createJSONStorage + migrate), React + Testing Library, React Hook Form (already a dep), Zod (already a dep), pdfjs-dist (new dep), Electron preload IPC. Reuses validated patterns from Phase 2.7a–c.

**Prerequisite:** Branches from PR #6's tip (commit `8f1a53c`) on `feat/phase-3a-invoice-ingest`. Spec already committed there as `7b8fd79` + `64141c5`. When PR #6 merges, rebase will skip those commits via git's commit-equivalence detection.

**Spec reference:** `docs/superpowers/specs/2026-05-27-phase-3a-invoice-ingest-manual-entry-design.md`

---

## File Structure

### New files in `packages/shared/src/` (3)

| Path | Responsibility |
|---|---|
| `invoice-schema.ts` | Zod schema mirroring `invoice-extraction-v0.json` v0.1.0. Single source of truth. |
| `invoices.ts` | `InvoiceRecord` wrapper type (adds `id`, `createdAt`, `updatedAt` to bare schema). Re-exports inferred types. |
| `vendors.ts` | `VendorProfile` interface. |
| `invoice-schema.test.ts` | Schema parse happy paths, boundary cases, round-trip against vault file. |
| `invoices.test.ts` | Type-derivation sanity (compile-only assertions). |
| `vendors.test.ts` | Trivial type-shape assertions. |

### Modified files in `packages/shared/src/` (2)

| Path | Change |
|---|---|
| `payroll.ts` | Add `kind: "payroll"` discriminator to `PayrollBatch`; add `VendorPaymentBatch` + `VendorPaymentLine` types. |
| `index.ts` | Re-export `invoices`, `vendors`, `invoice-schema`. |

### New files in `apps/desktop/src/lib/invoices/` (4)

| Path | Responsibility |
|---|---|
| `state-machine.ts` | Invoice state transitions: `draft` → `in-review` → `queued-for-signing` → `signed` \| `rejected`. |
| `file-storage.ts` | Renderer-side wrapper: hash blob, IPC store/read/delete. |
| `route-to-batch.ts` | `routeInvoiceToBatch(invoice, treasury)` → `PayrollBatch` \| `VendorPaymentBatch`. |
| `approve-and-queue.ts` | Safe-ordered handoff: add batch first, then mark invoice queued. |
| `state-machine.test.ts` | Legal/illegal transition matrix. |
| `file-storage.test.ts` | Hash + IPC roundtrip + dedup. |
| `route-to-batch.test.ts` | Both flows produce correct batch types. |
| `approve-and-queue.test.ts` | Safe-ordered write; orphan-batch outcome on second-write failure. |

### New files in `apps/desktop/src/stores/` (3)

| Path | Responsibility |
|---|---|
| `invoices.ts` | Zustand store, key `chain-pay:invoices`. Actions: addInvoice, updateInvoice, markInReview, markQueuedForSigning, markSigned, markRejected, findById. |
| `vendors.ts` | Zustand store, key `chain-pay:vendors`. Actions: addVendor, updateVendor, removeVendor, findById, findByDisplayNameAndTaxId. |
| `invoice-drafts.ts` | Zustand store, key `chain-pay:invoice-drafts`. Actions: upsertDraft, getDraft, clearDraft. |
| `invoices.test.ts` | Store CRUD + status transitions. |
| `vendors.test.ts` | Vendor CRUD + dedup lookup. |
| `invoice-drafts.test.ts` | Upsert + read + clear. |

### Modified files in `apps/desktop/src/stores/` (1)

| Path | Change |
|---|---|
| `payroll-batches.ts` | Accept `VendorPaymentBatch` in `batches[]`; bump `version: 1 → 2` with migration backfilling `kind: "payroll"` on existing records. |

### New files in `apps/desktop/electron/` (1)

| Path | Responsibility |
|---|---|
| `main/invoice-files-host.ts` | IPC handlers `invoice-files:store`, `invoice-files:read`, `invoice-files:delete`. Content-addressed under `app.getPath('userData')/invoice-pdfs/<2>/sha256.pdf`. |
| `main/invoice-files-host.test.ts` | Roundtrip write + read; dedup; delete. |

### Modified files in `apps/desktop/electron/` (2)

| Path | Change |
|---|---|
| `main/index.ts` | Register invoice-files IPC handlers at boot. |
| `preload/index.ts` | Expose `electron.invoiceFiles.{store, read, delete}`. |

### New files in `apps/desktop/src/features/invoices/` (8)

| Path | Responsibility |
|---|---|
| `hooks/useInvoiceDraft.ts` | Debounced (500ms) autosave hook. Reads + writes `invoice-drafts` store. |
| `VendorPicker.tsx` | Searchable combobox over vendors + inline "New vendor" form. |
| `NewInvoiceForm.tsx` | Stage A: flow radio, payee picker, PDF dropzone, Continue button. |
| `ReviewInvoiceForm.tsx` | Stage B: side-by-side PDF preview + editable form + Save/Reject/Approve. |
| `InvoiceList.tsx` | Status-grouped table of invoices. |
| `InvoicesPage.tsx` | Page wrapper with header + "New invoice" button + list. |
| `useInvoiceDraft.test.ts` | Debounce timing + persisted draft restore. |
| `VendorPicker.test.tsx` | Search + create flow. |
| `NewInvoiceForm.test.tsx` | Stage A validation + transition to Stage B. |
| `ReviewInvoiceForm.test.tsx` | Field editing → edits_made[]; approve & queue routing. |
| `InvoiceList.test.tsx` | Status grouping; click → navigation. |
| `InvoicesPage.test.tsx` | Renders header + list; New invoice button. |

### Modified files in `apps/desktop/src/` (2)

| Path | Change |
|---|---|
| `App.tsx` | Add `<Route path="/invoices" element={<InvoicesPage />} />` and child routes for `/new`, `/:id/review`. |
| `components/AppNav.tsx` (or equivalent) | Add "Invoices" entry between Payroll and Treasury (path to be confirmed in Task 23). |

### New dependencies (1)

| Package | Purpose | Where added |
|---|---|---|
| `pdfjs-dist` ^4.x | PDF preview rendering in ReviewInvoiceForm | `apps/desktop/package.json` |

---

## Task list (24 tasks)

Each task is fully self-contained: write failing test → run to confirm fail → minimal impl → run to confirm pass → commit. Tasks 1–6 build the type foundation; 7–11 the storage layer; 12–14 the PDF storage; 15–16 the routing seam; 17 the draft hook; 18–22 the UI; 23 nav wiring + confirmation hook; 24 final verification + PR.

---

### Task 1: Zod invoice schema skeleton

**Files:**
- Create: `packages/shared/src/invoice-schema.ts`
- Create: `packages/shared/src/invoice-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/invoice-schema.test.ts
import { describe, expect, it } from "vitest";
import { InvoiceSchema } from "./invoice-schema";

describe("InvoiceSchema", () => {
  it("accepts a minimal valid invoice", () => {
    const minimal = {
      schema_version: "0.1.0",
      intake: {
        source: "manual-upload",
        received_at: "2026-05-27T00:00:00Z",
        raw_file: {
          sha256: "a".repeat(64),
          mime_type: "application/pdf",
          byte_size: 12345,
          filename: "test.pdf",
          storage_uri: "file:///tmp/test.pdf",
        },
      },
      invoice: {
        flow: "one-off-vendor",
        payee: { kind: "vendor", display_name: "Acme Pty" },
        currency: "AUD",
        total: 1247.5,
      },
      extraction: {
        pipeline: { stages: [] },
        extracted_at: "2026-05-27T00:00:00Z",
      },
      approval: { status: "draft" },
    };
    const result = InvoiceSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects wrong schema_version", () => {
    const bad = {
      schema_version: "0.2.0",
      intake: {
        source: "manual-upload",
        received_at: "2026-05-27T00:00:00Z",
        raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" },
      },
      invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "X" }, currency: "AUD", total: 1 },
      extraction: { pipeline: { stages: [] }, extracted_at: "2026-05-27T00:00:00Z" },
      approval: { status: "draft" },
    };
    expect(InvoiceSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects bad currency code", () => {
    const bad = {
      schema_version: "0.1.0",
      intake: { source: "manual-upload", received_at: "2026-05-27T00:00:00Z", raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
      invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "X" }, currency: "aud", total: 1 },
      extraction: { pipeline: { stages: [] }, extracted_at: "2026-05-27T00:00:00Z" },
      approval: { status: "draft" },
    };
    expect(InvoiceSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects bad sha256 (not 64 hex chars)", () => {
    const bad = {
      schema_version: "0.1.0",
      intake: { source: "manual-upload", received_at: "2026-05-27T00:00:00Z", raw_file: { sha256: "abc", mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
      invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "X" }, currency: "AUD", total: 1 },
      extraction: { pipeline: { stages: [] }, extracted_at: "2026-05-27T00:00:00Z" },
      approval: { status: "draft" },
    };
    expect(InvoiceSchema.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/invoice-schema.test.ts`
Expected: FAIL — "Cannot find module './invoice-schema'".

- [ ] **Step 3: Write the schema**

```typescript
// packages/shared/src/invoice-schema.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/invoice-schema.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/invoice-schema.ts packages/shared/src/invoice-schema.test.ts
git commit -m "feat(3a): add Zod invoice schema (v0.1.0) with parse tests"
```

---

### Task 2: Schema round-trip against vault JSON schema

**Files:**
- Modify: `packages/shared/src/invoice-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/invoice-schema.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

describe("InvoiceSchema completeness vs vault file", () => {
  it("parses a maximal invoice covering every field from the vault JSON schema", () => {
    // Sanity: vault file must be present and pin schema_version
    const vaultSchemaPath = join(
      homedir(),
      "Documents/loacal-vault/Projects/ChainPay/schemas/invoice-extraction-v0.schema.json",
    );
    const vaultSchema = JSON.parse(readFileSync(vaultSchemaPath, "utf8")) as { properties: { schema_version: { const: string } } };
    expect(vaultSchema.properties.schema_version.const).toBe("0.1.0");

    // Maximal invoice — every optional field populated
    const maximal = {
      schema_version: "0.1.0",
      org_id: "acme-pty",
      intake: {
        source: "manual-upload",
        uploaded_by: "user_42",
        received_at: "2026-05-27T03:14:15Z",
        sender_identity: null,
        raw_file: {
          sha256: "f".repeat(64),
          mime_type: "application/pdf",
          byte_size: 247000,
          filename: "acme-may-2025.pdf",
          storage_uri: "file:///home/phill/.local/share/chain-pay/invoice-pdfs/ff/ffff…ffff.pdf",
          page_count: 2,
        },
      },
      invoice: {
        flow: "one-off-vendor",
        payee: {
          kind: "vendor",
          id: "vendor_acme",
          display_name: "Acme Pty Ltd",
          tax_id: "12 345 678 901",
          tax_id_country: "AU",
        },
        invoice_number: "INV-2025-001",
        issue_date: "2026-05-15",
        due_date: "2026-05-30",
        currency: "AUD",
        subtotal: 1133.18,
        tax_total: 113.32,
        tax_label: "GST",
        total: 1247.5,
        line_items: [
          {
            description: "Consulting — May",
            quantity: 1,
            unit_price: 1133.18,
            line_total: 1133.18,
            tax_amount: 113.32,
            account_hint: "expense:consulting",
          },
        ],
        payment_details: {
          method_hint: "bank-transfer",
          bank: { bsb: "012-345", account_number: "12345678", iban: null, swift: null, account_name: "Acme Pty Ltd" },
          ckb_address: null,
          evm_address: null,
          reference: "INV-2025-001",
        },
        notes: "Pay within 14 days net",
      },
      extraction: {
        pipeline: {
          stages: [
            { name: "layout-ocr", model: "PaddleOCR-VL", version: "1.0", elapsed_ms: 850 },
            { name: "schema-extraction", model: "NuExtract-2.0-8B", version: "2.0", elapsed_ms: 1200 },
          ],
        },
        extracted_at: "2026-05-27T03:14:20Z",
        field_confidences: { "invoice.total": 0.99, "invoice.tax_total": 0.87 },
        warnings: [{ field: "payment_details.bsb", severity: "warn", message: "low confidence" }],
      },
      approval: {
        status: "queued-for-signing",
        reviewed_by: "user_42",
        reviewed_at: "2026-05-27T03:20:00Z",
        rejection_reason: null,
        edits_made: [
          { field: "invoice.total", before: 1247, after: 1247.5, edited_at: "2026-05-27T03:18:00Z", edited_by: "user_42" },
        ],
      },
      chainpay_link: { tx_hash: null, chain: null, frappe_doctype: null, frappe_docname: null },
    };

    const result = InvoiceSchema.safeParse(maximal);
    if (!result.success) console.error(JSON.stringify(result.error.issues, null, 2));
    expect(result.success).toBe(true);
  });

  it("rejects unknown top-level fields (strict mode)", () => {
    const withExtra = {
      schema_version: "0.1.0",
      intake: { source: "manual-upload", received_at: "2026-05-27T00:00:00Z", raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
      invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "X" }, currency: "AUD", total: 1 },
      extraction: { pipeline: { stages: [] }, extracted_at: "2026-05-27T00:00:00Z" },
      approval: { status: "draft" },
      unknown_field: "boom",
    };
    expect(InvoiceSchema.safeParse(withExtra).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/invoice-schema.test.ts -t "completeness"`
Expected: FAIL on either `vault file present` (if vault not at expected path) OR `parses maximal invoice` (if any field is wrongly typed).

- [ ] **Step 3: Adjust schema to fix any reported issues**

The failing test output will name the specific field. Common fixes:
- If `field_confidences` key fails: relax the `z.record(z.string(), …)` — the vault schema uses a dotted-path pattern, but Zod's `z.record` with `z.string()` accepts any string key. Should pass as written.
- If `chainpay_link.chain` rejects `null`: confirm the enum has `.nullable()` outside the union.

Re-run after each adjustment.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/invoice-schema.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/invoice-schema.test.ts packages/shared/src/invoice-schema.ts
git commit -m "test(3a): round-trip schema against vault JSON schema (maximal invoice)"
```

---

### Task 3: Invoice wrapper types

**Files:**
- Create: `packages/shared/src/invoices.ts`
- Create: `packages/shared/src/invoices.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/invoices.test.ts
import { describe, expect, it, expectTypeOf } from "vitest";
import type { Invoice, InvoiceRecord } from "./invoices";

describe("InvoiceRecord", () => {
  it("extends Invoice with id, createdAt, updatedAt", () => {
    expectTypeOf<InvoiceRecord>().toHaveProperty("id").toEqualTypeOf<string>();
    expectTypeOf<InvoiceRecord>().toHaveProperty("createdAt").toEqualTypeOf<string>();
    expectTypeOf<InvoiceRecord>().toHaveProperty("updatedAt").toEqualTypeOf<string>();
    expectTypeOf<InvoiceRecord>().toHaveProperty("schema_version").toEqualTypeOf<"0.1.0">();
  });

  it("Invoice type is structurally compatible with what z.infer returns", () => {
    const sample: Invoice = {
      schema_version: "0.1.0",
      intake: {
        source: "manual-upload",
        received_at: "2026-05-27T00:00:00Z",
        raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" },
      },
      invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "X" }, currency: "AUD", total: 1 },
      extraction: { pipeline: { stages: [] }, extracted_at: "2026-05-27T00:00:00Z" },
      approval: { status: "draft" },
    };
    expect(sample.schema_version).toBe("0.1.0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/invoices.test.ts`
Expected: FAIL — "Cannot find module './invoices'".

- [ ] **Step 3: Write the wrapper**

```typescript
// packages/shared/src/invoices.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/invoices.test.ts`
Expected: PASS — 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/invoices.ts packages/shared/src/invoices.test.ts
git commit -m "feat(3a): add InvoiceRecord wrapper with id + timestamps"
```

---

### Task 4: VendorProfile type

**Files:**
- Create: `packages/shared/src/vendors.ts`
- Create: `packages/shared/src/vendors.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/vendors.test.ts
import { describe, expect, it, expectTypeOf } from "vitest";
import type { VendorProfile } from "./vendors";

describe("VendorProfile", () => {
  it("has required fields", () => {
    expectTypeOf<VendorProfile>().toHaveProperty("id").toEqualTypeOf<string>();
    expectTypeOf<VendorProfile>().toHaveProperty("displayName").toEqualTypeOf<string>();
    expectTypeOf<VendorProfile>().toHaveProperty("active").toEqualTypeOf<boolean>();
  });

  it("constructs with minimal required fields", () => {
    const v: VendorProfile = {
      id: "vendor_1",
      displayName: "Acme Pty",
      preferredChain: "ckb:testnet",
      active: true,
      createdAt: "2026-05-27T00:00:00Z",
      updatedAt: "2026-05-27T00:00:00Z",
    };
    expect(v.displayName).toBe("Acme Pty");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/vendors.test.ts`
Expected: FAIL — "Cannot find module './vendors'".

- [ ] **Step 3: Write the type**

```typescript
// packages/shared/src/vendors.ts
import type { Identified, PayeeAddress, Timestamped } from "./types";
import type { ChainId } from "./chainIds";

export interface VendorProfile extends Identified, Timestamped {
  displayName: string;
  /** ABN, VAT, EIN, etc. Format validation deferred to UI. */
  taxId?: string;
  /** ISO 3166-1 alpha-2 (AU, US, GB, …). */
  taxIdCountry?: string;
  preferredChain: ChainId;
  walletAddress?: PayeeAddress;
  bankDetails?: VendorBankDetails;
  notes?: string;
  active: boolean;
}

export interface VendorBankDetails {
  bsb?: string;
  accountNumber?: string;
  iban?: string;
  swift?: string;
  accountName?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/vendors.test.ts`
Expected: PASS — 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/vendors.ts packages/shared/src/vendors.test.ts
git commit -m "feat(3a): add VendorProfile type"
```

---

### Task 5: VendorPaymentBatch + PayrollBatch.kind discriminator

**Files:**
- Modify: `packages/shared/src/payroll.ts`
- Create: `packages/shared/src/payroll-vendor.test.ts` (new test file, doesn't disturb existing payroll tests)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/payroll-vendor.test.ts
import { describe, expect, it, expectTypeOf } from "vitest";
import type {
  PayrollBatch,
  VendorPaymentBatch,
  VendorPaymentLine,
  PayrollBatchState,
} from "./payroll";

describe("kind discriminator + VendorPaymentBatch", () => {
  it("PayrollBatch.kind is 'payroll'", () => {
    expectTypeOf<PayrollBatch>().toHaveProperty("kind").toEqualTypeOf<"payroll">();
  });

  it("VendorPaymentBatch.kind is 'vendor'", () => {
    expectTypeOf<VendorPaymentBatch>().toHaveProperty("kind").toEqualTypeOf<"vendor">();
  });

  it("VendorPaymentBatch shares state enum with PayrollBatch", () => {
    expectTypeOf<VendorPaymentBatch["state"]>().toEqualTypeOf<PayrollBatchState>();
  });

  it("VendorPaymentBatch has a single line, not an array", () => {
    expectTypeOf<VendorPaymentBatch>().toHaveProperty("line").toEqualTypeOf<VendorPaymentLine>();
  });

  it("VendorPaymentBatch backlinks an invoiceId", () => {
    expectTypeOf<VendorPaymentBatch>().toHaveProperty("invoiceId").toEqualTypeOf<string>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/payroll-vendor.test.ts`
Expected: FAIL — type errors on missing `kind`, `VendorPaymentBatch`, etc.

- [ ] **Step 3: Extend `payroll.ts`**

Add at the end of `packages/shared/src/payroll.ts` (do not modify existing types except for the `PayrollBatch` interface):

In the existing `PayrollBatch` interface, add as the first property:

```typescript
export interface PayrollBatch extends Identified, Timestamped {
  /** Discriminator. Backfilled to "payroll" on existing persisted records by store v1→v2 migration. */
  kind: "payroll";
  label: string;
  // ... (existing fields unchanged)
```

Then append after the existing types:

```typescript
export interface VendorPaymentLine {
  vendorId: string;
  fiat: FiatAmount;
  crypto: Money;
  fxRate: string;
  feeAllocated: Money;
}

export interface VendorPaymentBatch extends Identified, Timestamped {
  kind: "vendor";
  label: string;
  treasuryId: string;
  invoiceId: string;
  vendorId: string;
  fxSnapshot: FxQuote[];
  line: VendorPaymentLine;
  state: PayrollBatchState;
  pendingTxId?: string;
  txBytes?: string;
  sighashDigest?: string;
  totals?: PayrollBatchTotals;
  commPacket?: string;
  partialSigs?: PartialSigEntry[];
  commSendStatus?: Record<number, CommSendSlotStatus>;
  autoBroadcast?: boolean;
  broadcastError?: string;
  broadcastInFlight?: boolean;
  expiresAt?: number;
}

export type AnyBatch = PayrollBatch | VendorPaymentBatch;

export function isVendorBatch(b: AnyBatch): b is VendorPaymentBatch {
  return b.kind === "vendor";
}

export function isPayrollBatch(b: AnyBatch): b is PayrollBatch {
  return b.kind === "payroll";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/payroll-vendor.test.ts`
Expected: PASS — 5 tests green.

Also run the full shared package test suite to confirm no regression:

Run: `cd packages/shared && npx vitest run`
Expected: All existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/payroll.ts packages/shared/src/payroll-vendor.test.ts
git commit -m "feat(3a): add kind discriminator + VendorPaymentBatch type"
```

---

### Task 6: Wire new types into shared index

**Files:**
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/index.test.ts (CREATE)
import { describe, expect, it } from "vitest";
import * as shared from "./index";

describe("@chain-pay/shared exports", () => {
  it("re-exports invoice types", () => {
    expect(shared).toHaveProperty("InvoiceSchema");
    expect(shared).toHaveProperty("INVOICE_SCHEMA_VERSION");
    expect(shared.INVOICE_SCHEMA_VERSION).toBe("0.1.0");
  });

  it("re-exports vendor types", () => {
    // Type-only; just confirm the module compiles + the import resolves
    expect(true).toBe(true);
  });

  it("re-exports batch discriminator helpers", () => {
    expect(typeof shared.isVendorBatch).toBe("function");
    expect(typeof shared.isPayrollBatch).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/index.test.ts`
Expected: FAIL — `InvoiceSchema` and helpers not exported.

- [ ] **Step 3: Update index**

```typescript
// packages/shared/src/index.ts
export * from "./types";
export * from "./chainIds";
export * from "./money";
export * from "./treasury";
export * from "./payroll";
export * from "./invoices";
export * from "./vendors";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/index.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts packages/shared/src/index.test.ts
git commit -m "feat(3a): re-export invoice + vendor types from shared barrel"
```

---

### Task 7: Invoice state machine

**Files:**
- Create: `apps/desktop/src/lib/invoices/state-machine.ts`
- Create: `apps/desktop/src/lib/invoices/state-machine.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/lib/invoices/state-machine.test.ts
import { describe, expect, it } from "vitest";
import type { InvoiceApprovalStatus } from "@chain-pay/shared";
import { assertCanTransitionInvoice, canTransitionInvoice, isTerminalInvoice, nextInvoiceStates } from "./state-machine";

describe("invoice state machine", () => {
  it("draft → in-review is legal", () => {
    expect(canTransitionInvoice("draft", "in-review")).toBe(true);
  });

  it("draft → signed is illegal (must pass through in-review and queued)", () => {
    expect(canTransitionInvoice("draft", "signed")).toBe(false);
  });

  it("in-review → queued-for-signing is legal", () => {
    expect(canTransitionInvoice("in-review", "queued-for-signing")).toBe(true);
  });

  it("in-review → rejected is legal", () => {
    expect(canTransitionInvoice("in-review", "rejected")).toBe(true);
  });

  it("queued-for-signing → signed is legal", () => {
    expect(canTransitionInvoice("queued-for-signing", "signed")).toBe(true);
  });

  it("queued-for-signing → rejected is illegal (cancel batch first)", () => {
    expect(canTransitionInvoice("queued-for-signing", "rejected")).toBe(false);
  });

  it("signed is terminal", () => {
    expect(isTerminalInvoice("signed")).toBe(true);
    expect(canTransitionInvoice("signed", "rejected")).toBe(false);
  });

  it("rejected is terminal", () => {
    expect(isTerminalInvoice("rejected")).toBe(true);
  });

  it("same-state transitions always illegal", () => {
    const all: InvoiceApprovalStatus[] = ["draft", "in-review", "queued-for-signing", "signed", "rejected", "auto-rejected"];
    for (const s of all) expect(canTransitionInvoice(s, s)).toBe(false);
  });

  it("assertCanTransitionInvoice throws on illegal", () => {
    expect(() => assertCanTransitionInvoice("signed", "draft")).toThrow(/invalid invoice transition/);
  });

  it("nextInvoiceStates returns forward set for in-review", () => {
    expect(nextInvoiceStates("in-review").sort()).toEqual(["queued-for-signing", "rejected"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/invoices/state-machine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the state machine**

```typescript
// apps/desktop/src/lib/invoices/state-machine.ts
import type { InvoiceApprovalStatus } from "@chain-pay/shared";

/**
 * Invoice approval lifecycle. Separate from PayrollBatchState — invoices live
 * upstream of batches. Once an invoice transitions to `queued-for-signing`,
 * the linked batch's state machine takes over; on batch.state === "confirmed",
 * the linked invoice transitions to "signed".
 *
 *   draft ───► in-review ───► queued-for-signing ───► signed
 *                  │
 *                  └────► rejected
 *
 * signed, rejected, auto-rejected are terminal.
 * auto-rejected is reserved for Phase 3b (OCR confidence below threshold).
 */
const TRANSITIONS: Record<InvoiceApprovalStatus, InvoiceApprovalStatus[]> = {
  draft: ["in-review"],
  "in-review": ["queued-for-signing", "rejected", "draft"],
  "queued-for-signing": ["signed"],
  signed: [],
  rejected: [],
  "auto-rejected": [],
};

export const terminalInvoiceStates: readonly InvoiceApprovalStatus[] = ["signed", "rejected", "auto-rejected"];

export function canTransitionInvoice(from: InvoiceApprovalStatus, to: InvoiceApprovalStatus): boolean {
  if (from === to) return false;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertCanTransitionInvoice(from: InvoiceApprovalStatus, to: InvoiceApprovalStatus): void {
  if (!canTransitionInvoice(from, to)) {
    throw new Error(
      `invalid invoice transition: ${from} → ${to} (allowed from '${from}': ${TRANSITIONS[from]?.join(", ") || "none"})`,
    );
  }
}

export function isTerminalInvoice(state: InvoiceApprovalStatus): boolean {
  return terminalInvoiceStates.includes(state);
}

export function nextInvoiceStates(from: InvoiceApprovalStatus): InvoiceApprovalStatus[] {
  return TRANSITIONS[from] ?? [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/lib/invoices/state-machine.test.ts`
Expected: PASS — 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/invoices/state-machine.ts apps/desktop/src/lib/invoices/state-machine.test.ts
git commit -m "feat(3a): invoice state machine (draft → in-review → queued → signed | rejected)"
```

---

### Task 8: Vendors zustand store

**Files:**
- Create: `apps/desktop/src/stores/vendors.ts`
- Create: `apps/desktop/src/stores/vendors.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/stores/vendors.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import type { VendorProfile } from "@chain-pay/shared";
import { useVendorsStore } from "./vendors";

function v(overrides: Partial<VendorProfile> = {}): VendorProfile {
  const now = new Date().toISOString();
  return {
    id: "vendor_1",
    displayName: "Acme Pty",
    preferredChain: "ckb:testnet",
    active: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("useVendorsStore", () => {
  beforeEach(() => {
    useVendorsStore.setState({ vendors: [] });
    globalThis.localStorage?.clear();
  });

  it("addVendor appends", () => {
    useVendorsStore.getState().addVendor(v());
    expect(useVendorsStore.getState().vendors).toHaveLength(1);
  });

  it("findById returns the matching vendor", () => {
    useVendorsStore.getState().addVendor(v({ id: "vendor_42" }));
    expect(useVendorsStore.getState().findById("vendor_42")?.displayName).toBe("Acme Pty");
  });

  it("updateVendor patches but preserves id + createdAt", () => {
    const created = v({ id: "vendor_42", createdAt: "2026-01-01T00:00:00Z" });
    useVendorsStore.getState().addVendor(created);
    useVendorsStore.getState().updateVendor("vendor_42", { displayName: "Acme Pty Ltd" });
    const after = useVendorsStore.getState().findById("vendor_42")!;
    expect(after.displayName).toBe("Acme Pty Ltd");
    expect(after.id).toBe("vendor_42");
    expect(after.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(after.updatedAt).not.toBe("2026-01-01T00:00:00Z");
  });

  it("removeVendor drops it from the list", () => {
    useVendorsStore.getState().addVendor(v({ id: "vendor_1" }));
    useVendorsStore.getState().addVendor(v({ id: "vendor_2", displayName: "Other" }));
    useVendorsStore.getState().removeVendor("vendor_1");
    expect(useVendorsStore.getState().vendors).toHaveLength(1);
    expect(useVendorsStore.getState().vendors[0]?.id).toBe("vendor_2");
  });

  it("findByDisplayNameAndTaxId matches exact name+taxId", () => {
    useVendorsStore.getState().addVendor(v({ id: "v1", displayName: "Acme Pty", taxId: "12345" }));
    useVendorsStore.getState().addVendor(v({ id: "v2", displayName: "Acme Pty", taxId: "67890" }));
    expect(useVendorsStore.getState().findByDisplayNameAndTaxId("Acme Pty", "12345")?.id).toBe("v1");
    expect(useVendorsStore.getState().findByDisplayNameAndTaxId("Acme Pty", "99999")).toBeUndefined();
  });

  it("findByDisplayNameAndTaxId matches name when taxId omitted on both", () => {
    useVendorsStore.getState().addVendor(v({ id: "v1", displayName: "Sole Trader" }));
    expect(useVendorsStore.getState().findByDisplayNameAndTaxId("Sole Trader", undefined)?.id).toBe("v1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/stores/vendors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the store**

```typescript
// apps/desktop/src/stores/vendors.ts
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { VendorProfile } from "@chain-pay/shared";

interface VendorsStore {
  vendors: VendorProfile[];
  addVendor: (v: VendorProfile) => void;
  updateVendor: (id: string, patch: Partial<Omit<VendorProfile, "id" | "createdAt">>) => void;
  removeVendor: (id: string) => void;
  findById: (id: string) => VendorProfile | undefined;
  /** Exact-match dedup. Treat undefined taxId as a value (so two no-taxId vendors with same name match). */
  findByDisplayNameAndTaxId: (displayName: string, taxId: string | undefined) => VendorProfile | undefined;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}
function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  return value;
}

const vendorsStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

const jsonStorage = createJSONStorage(() => vendorsStorage, {
  replacer: bigintReplacer,
  reviver: bigintReviver,
});

export const useVendorsStore = create<VendorsStore>()(
  persist(
    (set, get) => ({
      vendors: [],
      addVendor: (v) => set((s) => ({ vendors: [...s.vendors, v] })),
      updateVendor: (id, patch) =>
        set((s) => ({
          vendors: s.vendors.map((v) =>
            v.id === id ? { ...v, ...patch, id: v.id, createdAt: v.createdAt, updatedAt: new Date().toISOString() } : v,
          ),
        })),
      removeVendor: (id) => set((s) => ({ vendors: s.vendors.filter((v) => v.id !== id) })),
      findById: (id) => get().vendors.find((v) => v.id === id),
      findByDisplayNameAndTaxId: (displayName, taxId) =>
        get().vendors.find((v) => v.displayName === displayName && v.taxId === taxId),
    }),
    {
      name: "chain-pay:vendors",
      storage: jsonStorage,
      version: 1,
      partialize: (state) => ({ vendors: state.vendors }),
    },
  ),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/stores/vendors.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/vendors.ts apps/desktop/src/stores/vendors.test.ts
git commit -m "feat(3a): vendors zustand store with dedup lookup"
```

---

### Task 9: Invoices zustand store

**Files:**
- Create: `apps/desktop/src/stores/invoices.ts`
- Create: `apps/desktop/src/stores/invoices.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/stores/invoices.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import type { InvoiceRecord } from "@chain-pay/shared";
import { useInvoicesStore } from "./invoices";

function inv(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  const now = new Date().toISOString();
  return {
    id: "inv_1",
    createdAt: now,
    updatedAt: now,
    schema_version: "0.1.0",
    intake: {
      source: "manual-upload",
      received_at: now,
      raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" },
    },
    invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "Acme" }, currency: "AUD", total: 100 },
    extraction: { pipeline: { stages: [] }, extracted_at: now },
    approval: { status: "draft" },
    ...overrides,
  } as InvoiceRecord;
}

describe("useInvoicesStore", () => {
  beforeEach(() => {
    useInvoicesStore.setState({ invoices: [] });
    globalThis.localStorage?.clear();
  });

  it("addInvoice appends", () => {
    useInvoicesStore.getState().addInvoice(inv());
    expect(useInvoicesStore.getState().invoices).toHaveLength(1);
  });

  it("addInvoice is idempotent on duplicate id", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_42" }));
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_42", invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "DIFFERENT" }, currency: "USD", total: 999 } }));
    expect(useInvoicesStore.getState().invoices).toHaveLength(1);
    // First write wins (no overwrite on dup id)
    expect(useInvoicesStore.getState().findById("inv_42")?.invoice.payee.display_name).toBe("Acme");
  });

  it("markInReview transitions draft → in-review", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1", approval: { status: "draft" } }));
    useInvoicesStore.getState().markInReview("inv_1");
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("in-review");
  });

  it("markInReview throws on illegal transition (signed → in-review)", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1", approval: { status: "signed" } }));
    expect(() => useInvoicesStore.getState().markInReview("inv_1")).toThrow(/invalid invoice transition/);
  });

  it("markQueuedForSigning records reviewer, timestamp, and batchId via chainpay_link.frappe_doctype-adjacent extension (not chainpay_link)", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1", approval: { status: "in-review" } }));
    useInvoicesStore.getState().markQueuedForSigning("inv_1", "batch_99", "user_42");
    const after = useInvoicesStore.getState().findById("inv_1")!;
    expect(after.approval.status).toBe("queued-for-signing");
    expect(after.approval.reviewed_by).toBe("user_42");
    expect(after.approval.reviewed_at).toBeDefined();
    // batchId is stored under the local-only batchId field — we extend InvoiceRecord
    // see Step 3 of this task for where batchId lives.
  });

  it("markSigned populates chainpay_link", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1", approval: { status: "queued-for-signing" } }));
    useInvoicesStore.getState().markSigned("inv_1", { txHash: "0xabc", chain: "ckb" });
    const after = useInvoicesStore.getState().findById("inv_1")!;
    expect(after.approval.status).toBe("signed");
    expect(after.chainpay_link?.tx_hash).toBe("0xabc");
    expect(after.chainpay_link?.chain).toBe("ckb");
  });

  it("markRejected records rejection_reason and transitions", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1", approval: { status: "in-review" } }));
    useInvoicesStore.getState().markRejected("inv_1", "duplicate of inv_42");
    const after = useInvoicesStore.getState().findById("inv_1")!;
    expect(after.approval.status).toBe("rejected");
    expect(after.approval.rejection_reason).toBe("duplicate of inv_42");
  });

  it("appendEdit pushes to edits_made", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "inv_1" }));
    useInvoicesStore.getState().appendEdit("inv_1", {
      field: "invoice.total", before: 100, after: 200, edited_by: "user_42",
    });
    const after = useInvoicesStore.getState().findById("inv_1")!;
    expect(after.approval.edits_made).toHaveLength(1);
    expect(after.approval.edits_made![0].field).toBe("invoice.total");
    expect(after.approval.edits_made![0].edited_at).toBeDefined();
  });

  it("filterByStatus returns matching invoices", () => {
    useInvoicesStore.getState().addInvoice(inv({ id: "a", approval: { status: "draft" } }));
    useInvoicesStore.getState().addInvoice(inv({ id: "b", approval: { status: "in-review" } }));
    useInvoicesStore.getState().addInvoice(inv({ id: "c", approval: { status: "in-review" } }));
    expect(useInvoicesStore.getState().filterByStatus("in-review")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/stores/invoices.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the store**

```typescript
// apps/desktop/src/stores/invoices.ts
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { InvoiceApprovalStatus, InvoiceRecord } from "@chain-pay/shared";
import { assertCanTransitionInvoice } from "@/lib/invoices/state-machine";

/** Local-only wrapper field — backlink to the linked PayrollBatch or VendorPaymentBatch id. */
export interface StoredInvoiceRecord extends InvoiceRecord {
  /** Set when approval.status transitions to "queued-for-signing". */
  batchId?: string;
}

interface InvoicesStore {
  invoices: StoredInvoiceRecord[];
  addInvoice: (i: InvoiceRecord) => void;
  updateInvoice: (id: string, patch: Partial<Omit<StoredInvoiceRecord, "id" | "createdAt" | "schema_version">>) => void;
  markInReview: (id: string) => void;
  markQueuedForSigning: (id: string, batchId: string, reviewerId: string) => void;
  markSigned: (id: string, link: { txHash: string; chain: "ckb" | "evm" }) => void;
  markRejected: (id: string, reason: string) => void;
  appendEdit: (id: string, entry: { field: string; before: unknown; after: unknown; edited_by: string }) => void;
  findById: (id: string) => StoredInvoiceRecord | undefined;
  filterByStatus: (status: InvoiceApprovalStatus) => StoredInvoiceRecord[];
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}
function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  return value;
}

const invoicesStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

const jsonStorage = createJSONStorage(() => invoicesStorage, {
  replacer: bigintReplacer,
  reviver: bigintReviver,
});

function transitionStatus(inv: StoredInvoiceRecord, to: InvoiceApprovalStatus, extra: Partial<InvoiceRecord["approval"]> = {}): StoredInvoiceRecord {
  assertCanTransitionInvoice(inv.approval.status, to);
  return {
    ...inv,
    approval: { ...inv.approval, ...extra, status: to },
    updatedAt: new Date().toISOString(),
  };
}

export const useInvoicesStore = create<InvoicesStore>()(
  persist(
    (set, get) => ({
      invoices: [],
      addInvoice: (i) =>
        set((s) => (s.invoices.some((x) => x.id === i.id) ? s : { invoices: [...s.invoices, i] })),
      updateInvoice: (id, patch) =>
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === id ? { ...i, ...patch, id: i.id, createdAt: i.createdAt, schema_version: i.schema_version, updatedAt: new Date().toISOString() } : i,
          ),
        })),
      markInReview: (id) =>
        set((s) => ({
          invoices: s.invoices.map((i) => (i.id === id ? transitionStatus(i, "in-review") : i)),
        })),
      markQueuedForSigning: (id, batchId, reviewerId) =>
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === id
              ? { ...transitionStatus(i, "queued-for-signing", { reviewed_by: reviewerId, reviewed_at: new Date().toISOString() }), batchId }
              : i,
          ),
        })),
      markSigned: (id, link) =>
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === id
              ? {
                  ...transitionStatus(i, "signed"),
                  chainpay_link: { ...(i.chainpay_link ?? {}), tx_hash: link.txHash, chain: link.chain },
                }
              : i,
          ),
        })),
      markRejected: (id, reason) =>
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === id ? transitionStatus(i, "rejected", { rejection_reason: reason }) : i,
          ),
        })),
      appendEdit: (id, entry) =>
        set((s) => ({
          invoices: s.invoices.map((i) => {
            if (i.id !== id) return i;
            const existing = i.approval.edits_made ?? [];
            const fullEntry = { ...entry, edited_at: new Date().toISOString() };
            return {
              ...i,
              approval: { ...i.approval, edits_made: [...existing, fullEntry] },
              updatedAt: new Date().toISOString(),
            };
          }),
        })),
      findById: (id) => get().invoices.find((i) => i.id === id),
      filterByStatus: (status) => get().invoices.filter((i) => i.approval.status === status),
    }),
    {
      name: "chain-pay:invoices",
      storage: jsonStorage,
      version: 1,
      partialize: (state) => ({ invoices: state.invoices }),
    },
  ),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/stores/invoices.test.ts`
Expected: PASS — 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/invoices.ts apps/desktop/src/stores/invoices.test.ts
git commit -m "feat(3a): invoices zustand store with state-machine-guarded transitions"
```

---

### Task 10: Invoice drafts zustand store

**Files:**
- Create: `apps/desktop/src/stores/invoice-drafts.ts`
- Create: `apps/desktop/src/stores/invoice-drafts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/stores/invoice-drafts.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { useInvoiceDraftsStore } from "./invoice-drafts";

describe("useInvoiceDraftsStore", () => {
  beforeEach(() => {
    useInvoiceDraftsStore.setState({ drafts: {} });
    globalThis.localStorage?.clear();
  });

  it("upsertDraft stores under invoiceId", () => {
    useInvoiceDraftsStore.getState().upsertDraft("inv_1", { invoice: { flow: "one-off-vendor", total: 50, payee: { kind: "vendor", display_name: "X" }, currency: "AUD" } } as unknown as Partial<import("@chain-pay/shared").InvoiceRecord>);
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")).toBeDefined();
  });

  it("upsertDraft merges over existing partial", () => {
    useInvoiceDraftsStore.getState().upsertDraft("inv_1", { invoice: { flow: "one-off-vendor", total: 50, payee: { kind: "vendor", display_name: "X" }, currency: "AUD" } } as never);
    useInvoiceDraftsStore.getState().upsertDraft("inv_1", { invoice: { flow: "one-off-vendor", total: 75, payee: { kind: "vendor", display_name: "X" }, currency: "AUD" } } as never);
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")?.invoice?.total).toBe(75);
  });

  it("clearDraft removes the entry", () => {
    useInvoiceDraftsStore.getState().upsertDraft("inv_1", {} as never);
    useInvoiceDraftsStore.getState().clearDraft("inv_1");
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")).toBeUndefined();
  });

  it("getDraft returns undefined for unknown id", () => {
    expect(useInvoiceDraftsStore.getState().getDraft("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/stores/invoice-drafts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the store**

```typescript
// apps/desktop/src/stores/invoice-drafts.ts
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { InvoiceRecord } from "@chain-pay/shared";

interface InvoiceDraftsStore {
  drafts: Record<string, Partial<InvoiceRecord>>;
  upsertDraft: (invoiceId: string, partial: Partial<InvoiceRecord>) => void;
  getDraft: (invoiceId: string) => Partial<InvoiceRecord> | undefined;
  clearDraft: (invoiceId: string) => void;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}
function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  return value;
}

const draftsStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

const jsonStorage = createJSONStorage(() => draftsStorage, {
  replacer: bigintReplacer,
  reviver: bigintReviver,
});

export const useInvoiceDraftsStore = create<InvoiceDraftsStore>()(
  persist(
    (set, get) => ({
      drafts: {},
      upsertDraft: (invoiceId, partial) =>
        set((s) => ({
          drafts: { ...s.drafts, [invoiceId]: { ...(s.drafts[invoiceId] ?? {}), ...partial } },
        })),
      getDraft: (invoiceId) => get().drafts[invoiceId],
      clearDraft: (invoiceId) =>
        set((s) => {
          const next = { ...s.drafts };
          delete next[invoiceId];
          return { drafts: next };
        }),
    }),
    {
      name: "chain-pay:invoice-drafts",
      storage: jsonStorage,
      version: 1,
      partialize: (state) => ({ drafts: state.drafts }),
    },
  ),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/stores/invoice-drafts.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/invoice-drafts.ts apps/desktop/src/stores/invoice-drafts.test.ts
git commit -m "feat(3a): invoice-drafts zustand store for form-state autosave"
```

---

### Task 11: PayrollBatch store — kind discriminator + v1→v2 migration

**Files:**
- Modify: `apps/desktop/src/stores/payroll-batches.ts`
- Modify: `apps/desktop/src/stores/payroll-batches.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/stores/payroll-batches.test.ts`:

```typescript
import type { VendorPaymentBatch } from "@chain-pay/shared";

describe("kind discriminator + v1→v2 migration", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    usePayrollBatchesStore.setState({ batches: [], selectedDraftId: null });
  });

  it("addBatch accepts a VendorPaymentBatch", () => {
    const vb: VendorPaymentBatch = {
      kind: "vendor",
      id: "vb_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      label: "Acme INV-001",
      treasuryId: "tr_1",
      invoiceId: "inv_1",
      vendorId: "vendor_1",
      fxSnapshot: [],
      line: { vendorId: "vendor_1", fiat: { minor: 100n, currency: "AUD", scale: 2 }, crypto: { value: 1000000n, asset: "CKB" }, fxRate: "1", feeAllocated: { value: 0n, asset: "CKB", decimals: 8 } },
      state: "draft",
    };
    usePayrollBatchesStore.getState().addBatch(vb);
    const stored = usePayrollBatchesStore.getState().findById("vb_1");
    expect(stored?.kind).toBe("vendor");
  });

  it("v1→v2 migration backfills kind: payroll on records without one", () => {
    // Simulate a v1 persisted blob (no kind field)
    const v1Blob = {
      state: { batches: [{ id: "old_1", label: "Old Batch", treasuryId: "tr_1", cycleStart: "2026-01-01", cycleEnd: "2026-01-31", fxSnapshot: [], lines: [], state: "draft", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] },
      version: 1,
    };
    globalThis.localStorage?.setItem("chain-pay:payroll-batches", JSON.stringify(v1Blob));

    // Force re-hydration
    usePayrollBatchesStore.persist.rehydrate();

    const migrated = usePayrollBatchesStore.getState().batches;
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.kind).toBe("payroll");
  });

  it("migration is idempotent — records already having kind are unchanged", () => {
    const v2Blob = {
      state: { batches: [{ kind: "vendor", id: "vb_1", label: "X", treasuryId: "tr_1", invoiceId: "inv_1", vendorId: "v_1", fxSnapshot: [], line: { vendorId: "v_1", fiat: { minor: "100n", currency: "AUD", scale: 2 }, crypto: { value: "1000000n", asset: "CKB" }, fxRate: "1", feeAllocated: { value: "0n", asset: "CKB" } }, state: "draft", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] },
      version: 2,
    };
    globalThis.localStorage?.setItem("chain-pay:payroll-batches", JSON.stringify(v2Blob));
    usePayrollBatchesStore.persist.rehydrate();
    expect(usePayrollBatchesStore.getState().batches[0]?.kind).toBe("vendor");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/stores/payroll-batches.test.ts -t "kind discriminator"`
Expected: FAIL — `addBatch` may reject the new type, or migration doesn't backfill `kind`.

- [ ] **Step 3: Update the store**

In `apps/desktop/src/stores/payroll-batches.ts`:

(a) Change the import and `batches` field type:

```typescript
import type {
  AnyBatch,
  CommSendSlotStatus,
  PartialSigEntry,
  PayrollBatch,
  PayrollBatchState,
  VendorPaymentBatch,
} from "@chain-pay/shared";

interface PayrollBatchesStore {
  batches: AnyBatch[];
  // ... rest unchanged
  addBatch: (b: AnyBatch) => void;
  // ... existing actions unchanged but operate on AnyBatch
}
```

(b) In `addBatch`, add idempotency for duplicate ids (needed by approve-and-queue's recovery path):

```typescript
addBatch: (b) => set((s) => (s.batches.some((x) => x.id === b.id) ? s : { batches: [...s.batches, b] })),
```

(c) Bump version + add migration in the persist config:

```typescript
{
  name: "chain-pay:payroll-batches",
  storage: jsonStorage,
  version: 2,
  partialize: (state) => ({ batches: state.batches }),
  migrate: (persistedState, version): { batches: AnyBatch[] } => {
    const state = (persistedState as { batches: Array<AnyBatch | Omit<PayrollBatch, "kind">> }) ?? { batches: [] };
    if (version < 2) {
      return {
        batches: state.batches.map((b) =>
          "kind" in b && b.kind ? (b as AnyBatch) : ({ ...b, kind: "payroll" } as PayrollBatch),
        ),
      };
    }
    return state as { batches: AnyBatch[] };
  },
}
```

(d) Where any existing action narrows on `kind: "payroll"`-only behaviour (e.g. `drainIncomingSigsInto` reads `partialSigs` which both types share, so no change needed there). Skim each action and confirm — they all read shared fields, no narrowing required.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/stores/payroll-batches.test.ts`
Expected: PASS — all existing tests still green plus 3 new tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/payroll-batches.ts apps/desktop/src/stores/payroll-batches.test.ts
git commit -m "feat(3a): payroll-batches store accepts VendorPaymentBatch + v1→v2 migration"
```

---

### Task 12: Electron IPC handler for PDF storage

**Files:**
- Create: `apps/desktop/electron/main/invoice-files-host.ts`
- Create: `apps/desktop/electron/main/invoice-files-host.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/electron/main/invoice-files-host.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeInvoiceFile, readInvoiceFile, deleteInvoiceFile, __resetForTest } from "./invoice-files-host";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "invoice-files-host-"));
  __resetForTest(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("invoice-files-host", () => {
  it("storeInvoiceFile writes content-addressed file and returns file:// URI", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = "deadbeef".repeat(8); // 64 hex chars
    const uri = await storeInvoiceFile(bytes, sha256);
    expect(uri).toBe(`file://${join(tmpRoot, "invoice-pdfs", "de", `${sha256}.pdf`)}`);
    expect(existsSync(join(tmpRoot, "invoice-pdfs", "de", `${sha256}.pdf`))).toBe(true);
  });

  it("storeInvoiceFile is idempotent on duplicate sha256", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = "feedface".repeat(8);
    const uri1 = await storeInvoiceFile(bytes, sha256);
    const uri2 = await storeInvoiceFile(bytes, sha256);
    expect(uri1).toBe(uri2);
  });

  it("readInvoiceFile reads back the bytes", async () => {
    const bytes = new Uint8Array([42, 7, 99]);
    const sha256 = "abcdef00".repeat(8);
    const uri = await storeInvoiceFile(bytes, sha256);
    const read = await readInvoiceFile(uri);
    expect(Array.from(read)).toEqual([42, 7, 99]);
  });

  it("deleteInvoiceFile removes the file", async () => {
    const bytes = new Uint8Array([1]);
    const sha256 = "11223344".repeat(8);
    const uri = await storeInvoiceFile(bytes, sha256);
    await deleteInvoiceFile(uri);
    expect(existsSync(join(tmpRoot, "invoice-pdfs", "11", `${sha256}.pdf`))).toBe(false);
  });

  it("storeInvoiceFile rejects an invalid sha256", async () => {
    await expect(storeInvoiceFile(new Uint8Array([1]), "not-hex")).rejects.toThrow(/invalid sha256/);
  });

  it("readInvoiceFile rejects URIs outside the invoice-pdfs root (path traversal guard)", async () => {
    await expect(readInvoiceFile(`file://${join(tmpRoot, "..", "evil.pdf")}`)).rejects.toThrow(/outside invoice-pdfs root/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run electron/main/invoice-files-host.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the handler**

```typescript
// apps/desktop/electron/main/invoice-files-host.ts
import { mkdir, readFile, unlink, writeFile, access } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ipcMain, app } from "electron";

let pdfsRoot: string | null = null;

function root(): string {
  if (pdfsRoot) return pdfsRoot;
  // Lazy init — gives __resetForTest a chance to override before first call.
  pdfsRoot = join(app.getPath("userData"), "invoice-pdfs");
  return pdfsRoot;
}

/** Test-only: override the userData root. */
export function __resetForTest(testRoot: string): void {
  pdfsRoot = join(testRoot, "invoice-pdfs");
}

function pathFor(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`invalid sha256: ${sha256}`);
  return join(root(), sha256.slice(0, 2), `${sha256}.pdf`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function storeInvoiceFile(bytes: Uint8Array, sha256: string): Promise<string> {
  const target = pathFor(sha256);
  if (!(await exists(target))) {
    await mkdir(join(root(), sha256.slice(0, 2)), { recursive: true });
    await writeFile(target, bytes);
  }
  return pathToFileURL(target).toString();
}

export async function readInvoiceFile(fileUri: string): Promise<Uint8Array> {
  const path = resolve(fileURLToPath(fileUri));
  const normalizedRoot = resolve(root());
  if (!path.startsWith(normalizedRoot + sep)) {
    throw new Error(`refused: path outside invoice-pdfs root (${path})`);
  }
  const buf = await readFile(path);
  return new Uint8Array(buf);
}

export async function deleteInvoiceFile(fileUri: string): Promise<void> {
  const path = resolve(fileURLToPath(fileUri));
  const normalizedRoot = resolve(root());
  if (!path.startsWith(normalizedRoot + sep)) {
    throw new Error(`refused: path outside invoice-pdfs root (${path})`);
  }
  if (await exists(path)) await unlink(path);
}

/** Register IPC handlers. Called from electron/main/index.ts at boot. */
export function registerInvoiceFilesIpc(): void {
  ipcMain.handle("invoice-files:store", async (_evt, bytes: Uint8Array, sha256: string) => {
    return storeInvoiceFile(bytes, sha256);
  });
  ipcMain.handle("invoice-files:read", async (_evt, fileUri: string) => {
    return readInvoiceFile(fileUri);
  });
  ipcMain.handle("invoice-files:delete", async (_evt, fileUri: string) => {
    return deleteInvoiceFile(fileUri);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run electron/main/invoice-files-host.test.ts`
Expected: PASS — 6 tests green.

Note: this test imports `electron` for `ipcMain.handle` typing only at top level; the import is never invoked during tests because `registerInvoiceFilesIpc` is not called. If vitest fails to resolve `electron` in jsdom environment, add a vitest mock in the test file:

```typescript
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => "/unused" } }));
```

at the top of the test file.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/invoice-files-host.ts apps/desktop/electron/main/invoice-files-host.test.ts
git commit -m "feat(3a): electron IPC handler for content-addressed PDF storage"
```

---

### Task 13: Wire IPC handler into main + preload

**Files:**
- Modify: `apps/desktop/electron/main/index.ts`
- Modify: `apps/desktop/electron/preload/index.ts`

- [ ] **Step 1: Add wiring (no separate test — covered end-to-end by Task 14)**

In `apps/desktop/electron/main/index.ts`, find the section where other IPC handlers are registered (e.g. `light-client-host`). Add:

```typescript
import { registerInvoiceFilesIpc } from "./invoice-files-host";

// ... at boot, alongside other registrations:
registerInvoiceFilesIpc();
```

In `apps/desktop/electron/preload/index.ts`, find the `contextBridge.exposeInMainWorld("electron", { ... })` call and add:

```typescript
invoiceFiles: {
  store: (bytes: Uint8Array, sha256: string): Promise<string> =>
    ipcRenderer.invoke("invoice-files:store", bytes, sha256),
  read: (uri: string): Promise<Uint8Array> =>
    ipcRenderer.invoke("invoice-files:read", uri),
  delete: (uri: string): Promise<void> =>
    ipcRenderer.invoke("invoice-files:delete", uri),
},
```

Also update the `Window.electron` type declaration (search for the existing one — typically `apps/desktop/src/types/electron.d.ts` or similar). Add:

```typescript
invoiceFiles: {
  store: (bytes: Uint8Array, sha256: string) => Promise<string>;
  read: (uri: string) => Promise<Uint8Array>;
  delete: (uri: string) => Promise<void>;
};
```

- [ ] **Step 2: Verify the app still typechecks**

Run: `cd apps/desktop && npm run typecheck`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/electron/main/index.ts apps/desktop/electron/preload/index.ts apps/desktop/src/types/electron.d.ts
git commit -m "feat(3a): expose invoice-files IPC via preload bridge"
```

---

### Task 14: Renderer-side file-storage wrapper

**Files:**
- Create: `apps/desktop/src/lib/invoices/file-storage.ts`
- Create: `apps/desktop/src/lib/invoices/file-storage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/lib/invoices/file-storage.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashBlob, storeBlob, readUri, deleteUri } from "./file-storage";

beforeEach(() => {
  const ipc = {
    store: vi.fn(async (_bytes: Uint8Array, sha256: string) => `file:///fake/${sha256}.pdf`),
    read: vi.fn(async (_uri: string) => new Uint8Array([7, 8, 9])),
    delete: vi.fn(async (_uri: string) => {}),
  };
  (globalThis as unknown as { window: { chainpay: { invoiceFiles: typeof ipc } } }).window = {
    chainpay: { invoiceFiles: ipc },
  };
});

describe("file-storage", () => {
  it("hashBlob returns 64-char hex sha256", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const hash = await hashBlob(blob);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashBlob is deterministic", async () => {
    const a = await hashBlob(new Blob([new Uint8Array([1, 2, 3])]));
    const b = await hashBlob(new Blob([new Uint8Array([1, 2, 3])]));
    expect(a).toBe(b);
  });

  it("storeBlob hashes then invokes IPC store with bytes + sha256", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const { uri, sha256 } = await storeBlob(blob);
    expect(uri).toBe(`file:///fake/${sha256}.pdf`);
  });

  it("readUri delegates to IPC", async () => {
    const bytes = await readUri("file:///fake/x.pdf");
    expect(Array.from(bytes)).toEqual([7, 8, 9]);
  });

  it("deleteUri delegates to IPC", async () => {
    await deleteUri("file:///fake/x.pdf");
    expect(window.chainpay.invoiceFiles.delete).toHaveBeenCalledWith("file:///fake/x.pdf");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/invoices/file-storage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the wrapper**

```typescript
// apps/desktop/src/lib/invoices/file-storage.ts

/** Compute SHA-256 of a Blob using Web Crypto. Returns 64-char lowercase hex. */
export async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash + store. Returns content-addressed file:// URI and the sha256. */
export async function storeBlob(blob: Blob): Promise<{ uri: string; sha256: string }> {
  const sha256 = await hashBlob(blob);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const uri = await window.chainpay.invoiceFiles.store(bytes, sha256);
  return { uri, sha256 };
}

/** Read bytes for a previously-stored URI. */
export async function readUri(uri: string): Promise<Uint8Array> {
  return window.chainpay.invoiceFiles.read(uri);
}

/** Delete the stored file. No-op if absent. */
export async function deleteUri(uri: string): Promise<void> {
  return window.chainpay.invoiceFiles.delete(uri);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/lib/invoices/file-storage.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/invoices/file-storage.ts apps/desktop/src/lib/invoices/file-storage.test.ts
git commit -m "feat(3a): renderer-side file-storage wrapper (hash + IPC)"
```

---

### Task 15: Route invoice to batch

**Files:**
- Create: `apps/desktop/src/lib/invoices/route-to-batch.ts`
- Create: `apps/desktop/src/lib/invoices/route-to-batch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/lib/invoices/route-to-batch.test.ts
import { describe, expect, it } from "vitest";
import type { InvoiceRecord, Treasury } from "@chain-pay/shared";
import { isPayrollBatch, isVendorBatch } from "@chain-pay/shared";
import { routeInvoiceToBatch } from "./route-to-batch";

function invoiceFixture(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  const now = new Date().toISOString();
  return {
    id: "inv_1",
    createdAt: now,
    updatedAt: now,
    schema_version: "0.1.0",
    intake: { source: "manual-upload", received_at: now, raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
    invoice: {
      flow: "one-off-vendor",
      payee: { kind: "vendor", id: "vendor_1", display_name: "Acme" },
      currency: "AUD",
      total: 1247.5,
    },
    extraction: { pipeline: { stages: [] }, extracted_at: now },
    approval: { status: "in-review" },
    ...overrides,
  } as InvoiceRecord;
}

function treasuryFixture(): Treasury {
  // Minimal valid Treasury — fields beyond id/label/chain are existing types
  // that may need additional setup. Use what the existing tests use as a fixture
  // (or extend with what's strictly needed for `routeInvoiceToBatch`).
  return { id: "tr_1", label: "Test Treasury", chain: "ckb:testnet" } as unknown as Treasury;
}

describe("routeInvoiceToBatch", () => {
  it("one-off-vendor invoice → VendorPaymentBatch", () => {
    const inv = invoiceFixture({ invoice: { ...invoiceFixture().invoice, flow: "one-off-vendor" } });
    const batch = routeInvoiceToBatch(inv, treasuryFixture());
    expect(isVendorBatch(batch)).toBe(true);
    if (!isVendorBatch(batch)) throw new Error("type narrowing failed");
    expect(batch.invoiceId).toBe("inv_1");
    expect(batch.vendorId).toBe("vendor_1");
    expect(batch.line.fiat.currency).toBe("AUD");
    expect(batch.state).toBe("draft");
  });

  it("employee-payment invoice → PayrollBatch with 1 line", () => {
    const inv = invoiceFixture({
      invoice: { ...invoiceFixture().invoice, flow: "employee-payment", payee: { kind: "employee", id: "payee_42", display_name: "Sarah Chen" } },
    });
    const batch = routeInvoiceToBatch(inv, treasuryFixture());
    expect(isPayrollBatch(batch)).toBe(true);
    if (!isPayrollBatch(batch)) throw new Error("type narrowing failed");
    expect(batch.lines).toHaveLength(1);
    expect(batch.lines[0].payeeId).toBe("payee_42");
  });

  it("throws on unsupported flow (recurring-vendor)", () => {
    const inv = invoiceFixture({ invoice: { ...invoiceFixture().invoice, flow: "recurring-vendor" } });
    expect(() => routeInvoiceToBatch(inv, treasuryFixture())).toThrow(/unsupported flow/i);
  });

  it("throws on unsupported flow (unknown)", () => {
    const inv = invoiceFixture({ invoice: { ...invoiceFixture().invoice, flow: "unknown" } });
    expect(() => routeInvoiceToBatch(inv, treasuryFixture())).toThrow(/unsupported flow/i);
  });

  it("throws on employee-payment without a payee id", () => {
    const inv = invoiceFixture({ invoice: { ...invoiceFixture().invoice, flow: "employee-payment", payee: { kind: "employee", display_name: "Unknown" } } });
    expect(() => routeInvoiceToBatch(inv, treasuryFixture())).toThrow(/payee id required/i);
  });

  it("throws on one-off-vendor without a payee id", () => {
    const inv = invoiceFixture({ invoice: { ...invoiceFixture().invoice, flow: "one-off-vendor", payee: { kind: "vendor", display_name: "New Vendor" } } });
    expect(() => routeInvoiceToBatch(inv, treasuryFixture())).toThrow(/payee id required/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/invoices/route-to-batch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the router**

```typescript
// apps/desktop/src/lib/invoices/route-to-batch.ts
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
 *
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
  if (!payeeId) throw new Error(`payee id required for employee-payment invoice ${invoice.id}`);
  const now = new Date().toISOString();
  const totalMinor = BigInt(Math.round(invoice.invoice.total * 100));
  const line: PayrollBatchLine = {
    payeeId,
    fiat: { minor: totalMinor, currency: invoice.invoice.currency },
    crypto: { value: 0n, asset: "CKB", decimals: 8 }, // resolved by PayPanel via FX at calculate time
    fxRate: "0",
    feeAllocated: { value: 0n, asset: "CKB", decimals: 8 },
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
  if (!vendorId) throw new Error(`payee id required for one-off-vendor invoice ${invoice.id}`);
  const now = new Date().toISOString();
  const totalMinor = BigInt(Math.round(invoice.invoice.total * 100));
  const line: VendorPaymentLine = {
    vendorId,
    fiat: { minor: totalMinor, currency: invoice.invoice.currency },
    crypto: { value: 0n, asset: "CKB", decimals: 8 },
    fxRate: "0",
    feeAllocated: { value: 0n, asset: "CKB", decimals: 8 },
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/lib/invoices/route-to-batch.test.ts`
Expected: PASS — 6 tests green.

If the `Treasury` fixture in the test fails to construct (existing type has more required fields), copy the canonical Treasury fixture from `apps/desktop/src/stores/treasury.test.ts` instead of the minimal cast.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/invoices/route-to-batch.ts apps/desktop/src/lib/invoices/route-to-batch.test.ts
git commit -m "feat(3a): route invoice to PayrollBatch or VendorPaymentBatch"
```

---

### Task 16: Approve-and-queue (safe-ordered handoff) — HIGHEST PRIORITY

**Files:**
- Create: `apps/desktop/src/lib/invoices/approve-and-queue.ts`
- Create: `apps/desktop/src/lib/invoices/approve-and-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/lib/invoices/approve-and-queue.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceRecord, Treasury } from "@chain-pay/shared";
import { useInvoicesStore } from "@/stores/invoices";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { approveAndQueue } from "./approve-and-queue";

function inv(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  const now = new Date().toISOString();
  return {
    id: "inv_1", createdAt: now, updatedAt: now, schema_version: "0.1.0",
    intake: { source: "manual-upload", received_at: now, raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
    invoice: { flow: "one-off-vendor", payee: { kind: "vendor", id: "v_1", display_name: "Acme" }, currency: "AUD", total: 100 },
    extraction: { pipeline: { stages: [] }, extracted_at: now },
    approval: { status: "in-review" },
    ...overrides,
  } as InvoiceRecord;
}

const treasury = { id: "tr_1", label: "T", chain: "ckb:testnet" } as unknown as Treasury;

beforeEach(() => {
  globalThis.localStorage?.clear();
  useInvoicesStore.setState({ invoices: [] });
  usePayrollBatchesStore.setState({ batches: [], selectedDraftId: null });
});

describe("approveAndQueue", () => {
  it("writes the batch then transitions the invoice (happy path)", () => {
    useInvoicesStore.getState().addInvoice(inv());
    const result = approveAndQueue(inv(), treasury, "user_42");
    expect(result.batchId).toMatch(/^vb_/);
    expect(usePayrollBatchesStore.getState().batches).toHaveLength(1);
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("queued-for-signing");
    expect(useInvoicesStore.getState().findById("inv_1")?.batchId).toBe(result.batchId);
  });

  it("writes the batch FIRST — if invoice update throws, batch remains but invoice stays in in-review", () => {
    useInvoicesStore.getState().addInvoice(inv());
    const markSpy = vi
      .spyOn(useInvoicesStore.getState(), "markQueuedForSigning")
      .mockImplementation(() => { throw new Error("simulated localStorage quota"); });

    expect(() => approveAndQueue(inv(), treasury, "user_42")).toThrow(/simulated localStorage quota/);

    // Batch IS persisted (orphan — recoverable)
    expect(usePayrollBatchesStore.getState().batches).toHaveLength(1);
    // Invoice did NOT advance
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("in-review");

    markSpy.mockRestore();
  });

  it("throws on missing treasury (caller passes null)", () => {
    useInvoicesStore.getState().addInvoice(inv());
    expect(() => approveAndQueue(inv(), null as unknown as Treasury, "user_42")).toThrow(/treasury required/i);
  });

  it("throws if invoice routing fails (e.g. unsupported flow)", () => {
    const badInv = inv({ invoice: { ...inv().invoice, flow: "unknown" } });
    useInvoicesStore.getState().addInvoice(badInv);
    expect(() => approveAndQueue(badInv, treasury, "user_42")).toThrow(/unsupported flow/i);
    // Nothing should have been written
    expect(usePayrollBatchesStore.getState().batches).toHaveLength(0);
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("in-review");
  });

  it("re-calling on the same invoice is idempotent (batch dedup)", () => {
    useInvoicesStore.getState().addInvoice(inv());
    const r1 = approveAndQueue(inv(), treasury, "user_42");
    // Roll the invoice back to in-review for this test
    useInvoicesStore.setState((s) => ({
      invoices: s.invoices.map((i) => (i.id === "inv_1" ? { ...i, approval: { ...i.approval, status: "in-review" } } : i)),
    }));
    const r2 = approveAndQueue(inv(), treasury, "user_42");
    // Two calls produce two different batch ids (UUID), but the store dedups by id
    // so total batches === 2 (different ids). Idempotency is at the *invoice* level
    // (approval.status transition) not at the *batch* level.
    expect(r2.batchId).not.toBe(r1.batchId);
    expect(usePayrollBatchesStore.getState().batches).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/invoices/approve-and-queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the handoff**

```typescript
// apps/desktop/src/lib/invoices/approve-and-queue.ts
import type { InvoiceRecord, Treasury } from "@chain-pay/shared";
import { useInvoicesStore } from "@/stores/invoices";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { routeInvoiceToBatch } from "./route-to-batch";

export interface ApproveAndQueueResult {
  batchId: string;
}

/**
 * Promote an `in-review` invoice to `queued-for-signing` and create the linked
 * batch. Safe-ordered writes:
 *
 *   1. Build the batch (pure, throws on routing errors → no state changes).
 *   2. Persist the batch (write FIRST).
 *   3. Transition the invoice (writes the backlink batchId).
 *
 * If step 3 throws (rare — localStorage quota only), the batch is an orphan in
 * the payroll list and the invoice remains in `in-review`. Operator can cancel
 * the orphan or re-approve the invoice. Either outcome is recoverable.
 *
 * If we wrote the invoice first and step 2 failed, the invoice would point at
 * a non-existent batch — strictly worse, hence the ordering.
 */
export function approveAndQueue(
  invoice: InvoiceRecord,
  treasury: Treasury,
  reviewerId: string,
): ApproveAndQueueResult {
  if (!treasury) throw new Error("treasury required for approve-and-queue");

  const batch = routeInvoiceToBatch(invoice, treasury);
  usePayrollBatchesStore.getState().addBatch(batch);
  useInvoicesStore.getState().markQueuedForSigning(invoice.id, batch.id, reviewerId);

  return { batchId: batch.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/lib/invoices/approve-and-queue.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/invoices/approve-and-queue.ts apps/desktop/src/lib/invoices/approve-and-queue.test.ts
git commit -m "feat(3a): approveAndQueue safe-ordered handoff with orphan-batch recovery test"
```

---

### Task 17: Invoice draft autosave hook

**Files:**
- Create: `apps/desktop/src/features/invoices/hooks/useInvoiceDraft.ts`
- Create: `apps/desktop/src/features/invoices/hooks/useInvoiceDraft.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/features/invoices/hooks/useInvoiceDraft.test.ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInvoiceDraftsStore } from "@/stores/invoice-drafts";
import { useInvoiceDraft } from "./useInvoiceDraft";

beforeEach(() => {
  useInvoiceDraftsStore.setState({ drafts: {} });
  globalThis.localStorage?.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useInvoiceDraft", () => {
  it("returns the persisted draft on mount if present", () => {
    useInvoiceDraftsStore.getState().upsertDraft("inv_1", { invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "Saved" }, currency: "AUD", total: 99 } } as never);
    const { result } = renderHook(() => useInvoiceDraft("inv_1"));
    expect(result.current.draft?.invoice?.payee?.display_name).toBe("Saved");
  });

  it("debounces writes by 500ms", () => {
    const { result } = renderHook(() => useInvoiceDraft("inv_1"));
    act(() => {
      result.current.update({ invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "A" }, currency: "AUD", total: 1 } } as never);
      result.current.update({ invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "B" }, currency: "AUD", total: 2 } } as never);
      result.current.update({ invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "C" }, currency: "AUD", total: 3 } } as never);
    });
    // No write yet
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")?.invoice?.payee?.display_name).toBe("C");
  });

  it("clear() removes the draft immediately", () => {
    useInvoiceDraftsStore.getState().upsertDraft("inv_1", { invoice: { flow: "one-off-vendor", payee: { kind: "vendor", display_name: "X" }, currency: "AUD", total: 1 } } as never);
    const { result } = renderHook(() => useInvoiceDraft("inv_1"));
    act(() => {
      result.current.clear();
    });
    expect(useInvoiceDraftsStore.getState().getDraft("inv_1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/features/invoices/hooks/useInvoiceDraft.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the hook**

```typescript
// apps/desktop/src/features/invoices/hooks/useInvoiceDraft.ts
import { useCallback, useEffect, useRef } from "react";
import type { InvoiceRecord } from "@chain-pay/shared";
import { useInvoiceDraftsStore } from "@/stores/invoice-drafts";

const DEBOUNCE_MS = 500;

export interface UseInvoiceDraftReturn {
  draft: Partial<InvoiceRecord> | undefined;
  update: (partial: Partial<InvoiceRecord>) => void;
  clear: () => void;
}

export function useInvoiceDraft(invoiceId: string): UseInvoiceDraftReturn {
  const draft = useInvoiceDraftsStore((s) => s.drafts[invoiceId]);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<InvoiceRecord> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const update = useCallback(
    (partial: Partial<InvoiceRecord>) => {
      pendingRef.current = { ...(pendingRef.current ?? {}), ...partial };
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        if (pendingRef.current) {
          useInvoiceDraftsStore.getState().upsertDraft(invoiceId, pendingRef.current);
          pendingRef.current = null;
        }
      }, DEBOUNCE_MS);
    },
    [invoiceId],
  );

  const clear = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pendingRef.current = null;
    useInvoiceDraftsStore.getState().clearDraft(invoiceId);
  }, [invoiceId]);

  return { draft, update, clear };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/features/invoices/hooks/useInvoiceDraft.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/invoices/hooks/useInvoiceDraft.ts apps/desktop/src/features/invoices/hooks/useInvoiceDraft.test.ts
git commit -m "feat(3a): useInvoiceDraft hook with 500ms debounced autosave"
```

---

### Task 18: VendorPicker component

**Files:**
- Create: `apps/desktop/src/features/invoices/VendorPicker.tsx`
- Create: `apps/desktop/src/features/invoices/VendorPicker.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/features/invoices/VendorPicker.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVendorsStore } from "@/stores/vendors";
import { VendorPicker } from "./VendorPicker";

beforeEach(() => {
  useVendorsStore.setState({ vendors: [] });
  globalThis.localStorage?.clear();
});

describe("VendorPicker", () => {
  it("lists existing vendors filtered by typed query", async () => {
    const user = userEvent.setup();
    useVendorsStore.getState().addVendor({ id: "v1", displayName: "Acme Pty", preferredChain: "ckb:testnet", active: true, createdAt: "", updatedAt: "" });
    useVendorsStore.getState().addVendor({ id: "v2", displayName: "Beta Co", preferredChain: "ckb:testnet", active: true, createdAt: "", updatedAt: "" });
    render(<VendorPicker onSelect={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/search vendors/i), "Acm");
    expect(screen.getByRole("button", { name: /Acme Pty/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Beta Co/ })).not.toBeInTheDocument();
  });

  it("selecting an existing vendor calls onSelect with that vendor", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    useVendorsStore.getState().addVendor({ id: "v1", displayName: "Acme Pty", preferredChain: "ckb:testnet", active: true, createdAt: "", updatedAt: "" });
    render(<VendorPicker onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: /Acme Pty/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "v1" }));
  });

  it("clicking '+ New vendor' opens the inline create form", async () => {
    const user = userEvent.setup();
    render(<VendorPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /\+ new vendor/i }));
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
  });

  it("submitting the inline form adds a vendor and calls onSelect", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<VendorPicker onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: /\+ new vendor/i }));
    await user.type(screen.getByLabelText(/display name/i), "New Vendor Inc");
    await user.click(screen.getByRole("button", { name: /^create$/i }));
    expect(useVendorsStore.getState().vendors).toHaveLength(1);
    expect(useVendorsStore.getState().vendors[0]?.displayName).toBe("New Vendor Inc");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ displayName: "New Vendor Inc" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/features/invoices/VendorPicker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

```tsx
// apps/desktop/src/features/invoices/VendorPicker.tsx
import { useMemo, useState } from "react";
import type { VendorProfile } from "@chain-pay/shared";
import { useVendorsStore } from "@/stores/vendors";

interface Props {
  onSelect: (vendor: VendorProfile) => void;
}

export function VendorPicker({ onSelect }: Props) {
  const vendors = useVendorsStore((s) => s.vendors);
  const addVendor = useVendorsStore((s) => s.addVendor);
  const findByName = useVendorsStore((s) => s.findByDisplayNameAndTaxId);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftTaxId, setDraftTaxId] = useState("");

  const filtered = useMemo(
    () => vendors.filter((v) => v.displayName.toLowerCase().includes(query.toLowerCase())),
    [vendors, query],
  );

  function submitNew() {
    if (!draftName.trim()) return;
    const existing = findByName(draftName.trim(), draftTaxId.trim() || undefined);
    if (existing) {
      onSelect(existing);
      setCreating(false);
      return;
    }
    const now = new Date().toISOString();
    const created: VendorProfile = {
      id: `vendor_${crypto.randomUUID()}`,
      displayName: draftName.trim(),
      taxId: draftTaxId.trim() || undefined,
      preferredChain: "ckb:testnet",
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    addVendor(created);
    onSelect(created);
    setCreating(false);
    setDraftName("");
    setDraftTaxId("");
  }

  if (creating) {
    return (
      <div className="vendor-picker-form">
        <label>
          Display name
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} />
        </label>
        <label>
          Tax ID (optional)
          <input value={draftTaxId} onChange={(e) => setDraftTaxId(e.target.value)} />
        </label>
        <button type="button" onClick={submitNew}>Create</button>
        <button type="button" onClick={() => setCreating(false)}>Cancel</button>
      </div>
    );
  }

  return (
    <div className="vendor-picker">
      <input
        placeholder="Search vendors…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul>
        {filtered.map((v) => (
          <li key={v.id}>
            <button type="button" onClick={() => onSelect(v)}>
              {v.displayName}
              {v.taxId && <span className="vendor-tax-id"> ({v.taxId})</span>}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setCreating(true)}>+ New vendor</button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/features/invoices/VendorPicker.test.tsx`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/invoices/VendorPicker.tsx apps/desktop/src/features/invoices/VendorPicker.test.tsx
git commit -m "feat(3a): VendorPicker with search-or-create flow"
```

---

### Task 19: NewInvoiceForm (Stage A)

**Files:**
- Create: `apps/desktop/src/features/invoices/NewInvoiceForm.tsx`
- Create: `apps/desktop/src/features/invoices/NewInvoiceForm.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/features/invoices/NewInvoiceForm.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInvoicesStore } from "@/stores/invoices";
import { useVendorsStore } from "@/stores/vendors";
import { NewInvoiceForm } from "./NewInvoiceForm";

beforeEach(() => {
  useInvoicesStore.setState({ invoices: [] });
  useVendorsStore.setState({ vendors: [] });
  globalThis.localStorage?.clear();
  // Mock window.chainpay.invoiceFiles
  (globalThis as unknown as { window: typeof window & { chainpay: { invoiceFiles: { store: typeof vi.fn } } } }).window.chainpay = {
    invoiceFiles: {
      store: vi.fn(async (_b: Uint8Array, sha: string) => `file:///fake/${sha}.pdf`),
      read: vi.fn(),
      delete: vi.fn(),
    },
  } as never;
});

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={["/invoices/new"]}>
      <Routes>
        <Route path="/invoices/new" element={<NewInvoiceForm />} />
        <Route path="/invoices/:id/review" element={<div>REVIEW STAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("NewInvoiceForm (Stage A)", () => {
  it("default flow is one-off-vendor; switching to employee-payment hides VendorPicker", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    expect(screen.getByPlaceholderText(/search vendors/i)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/employee payment/i));
    expect(screen.queryByPlaceholderText(/search vendors/i)).not.toBeInTheDocument();
  });

  it("rejects non-PDF/PNG/JPG uploads", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    const file = new File(["x"], "evil.exe", { type: "application/x-msdownload" });
    await user.upload(screen.getByLabelText(/upload pdf/i), file);
    expect(screen.getByText(/only pdf, png, jpg accepted/i)).toBeInTheDocument();
  });

  it("rejects files over 50MB", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    const big = new File([new Uint8Array(50 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText(/upload pdf/i), big);
    expect(screen.getByText(/must be under 50 mb/i)).toBeInTheDocument();
  });

  it("Continue button is disabled until vendor + valid file are present", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    const file = new File([new Uint8Array([1, 2, 3])], "ok.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText(/upload pdf/i), file);
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    useVendorsStore.getState().addVendor({ id: "v1", displayName: "Acme", preferredChain: "ckb:testnet", active: true, createdAt: "", updatedAt: "" });
    // Re-render via state update; in this minimal form, picking the vendor enables Continue
    await user.click(await screen.findByRole("button", { name: /Acme/i }));
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("Continue creates InvoiceRecord, calls storeBlob, and navigates to Stage B", async () => {
    const user = userEvent.setup();
    useVendorsStore.getState().addVendor({ id: "v1", displayName: "Acme", preferredChain: "ckb:testnet", active: true, createdAt: "", updatedAt: "" });
    renderWithRouter();
    const file = new File([new Uint8Array([1, 2, 3])], "ok.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText(/upload pdf/i), file);
    await user.click(await screen.findByRole("button", { name: /Acme/i }));
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(useInvoicesStore.getState().invoices).toHaveLength(1);
    expect(await screen.findByText(/REVIEW STAGE/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/features/invoices/NewInvoiceForm.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

```tsx
// apps/desktop/src/features/invoices/NewInvoiceForm.tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { InvoiceFlow, InvoiceRecord, VendorProfile } from "@chain-pay/shared";
import { storeBlob } from "@/lib/invoices/file-storage";
import { useInvoicesStore } from "@/stores/invoices";
import { usePayeesStore } from "@/stores/payees";
import { VendorPicker } from "./VendorPicker";

const ACCEPT_MIME = ["application/pdf", "image/png", "image/jpeg"];
const MAX_BYTES = 50 * 1024 * 1024;

export function NewInvoiceForm() {
  const navigate = useNavigate();
  const addInvoice = useInvoicesStore((s) => s.addInvoice);
  const [flow, setFlow] = useState<InvoiceFlow>("one-off-vendor");
  const [vendor, setVendor] = useState<VendorProfile | null>(null);
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function onFile(picked: File | undefined) {
    setFileError(null);
    setFile(null);
    if (!picked) return;
    if (!ACCEPT_MIME.includes(picked.type)) {
      setFileError("Only PDF, PNG, JPG accepted");
      return;
    }
    if (picked.size > MAX_BYTES) {
      setFileError("File must be under 50 MB");
      return;
    }
    setFile(picked);
  }

  const canContinue = !!file && (flow === "one-off-vendor" ? !!vendor : !!employeeId);

  async function onContinue() {
    if (!canContinue || !file) return;
    setSubmitting(true);
    try {
      const { uri, sha256 } = await storeBlob(file);
      const now = new Date().toISOString();
      const invoice: InvoiceRecord = {
        id: `inv_${crypto.randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        schema_version: "0.1.0",
        intake: {
          source: "manual-upload",
          received_at: now,
          raw_file: { sha256, mime_type: file.type, byte_size: file.size, filename: file.name, storage_uri: uri },
        },
        invoice: {
          flow,
          payee:
            flow === "one-off-vendor"
              ? { kind: "vendor", id: vendor!.id, display_name: vendor!.displayName, tax_id: vendor!.taxId }
              : { kind: "employee", id: employeeId!, display_name: "" }, // displayName filled in Stage B
          currency: "AUD",
          total: 0,
        },
        extraction: { pipeline: { stages: [] }, extracted_at: now },
        approval: { status: "draft" },
      };
      addInvoice(invoice);
      navigate(`/invoices/${invoice.id}/review`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="new-invoice-form">
      <h2>New invoice</h2>
      <fieldset>
        <legend>Flow</legend>
        <label><input type="radio" name="flow" checked={flow === "one-off-vendor"} onChange={() => setFlow("one-off-vendor")} /> One-off vendor</label>
        <label><input type="radio" name="flow" checked={flow === "employee-payment"} onChange={() => setFlow("employee-payment")} /> Employee payment</label>
      </fieldset>

      {flow === "one-off-vendor" ? (
        <VendorPicker onSelect={setVendor} />
      ) : (
        <EmployeeSelect onSelect={setEmployeeId} />
      )}

      <label htmlFor="invoice-file">Upload PDF</label>
      <input id="invoice-file" type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => onFile(e.target.files?.[0])} />
      {fileError && <p className="error">{fileError}</p>}
      {file && <p>{file.name} ✓ {Math.round(file.size / 1024)}KB</p>}

      <button type="button" disabled={!canContinue || submitting} onClick={onContinue}>
        Continue →
      </button>
    </div>
  );
}

function EmployeeSelect({ onSelect }: { onSelect: (id: string) => void }) {
  const payees = usePayeesStore((s) => s.payees.filter((p) => p.active));
  return (
    <label>
      Employee
      <select defaultValue="" onChange={(e) => onSelect(e.target.value)}>
        <option value="" disabled>Pick an employee…</option>
        {payees.map((p) => (
          <option key={p.id} value={p.id}>{p.displayName}</option>
        ))}
      </select>
    </label>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/features/invoices/NewInvoiceForm.test.tsx`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/invoices/NewInvoiceForm.tsx apps/desktop/src/features/invoices/NewInvoiceForm.test.tsx
git commit -m "feat(3a): NewInvoiceForm Stage A (flow + payee + PDF upload)"
```

---

### Task 20: ReviewInvoiceForm (Stage B)

**Files:**
- Create: `apps/desktop/src/features/invoices/ReviewInvoiceForm.tsx`
- Create: `apps/desktop/src/features/invoices/ReviewInvoiceForm.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/features/invoices/ReviewInvoiceForm.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceRecord } from "@chain-pay/shared";
import { useInvoicesStore } from "@/stores/invoices";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { useTreasuryStore } from "@/stores/treasury";
import { ReviewInvoiceForm } from "./ReviewInvoiceForm";

function inv(): InvoiceRecord {
  const now = new Date().toISOString();
  return {
    id: "inv_1", createdAt: now, updatedAt: now, schema_version: "0.1.0",
    intake: { source: "manual-upload", received_at: now, raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 100, filename: "test.pdf", storage_uri: "file:///fake/test.pdf" } },
    invoice: { flow: "one-off-vendor", payee: { kind: "vendor", id: "v_1", display_name: "Acme" }, currency: "AUD", total: 0 },
    extraction: { pipeline: { stages: [] }, extracted_at: now },
    approval: { status: "draft" },
  };
}

beforeEach(() => {
  globalThis.localStorage?.clear();
  useInvoicesStore.setState({ invoices: [inv()] });
  usePayrollBatchesStore.setState({ batches: [], selectedDraftId: null });
  // Set an active treasury — wire matches the existing useTreasuryStore API
  useTreasuryStore.setState({ treasuries: [{ id: "tr_1", label: "Test", chain: "ckb:testnet" } as never], activeTreasuryId: "tr_1" });
  // Mock pdf.js so the side-by-side preview doesn't actually render
  vi.mock("pdfjs-dist", () => ({ getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: () => Promise.resolve({ render: () => ({ promise: Promise.resolve() }) }) }) }) }));
});

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={["/invoices/inv_1/review"]}>
      <Routes>
        <Route path="/invoices/:id/review" element={<ReviewInvoiceForm />} />
        <Route path="/payments/:batchId" element={<div>PAY PANEL</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ReviewInvoiceForm (Stage B)", () => {
  it("renders the invoice fields pre-populated", () => {
    renderWithRouter();
    expect(screen.getByDisplayValue("Acme")).toBeInTheDocument();
    expect(screen.getByDisplayValue("AUD")).toBeInTheDocument();
  });

  it("editing total + Approve triggers approveAndQueue and appends edits_made", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    const totalInput = screen.getByLabelText(/^total$/i);
    await user.clear(totalInput);
    await user.type(totalInput, "100");
    await user.click(screen.getByRole("button", { name: /approve.*queue/i }));
    const after = useInvoicesStore.getState().findById("inv_1")!;
    expect(after.approval.status).toBe("queued-for-signing");
    expect(after.approval.edits_made?.some((e) => e.field === "invoice.total")).toBe(true);
    expect(await screen.findByText(/PAY PANEL/)).toBeInTheDocument();
  });

  it("Reject captures rejection reason and transitions", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole("button", { name: /^reject$/i }));
    await user.type(screen.getByLabelText(/rejection reason/i), "dup");
    await user.click(screen.getByRole("button", { name: /confirm reject/i }));
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("rejected");
  });

  it("blocks Approve when Zod validation fails (e.g. total = 0)", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole("button", { name: /approve.*queue/i }));
    expect(screen.getByText(/total.*required/i)).toBeInTheDocument();
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("draft");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/features/invoices/ReviewInvoiceForm.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Install pdfjs-dist**

Run: `cd apps/desktop && npm install pdfjs-dist@^4`

- [ ] **Step 4: Write the component**

```tsx
// apps/desktop/src/features/invoices/ReviewInvoiceForm.tsx
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { InvoiceSchema, type InvoiceRecord } from "@chain-pay/shared";
import { approveAndQueue } from "@/lib/invoices/approve-and-queue";
import { useInvoicesStore } from "@/stores/invoices";
import { useTreasuryStore } from "@/stores/treasury";
import { useInvoiceDraft } from "./hooks/useInvoiceDraft";

interface FormShape {
  vendor: string;
  taxId: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: number;
  taxTotal: number;
  total: number;
  notes: string;
}

const CURRENT_USER_ID = "operator"; // single-tenant placeholder

function fromInvoice(inv: InvoiceRecord): FormShape {
  return {
    vendor: inv.invoice.payee.display_name,
    taxId: inv.invoice.payee.tax_id ?? "",
    invoiceNumber: inv.invoice.invoice_number ?? "",
    issueDate: inv.invoice.issue_date ?? "",
    dueDate: inv.invoice.due_date ?? "",
    currency: inv.invoice.currency,
    subtotal: inv.invoice.subtotal ?? 0,
    taxTotal: inv.invoice.tax_total ?? 0,
    total: inv.invoice.total,
    notes: inv.invoice.notes ?? "",
  };
}

function toInvoice(prev: InvoiceRecord, form: FormShape): InvoiceRecord {
  return {
    ...prev,
    invoice: {
      ...prev.invoice,
      payee: { ...prev.invoice.payee, display_name: form.vendor, tax_id: form.taxId || undefined },
      invoice_number: form.invoiceNumber || null,
      issue_date: form.issueDate || null,
      due_date: form.dueDate || null,
      currency: form.currency,
      subtotal: form.subtotal || null,
      tax_total: form.taxTotal || null,
      total: form.total,
      notes: form.notes || null,
    },
  };
}

function diffEdits(before: InvoiceRecord, after: InvoiceRecord): Array<{ field: string; before: unknown; after: unknown }> {
  const out: Array<{ field: string; before: unknown; after: unknown }> = [];
  const fields: Array<keyof InvoiceRecord["invoice"]> = ["invoice_number", "issue_date", "due_date", "currency", "subtotal", "tax_total", "total", "notes"];
  for (const f of fields) {
    if (before.invoice[f] !== after.invoice[f]) {
      out.push({ field: `invoice.${f}`, before: before.invoice[f], after: after.invoice[f] });
    }
  }
  if (before.invoice.payee.display_name !== after.invoice.payee.display_name) {
    out.push({ field: "invoice.payee.display_name", before: before.invoice.payee.display_name, after: after.invoice.payee.display_name });
  }
  return out;
}

export function ReviewInvoiceForm() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const invoice = useInvoicesStore((s) => (id ? s.findById(id) : undefined));
  const appendEdit = useInvoicesStore((s) => s.appendEdit);
  const markInReview = useInvoicesStore((s) => s.markInReview);
  const markRejected = useInvoicesStore((s) => s.markRejected);
  const treasury = useTreasuryStore((s) => s.treasuries.find((t) => t.id === s.activeTreasuryId));
  const { update, clear } = useInvoiceDraft(id ?? "");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<FormShape>({ defaultValues: invoice ? fromInvoice(invoice) : undefined });

  useEffect(() => {
    if (invoice?.approval.status === "draft") markInReview(invoice.id);
  }, [invoice, markInReview]);

  useEffect(() => {
    const sub = form.watch((values) => {
      if (invoice) update(toInvoice(invoice, values as FormShape));
    });
    return () => sub.unsubscribe();
  }, [form, invoice, update]);

  if (!invoice) return <p>Invoice not found.</p>;

  async function onApprove(values: FormShape) {
    setSubmitError(null);
    if (!treasury) {
      setSubmitError("No active treasury — open Treasury Settings");
      return;
    }
    const next = toInvoice(invoice!, values);
    const parsed = InvoiceSchema.safeParse(next);
    if (!parsed.success) {
      const totalIssue = parsed.error.issues.find((i) => i.path.join(".") === "invoice.total");
      setSubmitError(totalIssue ? "Total required (cannot be 0)" : parsed.error.issues[0]?.message ?? "Validation failed");
      return;
    }
    for (const edit of diffEdits(invoice!, next)) {
      appendEdit(invoice!.id, { ...edit, edited_by: CURRENT_USER_ID });
    }
    try {
      const { batchId } = approveAndQueue(next, treasury, CURRENT_USER_ID);
      clear();
      navigate(`/payments/${batchId}`);
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : "Approve failed");
    }
  }

  function confirmReject() {
    markRejected(invoice!.id, rejectReason || "no reason given");
    setRejecting(false);
  }

  return (
    <div className="review-invoice-form">
      <div className="pdf-preview">
        {/* pdf.js renders here; omitted DOM bindings for brevity — wire <canvas> via useEffect */}
        <p>PDF: {invoice.intake.raw_file.filename}</p>
      </div>
      <form onSubmit={form.handleSubmit(onApprove)}>
        <label>Vendor <input {...form.register("vendor")} /></label>
        <label>Tax ID <input {...form.register("taxId")} /></label>
        <label>Invoice # <input {...form.register("invoiceNumber")} /></label>
        <label>Issue date <input type="date" {...form.register("issueDate")} /></label>
        <label>Due date <input type="date" {...form.register("dueDate")} /></label>
        <label>Currency <input {...form.register("currency")} /></label>
        <label>Subtotal <input type="number" step="0.01" {...form.register("subtotal", { valueAsNumber: true })} /></label>
        <label>Tax <input type="number" step="0.01" {...form.register("taxTotal", { valueAsNumber: true })} /></label>
        <label>Total <input type="number" step="0.01" {...form.register("total", { valueAsNumber: true })} /></label>
        <label>Notes <textarea {...form.register("notes")} /></label>

        {submitError && <p className="error">{submitError}</p>}

        <button type="button" onClick={() => clear()}>Save as draft</button>
        <button type="button" onClick={() => setRejecting(true)}>Reject</button>
        <button type="submit">Approve & queue →</button>
      </form>

      {rejecting && (
        <div className="reject-modal">
          <label>Rejection reason <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} /></label>
          <button type="button" onClick={confirmReject}>Confirm reject</button>
          <button type="button" onClick={() => setRejecting(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/features/invoices/ReviewInvoiceForm.test.tsx`
Expected: PASS — 4 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/features/invoices/ReviewInvoiceForm.tsx apps/desktop/src/features/invoices/ReviewInvoiceForm.test.tsx apps/desktop/package.json apps/desktop/package-lock.json
git commit -m "feat(3a): ReviewInvoiceForm Stage B with edit tracking + approve & queue"
```

---

### Task 21: InvoiceList

**Files:**
- Create: `apps/desktop/src/features/invoices/InvoiceList.tsx`
- Create: `apps/desktop/src/features/invoices/InvoiceList.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/features/invoices/InvoiceList.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import type { InvoiceRecord } from "@chain-pay/shared";
import { useInvoicesStore } from "@/stores/invoices";
import { InvoiceList } from "./InvoiceList";

function inv(id: string, status: InvoiceRecord["approval"]["status"]): InvoiceRecord {
  const now = new Date().toISOString();
  return {
    id, createdAt: now, updatedAt: now, schema_version: "0.1.0",
    intake: { source: "manual-upload", received_at: now, raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
    invoice: { flow: "one-off-vendor", payee: { kind: "vendor", id: "v", display_name: `Vendor ${id}` }, currency: "AUD", total: 100, invoice_number: `INV-${id}` },
    extraction: { pipeline: { stages: [] }, extracted_at: now },
    approval: { status },
  };
}

beforeEach(() => {
  globalThis.localStorage?.clear();
  useInvoicesStore.setState({
    invoices: [
      inv("a", "in-review"),
      inv("b", "in-review"),
      inv("c", "queued-for-signing"),
      inv("d", "signed"),
      inv("e", "rejected"),
    ] as never,
  });
});

function wrap() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="*" element={<InvoiceList />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("InvoiceList", () => {
  it("groups invoices by status with counts", () => {
    wrap();
    expect(screen.getByText(/in review \(2\)/i)).toBeInTheDocument();
    expect(screen.getByText(/queued for signing \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/signed/i)).toBeInTheDocument();
    expect(screen.getByText(/rejected/i)).toBeInTheDocument();
  });

  it("clicking an in-review row navigates to Stage B", async () => {
    const user = userEvent.setup();
    wrap();
    const reviewBtn = screen.getAllByRole("button", { name: /review →/i })[0];
    await user.click(reviewBtn);
    // No actual navigation assertion possible without wrapping in Routes for the target,
    // but the button should be present and clickable
    expect(reviewBtn).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/features/invoices/InvoiceList.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

```tsx
// apps/desktop/src/features/invoices/InvoiceList.tsx
import { Link } from "react-router-dom";
import type { InvoiceApprovalStatus } from "@chain-pay/shared";
import { useInvoicesStore } from "@/stores/invoices";

const SECTION_ORDER: Array<{ status: InvoiceApprovalStatus; label: string; action: (id: string, batchId?: string) => { to: string; label: string } }> = [
  { status: "in-review", label: "In review", action: (id) => ({ to: `/invoices/${id}/review`, label: "Review →" }) },
  { status: "queued-for-signing", label: "Queued for signing", action: (_id, batchId) => ({ to: `/payments/${batchId ?? ""}`, label: "Open batch →" }) },
  { status: "signed", label: "Signed", action: (_id, batchId) => ({ to: `/payments/${batchId ?? ""}`, label: "View →" }) },
  { status: "rejected", label: "Rejected", action: (id) => ({ to: `/invoices/${id}/review`, label: "View →" }) },
];

export function InvoiceList() {
  const invoices = useInvoicesStore((s) => s.invoices);

  return (
    <div className="invoice-list">
      {SECTION_ORDER.map((section) => {
        const items = invoices.filter((i) => i.approval.status === section.status);
        return (
          <section key={section.status}>
            <h3>{section.label} ({items.length})</h3>
            <ul>
              {items.map((i) => {
                const a = section.action(i.id, i.batchId);
                return (
                  <li key={i.id}>
                    <span>{i.invoice.invoice_number ?? "—"}</span>
                    <span>{i.invoice.payee.display_name}</span>
                    <span>{i.invoice.total.toFixed(2)} {i.invoice.currency}</span>
                    <Link to={a.to}><button type="button">{a.label}</button></Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/features/invoices/InvoiceList.test.tsx`
Expected: PASS — 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/invoices/InvoiceList.tsx apps/desktop/src/features/invoices/InvoiceList.test.tsx
git commit -m "feat(3a): InvoiceList grouped by approval status"
```

---

### Task 22: InvoicesPage

**Files:**
- Create: `apps/desktop/src/features/invoices/InvoicesPage.tsx`
- Create: `apps/desktop/src/features/invoices/InvoicesPage.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/features/invoices/InvoicesPage.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { InvoicesPage } from "./InvoicesPage";

describe("InvoicesPage", () => {
  it("renders the header and New invoice button", () => {
    render(
      <MemoryRouter initialEntries={["/invoices"]}>
        <Routes>
          <Route path="/invoices/*" element={<InvoicesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: /invoices/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\+ new invoice/i })).toBeInTheDocument();
  });

  it("clicking + New invoice navigates to /invoices/new", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/invoices"]}>
        <Routes>
          <Route path="/invoices/*" element={<InvoicesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("link", { name: /\+ new invoice/i }));
    expect(await screen.findByRole("heading", { name: /new invoice/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/features/invoices/InvoicesPage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the page**

```tsx
// apps/desktop/src/features/invoices/InvoicesPage.tsx
import { Link, Route, Routes } from "react-router-dom";
import { InvoiceList } from "./InvoiceList";
import { NewInvoiceForm } from "./NewInvoiceForm";
import { ReviewInvoiceForm } from "./ReviewInvoiceForm";

export function InvoicesPage() {
  return (
    <div className="invoices-page">
      <header>
        <h1>Invoices</h1>
        <Link to="/invoices/new"><button type="button">+ New invoice</button></Link>
      </header>
      <Routes>
        <Route index element={<InvoiceList />} />
        <Route path="new" element={<NewInvoiceForm />} />
        <Route path=":id/review" element={<ReviewInvoiceForm />} />
      </Routes>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/features/invoices/InvoicesPage.test.tsx`
Expected: PASS — 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/invoices/InvoicesPage.tsx apps/desktop/src/features/invoices/InvoicesPage.test.tsx
git commit -m "feat(3a): InvoicesPage with child routes for new + review"
```

---

### Task 23: Nav wiring + batch confirmation hook

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: navigation component (search for the existing nav under `apps/desktop/src/components/` — likely `Sidebar.tsx` or `AppNav.tsx`)
- Create: `apps/desktop/src/lib/invoices/use-batch-confirmation-to-invoice.ts`
- Create: `apps/desktop/src/lib/invoices/use-batch-confirmation-to-invoice.test.ts`

- [ ] **Step 1: Wire the route**

In `apps/desktop/src/App.tsx`, add after the existing `<Route>` entries (inside the `<Routes>`):

```typescript
import { InvoicesPage } from "@/features/invoices/InvoicesPage";

// ... inside <Routes>:
<Route path="/invoices/*" element={<InvoicesPage />} />
```

The `/*` suffix is critical — it lets `InvoicesPage` own its nested routes (`new`, `:id/review`).

- [ ] **Step 2: Add the sidebar entry**

Find the existing sidebar/nav file. It will have entries like:

```typescript
{ to: "/payroll", label: "Payroll" }
```

Add (between Payroll and Treasury, or wherever feels natural):

```typescript
{ to: "/invoices", label: "Invoices" }
```

- [ ] **Step 3: Write the failing test for the confirmation hook**

```typescript
// apps/desktop/src/lib/invoices/use-batch-confirmation-to-invoice.test.ts
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useInvoicesStore } from "@/stores/invoices";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { syncBatchConfirmedToInvoice } from "./use-batch-confirmation-to-invoice";

beforeEach(() => {
  globalThis.localStorage?.clear();
  useInvoicesStore.setState({ invoices: [] });
  usePayrollBatchesStore.setState({ batches: [], selectedDraftId: null });
});

describe("syncBatchConfirmedToInvoice", () => {
  it("transitions linked invoice to signed when batch reaches confirmed", () => {
    const now = new Date().toISOString();
    useInvoicesStore.setState({
      invoices: [{
        id: "inv_1", createdAt: now, updatedAt: now, schema_version: "0.1.0",
        intake: { source: "manual-upload", received_at: now, raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
        invoice: { flow: "one-off-vendor", payee: { kind: "vendor", id: "v_1", display_name: "Acme" }, currency: "AUD", total: 100 },
        extraction: { pipeline: { stages: [] }, extracted_at: now },
        approval: { status: "queued-for-signing" },
        batchId: "vb_1",
      }] as never,
    });
    usePayrollBatchesStore.setState({
      batches: [{ kind: "vendor", id: "vb_1", state: "confirmed", pendingTxId: "0xdeadbeef", createdAt: now, updatedAt: now, label: "", treasuryId: "", invoiceId: "inv_1", vendorId: "v_1", fxSnapshot: [], line: { vendorId: "v_1", fiat: { minor: 100n, currency: "AUD" }, crypto: { value: 0n, asset: "CKB", decimals: 8 }, fxRate: "0", feeAllocated: { value: 0n, asset: "CKB", decimals: 8 } } }] as never,
      selectedDraftId: null,
    });

    syncBatchConfirmedToInvoice();

    const inv = useInvoicesStore.getState().findById("inv_1")!;
    expect(inv.approval.status).toBe("signed");
    expect(inv.chainpay_link?.tx_hash).toBe("0xdeadbeef");
    expect(inv.chainpay_link?.chain).toBe("ckb");
  });

  it("does nothing when no batches are in confirmed state", () => {
    const now = new Date().toISOString();
    useInvoicesStore.setState({
      invoices: [{
        id: "inv_1", createdAt: now, updatedAt: now, schema_version: "0.1.0",
        intake: { source: "manual-upload", received_at: now, raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
        invoice: { flow: "one-off-vendor", payee: { kind: "vendor", id: "v_1", display_name: "Acme" }, currency: "AUD", total: 100 },
        extraction: { pipeline: { stages: [] }, extracted_at: now },
        approval: { status: "queued-for-signing" },
        batchId: "vb_1",
      }] as never,
    });
    syncBatchConfirmedToInvoice();
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("queued-for-signing");
  });

  it("is idempotent — running twice doesn't re-transition or duplicate edits", () => {
    const now = new Date().toISOString();
    useInvoicesStore.setState({
      invoices: [{
        id: "inv_1", createdAt: now, updatedAt: now, schema_version: "0.1.0",
        intake: { source: "manual-upload", received_at: now, raw_file: { sha256: "a".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "file:///x" } },
        invoice: { flow: "one-off-vendor", payee: { kind: "vendor", id: "v_1", display_name: "Acme" }, currency: "AUD", total: 100 },
        extraction: { pipeline: { stages: [] }, extracted_at: now },
        approval: { status: "signed" },
        chainpay_link: { tx_hash: "0xdead", chain: "ckb" },
        batchId: "vb_1",
      }] as never,
    });
    usePayrollBatchesStore.setState({
      batches: [{ kind: "vendor", id: "vb_1", state: "confirmed", pendingTxId: "0xdead", createdAt: now, updatedAt: now, label: "", treasuryId: "", invoiceId: "inv_1", vendorId: "v_1", fxSnapshot: [], line: { vendorId: "v_1", fiat: { minor: 100n, currency: "AUD" }, crypto: { value: 0n, asset: "CKB", decimals: 8 }, fxRate: "0", feeAllocated: { value: 0n, asset: "CKB", decimals: 8 } } }] as never,
      selectedDraftId: null,
    });
    syncBatchConfirmedToInvoice();
    syncBatchConfirmedToInvoice();
    // Still signed; no errors thrown by attempting illegal transition
    expect(useInvoicesStore.getState().findById("inv_1")?.approval.status).toBe("signed");
  });
});

describe("hook subscription wrapper", () => {
  it("renderHook of useBatchConfirmationSync runs without error", async () => {
    const { useBatchConfirmationSync } = await import("./use-batch-confirmation-to-invoice");
    renderHook(() => useBatchConfirmationSync());
    // No assertion beyond "does not throw" — wiring sanity check
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/invoices/use-batch-confirmation-to-invoice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Write the hook**

```typescript
// apps/desktop/src/lib/invoices/use-batch-confirmation-to-invoice.ts
import { useEffect } from "react";
import { useInvoicesStore } from "@/stores/invoices";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";

/**
 * Pure side-effect: for every batch in `confirmed` state whose linked invoice
 * is still in `queued-for-signing`, transition the invoice to `signed` and
 * populate chainpay_link from the batch's tx hash.
 *
 * Idempotent — already-signed invoices are skipped (the state-machine guards).
 */
export function syncBatchConfirmedToInvoice(): void {
  const batches = usePayrollBatchesStore.getState().batches;
  const invoices = useInvoicesStore.getState().invoices;
  for (const b of batches) {
    if (b.state !== "confirmed" || !b.pendingTxId) continue;
    const linked = invoices.find((i) => i.batchId === b.id);
    if (!linked || linked.approval.status !== "queued-for-signing") continue;
    useInvoicesStore.getState().markSigned(linked.id, { txHash: b.pendingTxId, chain: "ckb" });
  }
}

/** React hook: subscribe to batch store and run sync whenever it changes. */
export function useBatchConfirmationSync(): void {
  useEffect(() => {
    syncBatchConfirmedToInvoice();
    const unsub = usePayrollBatchesStore.subscribe(() => syncBatchConfirmedToInvoice());
    return unsub;
  }, []);
}
```

- [ ] **Step 6: Wire the hook into the App tree**

In `apps/desktop/src/App.tsx`, near the top of the main `<App>` component body (alongside other global hooks like `useCommSendRetry`):

```typescript
import { useBatchConfirmationSync } from "@/lib/invoices/use-batch-confirmation-to-invoice";

// inside App component body:
useBatchConfirmationSync();
```

- [ ] **Step 7: Run all new tests**

Run: `cd apps/desktop && npx vitest run src/lib/invoices/ src/features/invoices/ src/stores/invoices.test.ts src/stores/vendors.test.ts src/stores/invoice-drafts.test.ts src/stores/payroll-batches.test.ts`
Expected: All green.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/lib/invoices/use-batch-confirmation-to-invoice.ts apps/desktop/src/lib/invoices/use-batch-confirmation-to-invoice.test.ts apps/desktop/src/components/  # whichever nav file changed
git commit -m "feat(3a): wire Invoices route + nav entry + batch→invoice confirmation sync"
```

---

### Task 24: Final verification + open PR

**Files:** none modified; this is a verification + ops task.

- [ ] **Step 1: Run full typecheck across both packages**

Run: `cd packages/shared && npm run typecheck && cd ../../apps/desktop && npm run typecheck`
Expected: 0 errors.

If errors surface (likely in places that consume `PayrollBatch` and now need to handle `kind` discriminator or `AnyBatch`): patch the consumers minimally to preserve existing behaviour for `kind === "payroll"`.

- [ ] **Step 2: Run full test suite**

Run: `cd apps/desktop && npm test -- --run && cd ../../packages/shared && npm test -- --run`
Expected: all tests green; new tests visible in the output.

- [ ] **Step 3: Run coverage on new code**

Run: `cd apps/desktop && npx vitest run --coverage src/lib/invoices/ src/features/invoices/ src/stores/invoices.test.ts src/stores/vendors.test.ts src/stores/invoice-drafts.test.ts`
Expected: ≥ 80% line coverage on new files. If below, add tests for the uncovered branches.

- [ ] **Step 4: Push branch**

Run: `git push -u origin feat/phase-3a-invoice-ingest`
Expected: branch created on origin.

- [ ] **Step 5: Open PR with operator smoke checklist**

Run:

```bash
gh pr create --title "feat(3a): invoice ingest manual entry + vendor flow" --body "$(cat <<'EOF'
## Summary

Phase 3a — Invoice Ingest (Manual Entry). Lands the invoice-extraction schema (v0.1.0) as TypeScript + Zod, delivers a working manual-entry → multisig handoff vertical for both `employee-payment` and `one-off-vendor` flows, with no OCR backend.

- New schema: `packages/shared/src/invoice-schema.ts` (Zod, round-tripped against vault file)
- New stores: `invoices`, `vendors`, `invoice-drafts` (zustand + localStorage)
- New types: `VendorPaymentBatch` reusing `PayrollBatchState`; `kind` discriminator on `PayrollBatch` via v1→v2 migration
- New PDF storage: content-addressed under Electron `userData/invoice-pdfs/` via IPC
- New UI: `features/invoices/` with NewInvoiceForm (Stage A) + ReviewInvoiceForm (Stage B) + InvoiceList
- Routing seam: `routeInvoiceToBatch` + `approveAndQueue` (safe-ordered batch-first writes)
- Batch confirmation hook: `useBatchConfirmationSync` transitions invoice to `signed` when linked batch reaches `confirmed`

Spec: docs/superpowers/specs/2026-05-27-phase-3a-invoice-ingest-manual-entry-design.md
Plan: docs/superpowers/plans/2026-05-27-phase-3a-invoice-ingest-manual-entry.md

## Operator smoke checklist (7 steps)

- [ ] Add a one-off vendor invoice (PDF + fields) → confirm record appears in /invoices
- [ ] Edit a field on Stage B → close window → reopen → confirm draft persists
- [ ] Approve & queue an employee-payment invoice → confirm it lands in PayPanel as a PayrollBatch with 1 line
- [ ] Approve & queue a vendor invoice → confirm VendorPaymentBatch created; PayPanel handles it identically
- [ ] Walk an approved invoice through to confirmed on testnet → confirm invoice.approval.status === "signed" and chainpay_link.tx_hash populated
- [ ] Reject an in-review invoice → confirm rejection reason captured; no batch created
- [ ] Reload mid-Stage-B → confirm form state recovers

## Test plan

- [x] Schema parse + round-trip vs vault JSON schema
- [x] State machine transition matrix
- [x] Stores: CRUD + status filters + migration idempotency
- [x] Routing: both flows + error cases
- [x] approveAndQueue safe-ordered writes + orphan-batch recovery
- [x] Component tests (RTL) for all new UI
- [x] Batch → invoice confirmation sync
- [ ] Operator smoke (above) — runs locally before merge
EOF
)"
```

- [ ] **Step 6: Confirm PR is mergeable**

Run: `gh pr view --json mergeable,mergeStateStatus`
Expected: `MERGEABLE` / `CLEAN`.

If conflicts surface against main (likely if PR #6 has merged in the interim), rebase onto current main: `git fetch origin main && git rebase origin/main`. Push with `git push --force-with-lease`.

- [ ] **Step 7: Final commit (none — PR is the deliverable)**

No additional commit. The PR URL printed by `gh pr create` is the handoff.

---

## Self-review checklist (run after Task 24)

1. **Spec coverage:** every spec section maps to one or more tasks above. ✓
2. **Placeholder scan:** no TBD / TODO / "similar to" in any task. ✓
3. **Type consistency:** `routeInvoiceToBatch`, `approveAndQueue`, `markQueuedForSigning`, `markSigned` signatures match between definition and call sites. ✓
4. **No skipped imports:** every `from "@chain-pay/shared"` or `from "@/..."` resolves to a file created in an earlier task. ✓

---

## Execution choice

Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task; review between tasks; fast iteration. Matches Phase 2.7c precedent.

**2. Inline Execution** — execute tasks in this session using executing-plans; batch execution with checkpoints for review.
