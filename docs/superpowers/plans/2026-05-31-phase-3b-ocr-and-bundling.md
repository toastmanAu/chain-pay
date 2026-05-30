# Phase 3b — OCR Extraction + Multi-Invoice Bundling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-populate invoice fields from PDF/image uploads via a renderer-side OCR pipeline (pdf.js → tesseract.js → rules), and let users bundle N vendor invoices into one `VendorPaymentBatch` from the invoice list.

**Architecture:** A three-stage extraction pipeline lives in the renderer. Stage 0 (rasterise) uses the already-installed `pdfjs-dist` to turn PDFs into `ImageBitmap[]`. Stage 1 (`layout-ocr`) runs `tesseract.js` inside a dedicated Web Worker. Stage 2 (`schema-extraction`) is a pure function over the OCR output that populates `Partial<InvoiceBody>` plus `field_confidences` and `warnings`. Results flow through a singleton `ExtractionService` (concurrency=1 queue) into a new `applyExtraction` action on the existing zustand `invoices` store. `StoredInvoiceRecord` gains a runtime `extractionStatus` field (`pending | running | extracted | failed`). The review form subscribes via a new `useExtractionLive` hook and renders shimmer / confidence chips / retry per state. Bundling is a pure `canBundle(invoices)` eligibility function plus a multi-select checkbox column on `InvoiceList` and a "Bundle into batch" CTA on `InvoicesPage`. `VendorPaymentBatch.invoiceId: string` becomes `invoiceIds: string[]` (hard rename — no real-fund vendor batches exist on main yet).

**Tech Stack:** TypeScript, Vitest (table-driven for rules; jsdom for component tests via `// @vitest-environment jsdom`), React 19 + Testing Library, Zustand (already used; idempotency guard added to `applyExtraction`), `tesseract.js` (new dep), `pdfjs-dist` (already installed at `^4.10.38`), Web Workers (Vite's `?worker` import pattern).

**Branch:** `feat/phase-3b-ocr-bundling` from current `main` tip (`be16c57`).

**Spec reference:** `docs/superpowers/specs/2026-05-31-phase-3b-ocr-and-bundling-design.md`

---

## File Structure

### New files in `apps/desktop/src/lib/invoices/extraction/` (6)

| Path | Responsibility |
|---|---|
| `types.ts` | `PageOcr`, `ExtractionResult`, `Stage0Output` shared shapes. |
| `rasterise.ts` | Stage 0: PDF → `ImageBitmap[]` via `pdfjs-dist`; pass-through for images. |
| `worker.ts` | Stage 1 Web Worker entrypoint: `tesseract.js` host. |
| `rules.ts` | Stage 2: pure `(PageOcr[]) => ExtractionResult`. |
| `pipeline.ts` | Three-stage orchestrator with elapsed-ms timing per stage. |
| `index.ts` | `ExtractionService` singleton with concurrency=1 queue. |

### New tests in `apps/desktop/src/lib/invoices/extraction/` (4)

| Path | Coverage |
|---|---|
| `rules.test.ts` | Table-driven over ~15-20 OCR-text fixtures: total, currency, invoice_number, dates, vendor name, BSB, addresses, NaN guard, missing-everything fallback. |
| `pipeline.test.ts` | Stage ordering, `pipeline.stages` array shape, elapsed_ms, error propagation, retry appends (not overwrites). |
| `index.test.ts` | Concurrency=1 queueing, state transitions, worker boot failure → `failed`. |
| `rasterise.test.ts` | PNG/JPG pass-through; PDF rasterise call shape (with mocked pdfjs). |

### New files in `apps/desktop/src/lib/invoices/` (2)

| Path | Responsibility |
|---|---|
| `bundling.ts` | Pure `canBundle(invoices) => { ok: true } \| { ok: false; reason: string }`. |
| `bundling.test.ts` | Table-driven over v1 eligibility rules. |

### New hook in `apps/desktop/src/features/invoices/hooks/` (1)

| Path | Responsibility |
|---|---|
| `useExtractionLive.ts` | Subscribes to `invoicesStore`; returns `{ status, confidences, warnings, error }`. |
| `useExtractionLive.test.ts` | Subscription returns live status; unsubscribes on unmount. |

### Modified files in `apps/desktop/src/stores/` (1)

| Path | Change |
|---|---|
| `invoices.ts` | Add `extractionStatus: ExtractionStatus` + `extractionError?: string` to `StoredInvoiceRecord`. Add `applyExtraction(id, result)`, `markExtractionRunning(id)`, `markExtractionFailed(id, error)` actions. Idempotency: `applyExtraction` no-ops if the same `pipeline.stages` head signature is already present. |
| `invoices.test.ts` | Tests for the new actions + idempotency + user-typed-field-preserved merge. |

### Modified files in `packages/shared/src/` (1)

| Path | Change |
|---|---|
| `payroll.ts:163-185` | `VendorPaymentBatch.invoiceId: string` → `invoiceIds: string[]`. |
| `payroll-vendor.test.ts` | Update existing assertion `invoiceId` → `invoiceIds`. |

### Modified files in `apps/desktop/src/features/invoices/` (4)

| Path | Change |
|---|---|
| `NewInvoiceForm.tsx` | Drop sync extraction wait; enqueue + navigate immediately. |
| `ReviewInvoiceForm.tsx` | Three render states (pending/running, extracted, failed); shimmer; confidence chips; retry button; user-typed-field-preserved merge. |
| `InvoiceList.tsx` | Checkbox column; selection state passed up. |
| `InvoicesPage.tsx` | Multi-select toolbar + "Bundle into batch" CTA; calls existing batch builder with `invoiceIds: []`. |
| `NewInvoiceForm.test.tsx` | Update existing tests for fire-and-forget enqueue. |
| `ReviewInvoiceForm.test.tsx` | Three render-state tests; user-typed-field-preserved test. |
| `InvoiceList.test.tsx` | Checkbox toggles selection. |
| `InvoicesPage.test.tsx` | Bundle CTA visibility + enabled/disabled per eligibility. |

### Modified files in `apps/desktop/src/features/payroll/` (≤1, discoverable)

| Path | Change |
|---|---|
| Any consumer of `VendorPaymentBatch.invoiceId` | Update to `invoiceIds[]`. Identify with `grep -rn "\.invoiceId" apps/desktop/src/features/payroll/`. |

### Modified files (build / deps)

| Path | Change |
|---|---|
| `apps/desktop/package.json` | Add `tesseract.js` (`^5.x`) to `dependencies`. |
| `apps/desktop/vitest.config.ts` | No change required — existing aliases cover new files. |

### New docs (1)

| Path | Responsibility |
|---|---|
| `docs/phase-3b-smoke-playbook.md` | Manual smoke recipe (real PDF, photographed receipt, password-protected PDF, user-typing race, bundle happy path, currency-mismatch sad path). |

---

## Task 1: Create branch + add `tesseract.js` dependency

**Files:**
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Create branch from `main`**

```bash
git checkout main
git pull
git checkout -b feat/phase-3b-ocr-bundling
```

Expected: switched to new branch.

- [ ] **Step 2: Add `tesseract.js` to desktop workspace**

```bash
npm --workspace apps/desktop install tesseract.js@^5.1.1
```

Expected: `apps/desktop/package.json` gains `"tesseract.js": "^5.1.1"` under `dependencies`; root `package-lock.json` updated.

- [ ] **Step 3: Verify typecheck still passes**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/package.json package-lock.json
git commit -m "chore(3b): add tesseract.js dep"
```

---

## Task 2: Rename `VendorPaymentBatch.invoiceId` → `invoiceIds: string[]`

This is a small, mechanical type change. Doing it first means downstream tasks build against the new shape.

**Files:**
- Modify: `packages/shared/src/payroll.ts:163-185`
- Modify: `packages/shared/src/payroll-vendor.test.ts`
- Test: existing `payroll-vendor.test.ts`
- Modify (discover): any consumer in `apps/desktop/src/features/payroll/` or `apps/desktop/src/lib/`

- [ ] **Step 1: Find every consumer of `.invoiceId` on a vendor batch**

```bash
grep -rn "invoiceId" apps/desktop/src packages/shared/src --include='*.ts' --include='*.tsx'
```

Expected output includes `packages/shared/src/payroll.ts:167` and `packages/shared/src/payroll-vendor.test.ts:27` — and any production consumer to update. Make a list.

- [ ] **Step 2: Write the failing type-shape assertion update**

Update `packages/shared/src/payroll-vendor.test.ts` so the existing case becomes:

```ts
it("VendorPaymentBatch backlinks an invoiceIds array", () => {
  expectTypeOf<VendorPaymentBatch>().toHaveProperty("invoiceIds").toEqualTypeOf<string[]>();
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npm --workspace packages/shared test -- payroll-vendor
```

Expected: FAIL with type error on `invoiceIds`.

- [ ] **Step 4: Apply the rename in `payroll.ts`**

Edit `packages/shared/src/payroll.ts` around the `VendorPaymentBatch` interface:

```ts
export interface VendorPaymentBatch extends Identified, Timestamped {
  // ... other fields preserved
  invoiceIds: string[];  // was: invoiceId: string
}
```

- [ ] **Step 5: Run typecheck across workspaces**

```bash
npm run typecheck
```

Expected: failures only at known consumers from Step 1. Fix each by renaming `.invoiceId` → `.invoiceIds[0]` (read) or accepting the array (write). Where a builder previously took `invoiceId: string`, change to `invoiceIds: string[]`.

- [ ] **Step 6: Run the targeted test + the whole shared package**

```bash
npm --workspace packages/shared test
```

Expected: green.

- [ ] **Step 7: Run desktop typecheck + tests**

```bash
npm --workspace apps/desktop run typecheck
npm --workspace apps/desktop test
```

Expected: green. If a payroll feature test references `.invoiceId`, update it to the array form.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/payroll.ts packages/shared/src/payroll-vendor.test.ts apps/desktop/src
git commit -m "refactor(3b): VendorPaymentBatch.invoiceId -> invoiceIds[]"
```

---

## Task 3: Extraction lifecycle on the invoices store

Adds the runtime status field + idempotent `applyExtraction` action. UI builds on this in later tasks. No pipeline yet — just the seam.

**Files:**
- Modify: `apps/desktop/src/stores/invoices.ts`
- Modify: `apps/desktop/src/stores/invoices.test.ts`

- [ ] **Step 1: Write the failing test for `extractionStatus` default**

Add to `apps/desktop/src/stores/invoices.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useInvoicesStore } from "./invoices";

function blankInvoice(id: string) {
  return {
    id,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
    schema_version: "0.1.0" as const,
    intake: {
      source: "manual-upload" as const,
      received_at: "2026-05-31T00:00:00.000Z",
      raw_file: { sha256: "0".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "s://x" },
    },
    invoice: { flow: "one-off-vendor" as const, payee: { kind: "vendor" as const, display_name: "Acme" }, currency: "AUD", total: 0 },
    extraction: { pipeline: { stages: [] }, extracted_at: "2026-05-31T00:00:00.000Z" },
    approval: { status: "draft" as const },
  };
}

describe("invoicesStore.extractionStatus", () => {
  beforeEach(() => useInvoicesStore.setState({ invoices: [] }));

  it("defaults new invoices to extractionStatus=pending", () => {
    useInvoicesStore.getState().addInvoice(blankInvoice("inv_1"));
    const stored = useInvoicesStore.getState().findById("inv_1");
    expect(stored?.extractionStatus).toBe("pending");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --workspace apps/desktop test -- stores/invoices
```

Expected: FAIL — `extractionStatus` is undefined.

- [ ] **Step 3: Add `extractionStatus` to `StoredInvoiceRecord` and default it on `addInvoice`**

In `apps/desktop/src/stores/invoices.ts`:

```ts
import type { InvoiceApprovalStatus, InvoiceRecord } from "@chain-pay/shared";

export type ExtractionStatus = "pending" | "running" | "extracted" | "failed";

export interface StoredInvoiceRecord extends InvoiceRecord {
  batchId?: string;
  extractionStatus: ExtractionStatus;
  extractionError?: string;
}
```

Update `addInvoice` to default the new field:

```ts
addInvoice: (i) =>
  set((s) =>
    s.invoices.some((x) => x.id === i.id)
      ? s
      : { invoices: [...s.invoices, { ...i, extractionStatus: "pending" as const }] },
  ),
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm --workspace apps/desktop test -- stores/invoices
```

Expected: PASS.

- [ ] **Step 5: Write failing tests for `markExtractionRunning`, `applyExtraction`, `markExtractionFailed`, idempotency, and user-typed-field-preserved merge**

Add to `apps/desktop/src/stores/invoices.test.ts`:

```ts
import type { Invoice } from "@chain-pay/shared";

const SAMPLE_RESULT: {
  stages: Invoice["extraction"]["pipeline"]["stages"];
  body: Partial<Invoice["invoice"]>;
  field_confidences: Record<string, number>;
  warnings: NonNullable<Invoice["extraction"]["warnings"]>;
} = {
  stages: [
    { name: "layout-ocr", model: "tesseract.js", version: "5.1.1", elapsed_ms: 4200 },
    { name: "schema-extraction", model: "rules-v1", version: "0.1.0", elapsed_ms: 12 },
  ],
  body: { total: 1234.56, invoice_number: "INV-001" },
  field_confidences: { total: 0.92, invoice_number: 0.78 },
  warnings: [],
};

describe("invoicesStore extraction actions", () => {
  beforeEach(() => useInvoicesStore.setState({ invoices: [] }));

  it("markExtractionRunning moves pending -> running", () => {
    const s = useInvoicesStore.getState();
    s.addInvoice(blankInvoice("inv_1"));
    s.markExtractionRunning("inv_1");
    expect(useInvoicesStore.getState().findById("inv_1")?.extractionStatus).toBe("running");
  });

  it("applyExtraction populates body, confidences, stages and sets extracted", () => {
    const s = useInvoicesStore.getState();
    s.addInvoice(blankInvoice("inv_1"));
    s.applyExtraction("inv_1", SAMPLE_RESULT);
    const inv = useInvoicesStore.getState().findById("inv_1")!;
    expect(inv.extractionStatus).toBe("extracted");
    expect(inv.invoice.total).toBe(1234.56);
    expect(inv.invoice.invoice_number).toBe("INV-001");
    expect(inv.extraction.pipeline.stages).toHaveLength(2);
    expect(inv.extraction.field_confidences).toEqual({ total: 0.92, invoice_number: 0.78 });
  });

  it("applyExtraction is idempotent — same head signature is a no-op", () => {
    const s = useInvoicesStore.getState();
    s.addInvoice(blankInvoice("inv_1"));
    s.applyExtraction("inv_1", SAMPLE_RESULT);
    s.applyExtraction("inv_1", SAMPLE_RESULT);
    expect(useInvoicesStore.getState().findById("inv_1")?.extraction.pipeline.stages).toHaveLength(2);
  });

  it("applyExtraction preserves user-typed fields", () => {
    const s = useInvoicesStore.getState();
    s.addInvoice(blankInvoice("inv_1"));
    // simulate user typing
    s.updateInvoice("inv_1", { invoice: { ...blankInvoice("inv_1").invoice, invoice_number: "USER-001" } });
    s.applyExtraction("inv_1", SAMPLE_RESULT);
    const inv = useInvoicesStore.getState().findById("inv_1")!;
    expect(inv.invoice.invoice_number).toBe("USER-001"); // preserved
    expect(inv.invoice.total).toBe(1234.56); // populated (user didn't touch)
  });

  it("markExtractionFailed sets failed status and error", () => {
    const s = useInvoicesStore.getState();
    s.addInvoice(blankInvoice("inv_1"));
    s.markExtractionFailed("inv_1", "PDF is password-protected");
    const inv = useInvoicesStore.getState().findById("inv_1")!;
    expect(inv.extractionStatus).toBe("failed");
    expect(inv.extractionError).toBe("PDF is password-protected");
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

```bash
npm --workspace apps/desktop test -- stores/invoices
```

Expected: FAIL — actions are not defined.

- [ ] **Step 7: Implement the new actions in `invoices.ts`**

Extend the `InvoicesStore` interface:

```ts
interface InvoicesStore {
  // ...existing
  markExtractionRunning: (id: string) => void;
  markExtractionFailed: (id: string, error: string) => void;
  applyExtraction: (
    id: string,
    result: {
      stages: Invoice["extraction"]["pipeline"]["stages"];
      body: Partial<Invoice["invoice"]>;
      field_confidences: Record<string, number>;
      warnings: NonNullable<Invoice["extraction"]["warnings"]>;
    },
  ) => void;
}
```

Add the implementations inside the `create<InvoicesStore>()(persist(...))` factory body:

```ts
markExtractionRunning: (id) =>
  set((s) => ({
    invoices: s.invoices.map((i) =>
      i.id === id ? { ...i, extractionStatus: "running" as const, updatedAt: new Date().toISOString() } : i,
    ),
  })),

markExtractionFailed: (id, error) =>
  set((s) => ({
    invoices: s.invoices.map((i) =>
      i.id === id
        ? { ...i, extractionStatus: "failed" as const, extractionError: error, updatedAt: new Date().toISOString() }
        : i,
    ),
  })),

applyExtraction: (id, result) =>
  set((s) => ({
    invoices: s.invoices.map((i) => {
      if (i.id !== id) return i;
      // idempotency: skip if the head stage signature already matches
      const existingTop = i.extraction.pipeline.stages.at(-1);
      const incomingTop = result.stages.at(-1);
      if (
        existingTop &&
        incomingTop &&
        existingTop.name === incomingTop.name &&
        existingTop.model === incomingTop.model &&
        existingTop.version === incomingTop.version &&
        existingTop.elapsed_ms === incomingTop.elapsed_ms
      ) {
        return i;
      }
      // user-typed-preserve merge: only fill fields still at the default-empty shape
      const merged: Invoice["invoice"] = { ...i.invoice };
      for (const [k, v] of Object.entries(result.body) as [keyof Invoice["invoice"], unknown][]) {
        const current = merged[k];
        const isDefaultEmpty =
          current === undefined ||
          current === null ||
          current === "" ||
          (k === "total" && current === 0);
        if (isDefaultEmpty) {
          (merged as Record<string, unknown>)[k] = v;
        }
      }
      return {
        ...i,
        invoice: merged,
        extraction: {
          ...i.extraction,
          pipeline: { stages: [...i.extraction.pipeline.stages, ...result.stages] },
          field_confidences: { ...(i.extraction.field_confidences ?? {}), ...result.field_confidences },
          warnings: [...(i.extraction.warnings ?? []), ...result.warnings],
          extracted_at: new Date().toISOString(),
        },
        extractionStatus: "extracted" as const,
        updatedAt: new Date().toISOString(),
      };
    }),
  })),
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
npm --workspace apps/desktop test -- stores/invoices
npm --workspace apps/desktop run typecheck
```

Expected: green.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/stores/invoices.ts apps/desktop/src/stores/invoices.test.ts
git commit -m "feat(3b): extractionStatus + applyExtraction action on invoices store"
```

---

## Task 4: Shared extraction types

Locks the contract every other task references. Done in isolation so later code can import a stable surface.

**Files:**
- Create: `apps/desktop/src/lib/invoices/extraction/types.ts`

- [ ] **Step 1: Create `types.ts`**

```ts
import type { Invoice } from "@chain-pay/shared";

export interface OcrLine {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number; // 0-100 from tesseract; normalised to 0-1 elsewhere if needed
}

export interface PageOcr {
  pageIndex: number;
  text: string;
  lines: OcrLine[];
}

export interface Stage0Output {
  pages: ImageBitmap[];
  pageCount: number;
}

export interface ExtractionResult {
  stages: Invoice["extraction"]["pipeline"]["stages"];
  body: Partial<Invoice["invoice"]>;
  field_confidences: Record<string, number>;
  warnings: NonNullable<Invoice["extraction"]["warnings"]>;
}

export interface ExtractionFailure {
  reason: string;
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
npm --workspace apps/desktop run typecheck
```

Expected: green (file referenced by nothing yet — type-level only).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/invoices/extraction/types.ts
git commit -m "feat(3b): extraction pipeline shared types"
```

---

## Task 5: Stage 2 — `rules.ts` pure extraction

The big-test-fixture task. Pure function, no DOM, no async, no workers. Easiest to write TDD.

**Files:**
- Create: `apps/desktop/src/lib/invoices/extraction/rules.ts`
- Test: `apps/desktop/src/lib/invoices/extraction/rules.test.ts`

- [ ] **Step 1: Write the failing table-driven test**

Create `apps/desktop/src/lib/invoices/extraction/rules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { PageOcr } from "./types";
import { extractFields } from "./rules";

function page(text: string, lines: { text: string; confidence?: number; y?: number }[] = []): PageOcr {
  return {
    pageIndex: 0,
    text,
    lines: lines.map((l, i) => ({
      text: l.text,
      bbox: { x0: 0, y0: l.y ?? i * 20, x1: 100, y1: (l.y ?? i * 20) + 20 },
      confidence: l.confidence ?? 90,
    })),
  };
}

const CASES: Array<{ name: string; pages: PageOcr[]; expect: (r: ReturnType<typeof extractFields>) => void }> = [
  {
    name: "clean AUD vendor invoice",
    pages: [page("Acme Pty Ltd\nInvoice #INV-2026-001\nIssued: 15/05/2026\nDue: 30/05/2026\nTotal: AUD 1,234.56", [
      { text: "Acme Pty Ltd", y: 0 },
      { text: "Invoice #INV-2026-001", y: 30 },
      { text: "Issued: 15/05/2026", y: 50 },
      { text: "Due: 30/05/2026", y: 70 },
      { text: "Total: AUD 1,234.56", y: 800 },
    ])],
    expect: (r) => {
      expect(r.body.total).toBeCloseTo(1234.56);
      expect(r.body.currency).toBe("AUD");
      expect(r.body.invoice_number).toBe("INV-2026-001");
      expect(r.body.issue_date).toBe("2026-05-15");
      expect(r.body.due_date).toBe("2026-05-30");
      expect(r.body.payee?.display_name).toContain("Acme");
    },
  },
  {
    name: "USD invoice with $ symbol",
    pages: [page("Total: $99.00", [{ text: "Total: $99.00", y: 800 }])],
    expect: (r) => {
      expect(r.body.total).toBe(99);
      expect(r.body.currency).toBe("USD");
    },
  },
  {
    name: "EUR invoice with € symbol",
    pages: [page("Gesamt: € 250,00", [{ text: "Gesamt: € 250,00", y: 800 }])],
    expect: (r) => {
      expect(r.body.currency).toBe("EUR");
      // total parsing for european decimals is YAGNI for v1 — accept a warning, not a value
      const totalWarn = r.warnings.find((w) => w.field === "total");
      expect(totalWarn || r.body.total).toBeTruthy();
    },
  },
  {
    name: "BSB present (AU bank details)",
    pages: [page("BSB 062-001 Account 12345678 Total $200", [
      { text: "BSB 062-001 Account 12345678", y: 600 },
      { text: "Total $200", y: 800 },
    ])],
    expect: (r) => {
      expect(r.body.payment_details?.bank?.bsb).toBe("062-001");
      expect(r.body.payment_details?.bank?.account_number).toBe("12345678");
    },
  },
  {
    name: "CKB testnet address present",
    pages: [page("Pay to: ckt1qyqv... Total $50", [{ text: "Pay to: ckt1qyqv0z2u Total $50", y: 800 }])],
    expect: (r) => {
      expect(r.body.payment_details?.ckb_address).toMatch(/^ckt1/);
    },
  },
  {
    name: "EVM address present",
    pages: [page("ETH: 0x1234567890abcdef1234567890abcdef12345678 Total $50", [
      { text: "ETH: 0x1234567890abcdef1234567890abcdef12345678", y: 600 },
      { text: "Total $50", y: 800 },
    ])],
    expect: (r) => {
      expect(r.body.payment_details?.evm_address).toBe("0x1234567890abcdef1234567890abcdef12345678");
    },
  },
  {
    name: "NaN-total guard",
    pages: [page("Total: ABC", [{ text: "Total: ABC", y: 800 }])],
    expect: (r) => {
      expect(r.body.total).toBeUndefined();
      expect(r.warnings.some((w) => w.field === "total")).toBe(true);
    },
  },
  {
    name: "negative-total guard",
    pages: [page("Total: -99.00", [{ text: "Total: -99.00", y: 800 }])],
    expect: (r) => {
      expect(r.body.total).toBeUndefined();
      expect(r.warnings.some((w) => w.field === "total")).toBe(true);
    },
  },
  {
    name: "missing everything fallback",
    pages: [page("a b c d e", [{ text: "a b c d e", y: 0 }])],
    expect: (r) => {
      expect(r.body.total).toBeUndefined();
      // every field that we tried but couldn't extract gets a low-confidence entry
      expect(r.warnings.length).toBeGreaterThan(0);
    },
  },
  {
    name: "stage entry is recorded",
    pages: [page("Total: $1.00", [{ text: "Total: $1.00", y: 800 }])],
    expect: (r) => {
      expect(r.stages).toHaveLength(1);
      expect(r.stages[0].name).toBe("schema-extraction");
      expect(r.stages[0].model).toBe("rules-v1");
      expect(r.stages[0].version).toBe("0.1.0");
    },
  },
];

describe("rules.extractFields", () => {
  for (const c of CASES) {
    it(c.name, () => c.expect(extractFields(c.pages)));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --workspace apps/desktop test -- extraction/rules
```

Expected: FAIL — `extractFields` not defined.

- [ ] **Step 3: Implement `rules.ts`**

Create `apps/desktop/src/lib/invoices/extraction/rules.ts`:

```ts
import type { Invoice } from "@chain-pay/shared";
import type { ExtractionResult, PageOcr } from "./types";

const STAGE_NAME = "schema-extraction" as const;
const STAGE_MODEL = "rules-v1" as const;
const STAGE_VERSION = "0.1.0" as const;

const CURRENCY_TOKENS: Array<[RegExp, string]> = [
  [/\bAUD\b/i, "AUD"],
  [/\bUSD\b/i, "USD"],
  [/\bEUR\b/i, "EUR"],
  [/\bGBP\b/i, "GBP"],
  [/€/, "EUR"],
  [/£/, "GBP"],
  [/\$/, "USD"],
];

const INVOICE_NUMBER_RE = /invoice\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Z0-9\-_/]+)/i;
const TOTAL_LABEL_RE = /(?:^|[^a-z])total\s*[:\-]?\s*(?:[A-Z]{3}\s*)?([\$£€]?\s*-?[\d,]+(?:\.\d+)?)/i;
const ISO_DATE_OR_DMY = /(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/;
const ISSUED_RE = new RegExp("(?:issued|issue\\s*date)\\s*[:\\-]?\\s*" + ISO_DATE_OR_DMY.source, "i");
const DUE_RE = new RegExp("due\\s*(?:date)?\\s*[:\\-]?\\s*" + ISO_DATE_OR_DMY.source, "i");
const BSB_RE = /\b(\d{3}-\d{3})\b/;
const ACCOUNT_RE = /account\s*[:\-]?\s*(\d{6,10})/i;
const CKB_RE = /\b(ck[bt]1[a-z0-9]{20,})/i;
const EVM_RE = /\b(0x[0-9a-f]{40})\b/i;

function parseCurrency(s: string): { total?: number; warn?: string } {
  const cleaned = s.replace(/[\$£€\s]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { warn: "Total looked invalid" };
  if (n < 0) return { warn: "Total looked invalid" };
  return { total: n };
}

function parseDate(raw: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return undefined;
  const dd = m[1].padStart(2, "0");
  const mm = m[2].padStart(2, "0");
  let yyyy = m[3];
  if (yyyy.length === 2) yyyy = `20${yyyy}`;
  // sanity: month 1-12, day 1-31
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return undefined;
  return `${yyyy}-${mm}-${dd}`;
}

export function extractFields(pages: PageOcr[]): ExtractionResult {
  const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  const body: Partial<Invoice["invoice"]> = {};
  const field_confidences: Record<string, number> = {};
  const warnings: NonNullable<Invoice["extraction"]["warnings"]> = [];
  const allText = pages.map((p) => p.text).join("\n");

  // currency
  for (const [re, code] of CURRENCY_TOKENS) {
    if (re.test(allText)) {
      body.currency = code;
      field_confidences.currency = 0.9;
      break;
    }
  }

  // total
  const totalMatch = allText.match(TOTAL_LABEL_RE);
  if (totalMatch) {
    const parsed = parseCurrency(totalMatch[1]);
    if (parsed.total !== undefined) {
      body.total = parsed.total;
      field_confidences.total = 0.9;
    } else if (parsed.warn) {
      warnings.push({ field: "total", severity: "warn", message: parsed.warn });
    }
  } else {
    warnings.push({ field: "total", severity: "info", message: "No total found" });
  }

  // invoice number
  const invNum = allText.match(INVOICE_NUMBER_RE);
  if (invNum) {
    body.invoice_number = invNum[1];
    field_confidences.invoice_number = 0.85;
  } else {
    warnings.push({ field: "invoice_number", severity: "info", message: "No invoice number found" });
  }

  // dates
  const issued = allText.match(ISSUED_RE);
  if (issued) {
    const d = parseDate(issued[1]);
    if (d) {
      body.issue_date = d;
      field_confidences.issue_date = 0.85;
    }
  }
  const due = allText.match(DUE_RE);
  if (due) {
    const d = parseDate(due[1]);
    if (d) {
      body.due_date = d;
      field_confidences.due_date = 0.85;
    }
  }

  // payee display_name — largest line in top 25% of page 1
  const page1 = pages[0];
  if (page1?.lines.length) {
    const ys = page1.lines.map((l) => l.bbox.y0);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const topQuarterCutoff = minY + (maxY - minY) * 0.25;
    const candidates = page1.lines.filter((l) => l.bbox.y0 <= topQuarterCutoff && l.text.trim().length > 1);
    if (candidates.length) {
      const tallest = candidates.reduce((a, b) =>
        (a.bbox.y1 - a.bbox.y0) >= (b.bbox.y1 - b.bbox.y0) ? a : b,
      );
      body.payee = { kind: "unknown", display_name: tallest.text.trim() };
      field_confidences.payee_display_name = 0.55;
    }
  }

  // bank details
  const bsb = allText.match(BSB_RE);
  const acct = allText.match(ACCOUNT_RE);
  if (bsb || acct) {
    body.payment_details = {
      ...(body.payment_details ?? {}),
      bank: {
        ...(bsb ? { bsb: bsb[1] } : {}),
        ...(acct ? { account_number: acct[1] } : {}),
      },
    };
    if (bsb) field_confidences.bsb = 0.95;
    if (acct) field_confidences.account_number = 0.9;
  }

  // ckb / evm
  const ckb = allText.match(CKB_RE);
  if (ckb) {
    body.payment_details = { ...(body.payment_details ?? {}), ckb_address: ckb[1] };
    field_confidences.ckb_address = 0.99;
  }
  const evm = allText.match(EVM_RE);
  if (evm) {
    body.payment_details = { ...(body.payment_details ?? {}), evm_address: evm[1].toLowerCase() };
    field_confidences.evm_address = 0.99;
  }

  const elapsed_ms = Math.max(0, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0));

  return {
    stages: [{ name: STAGE_NAME, model: STAGE_MODEL, version: STAGE_VERSION, elapsed_ms }],
    body,
    field_confidences,
    warnings,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --workspace apps/desktop test -- extraction/rules
```

Expected: all cases green. If the EUR european-decimal case fails because the total *is* picked up, that's a soft assertion (`expect(totalWarn || r.body.total).toBeTruthy()`); leave the rule as-is — picking up `250` and warning is acceptable.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/invoices/extraction/rules.ts apps/desktop/src/lib/invoices/extraction/rules.test.ts
git commit -m "feat(3b): rules.ts stage-2 heuristic extractor + table-driven tests"
```

---

## Task 6: Stage 0 — `rasterise.ts` PDF → ImageBitmap[]

Pure adapter over `pdfjs-dist`. Image MIME types pass through.

**Files:**
- Create: `apps/desktop/src/lib/invoices/extraction/rasterise.ts`
- Test: `apps/desktop/src/lib/invoices/extraction/rasterise.test.ts`

- [ ] **Step 1: Write the failing test (image pass-through + PDF dispatch contract)**

Create `apps/desktop/src/lib/invoices/extraction/rasterise.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { rasterise } from "./rasterise";

describe("rasterise", () => {
  it("passes through PNG as a single page", async () => {
    // jsdom's ImageBitmap path is limited; fake the bitmap with a typed sentinel
    const fakeBitmap = { width: 1, height: 1 } as unknown as ImageBitmap;
    vi.stubGlobal("createImageBitmap", vi.fn(async () => fakeBitmap));
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    const out = await rasterise(blob);
    expect(out.pageCount).toBe(1);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0]).toBe(fakeBitmap);
    vi.unstubAllGlobals();
  });

  it("passes through JPG as a single page", async () => {
    const fakeBitmap = { width: 1, height: 1 } as unknown as ImageBitmap;
    vi.stubGlobal("createImageBitmap", vi.fn(async () => fakeBitmap));
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
    const out = await rasterise(blob);
    expect(out.pageCount).toBe(1);
    vi.unstubAllGlobals();
  });

  it("rejects unsupported MIME", async () => {
    const blob = new Blob([new Uint8Array([0])], { type: "text/plain" });
    await expect(rasterise(blob)).rejects.toThrow(/unsupported/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --workspace apps/desktop test -- extraction/rasterise
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `rasterise.ts`**

Create `apps/desktop/src/lib/invoices/extraction/rasterise.ts`:

```ts
import type { Stage0Output } from "./types";

const PDF_RENDER_DPI = 200;
const POINTS_PER_INCH = 72;
const PDF_SCALE = PDF_RENDER_DPI / POINTS_PER_INCH;

async function rasteriseImage(blob: Blob): Promise<Stage0Output> {
  const bitmap = await createImageBitmap(blob);
  return { pages: [bitmap], pageCount: 1 };
}

async function rasterisePdf(blob: Blob): Promise<Stage0Output> {
  const pdfjs = await import("pdfjs-dist");
  // worker is configured at app boot — see Task 7 wiring
  const buf = await blob.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages: ImageBitmap[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: PDF_SCALE });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2D unavailable");
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    pages.push(canvas.transferToImageBitmap());
  }
  return { pages, pageCount: doc.numPages };
}

export async function rasterise(blob: Blob): Promise<Stage0Output> {
  if (blob.type === "image/png" || blob.type === "image/jpeg") {
    return rasteriseImage(blob);
  }
  if (blob.type === "application/pdf") {
    return rasterisePdf(blob);
  }
  throw new Error(`Unsupported MIME for extraction: ${blob.type}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --workspace apps/desktop test -- extraction/rasterise
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/invoices/extraction/rasterise.ts apps/desktop/src/lib/invoices/extraction/rasterise.test.ts
git commit -m "feat(3b): stage-0 rasterise PDF + image pass-through"
```

---

## Task 7: Stage 1 — Tesseract Web Worker host + pdfjs worker wiring

**Files:**
- Create: `apps/desktop/src/lib/invoices/extraction/worker.ts`
- Create: `apps/desktop/src/lib/invoices/extraction/pdfjs-worker-setup.ts`
- Modify: `apps/desktop/src/main.tsx` (or wherever the renderer entry lives — discover with `grep -rn "ReactDOM.createRoot" apps/desktop/src`)

- [ ] **Step 1: Discover renderer entry**

```bash
grep -rn "ReactDOM" apps/desktop/src --include='*.tsx' | head -5
```

Note the path (likely `apps/desktop/src/main.tsx`).

- [ ] **Step 2: Create `pdfjs-worker-setup.ts` to register the worker**

```ts
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?worker&url";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
```

The `?worker&url` is Vite's pattern for getting the worker bundle URL at build time without auto-instantiating it.

- [ ] **Step 3: Import that module from the renderer entry**

In the renderer entry (e.g. `main.tsx`), add at the top of imports:

```ts
import "@/lib/invoices/extraction/pdfjs-worker-setup";
```

- [ ] **Step 4: Create the Tesseract worker entrypoint `worker.ts`**

```ts
import { createWorker, type Worker } from "tesseract.js";
import type { PageOcr } from "./types";

interface RecognizeRequest {
  type: "recognize";
  jobId: string;
  pages: ImageBitmap[];
}
interface PingRequest { type: "ping"; jobId: string }
type Request = RecognizeRequest | PingRequest;

interface ResponseOk {
  type: "done";
  jobId: string;
  pages: PageOcr[];
  elapsed_ms: number;
  version: string;
}
interface ResponseErr { type: "error"; jobId: string; reason: string }
type Response = ResponseOk | ResponseErr | { type: "pong"; jobId: string };

let cachedWorker: Worker | null = null;
async function getWorker(): Promise<Worker> {
  if (cachedWorker) return cachedWorker;
  cachedWorker = await createWorker("eng");
  return cachedWorker;
}

async function bitmapToCanvas(bitmap: ImageBitmap): Promise<OffscreenCanvas> {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2D unavailable in worker");
  ctx.drawImage(bitmap, 0, 0);
  return c;
}

self.addEventListener("message", async (e: MessageEvent<Request>) => {
  const req = e.data;
  if (req.type === "ping") {
    (self as unknown as Worker).postMessage({ type: "pong", jobId: req.jobId } satisfies Response);
    return;
  }
  if (req.type === "recognize") {
    const t0 = performance.now();
    try {
      const worker = await getWorker();
      const out: PageOcr[] = [];
      for (let i = 0; i < req.pages.length; i++) {
        const canvas = await bitmapToCanvas(req.pages[i]);
        const { data } = await worker.recognize(canvas);
        const lines: PageOcr["lines"] = (data.lines ?? []).map((l) => ({
          text: l.text,
          bbox: { x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1 },
          confidence: l.confidence,
        }));
        out.push({ pageIndex: i, text: data.text, lines });
      }
      const elapsed_ms = Math.round(performance.now() - t0);
      (self as unknown as Worker).postMessage({
        type: "done",
        jobId: req.jobId,
        pages: out,
        elapsed_ms,
        version: "5.1.1",
      } satisfies Response);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      (self as unknown as Worker).postMessage({ type: "error", jobId: req.jobId, reason } satisfies Response);
    }
  }
});

export {}; // make this a module
```

- [ ] **Step 5: Verify typecheck passes**

```bash
npm --workspace apps/desktop run typecheck
```

Expected: green. If `tesseract.js`'s `Worker` type clashes with the DOM `Worker` global, qualify the import alias to `TWorker`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/invoices/extraction/worker.ts apps/desktop/src/lib/invoices/extraction/pdfjs-worker-setup.ts apps/desktop/src/main.tsx
git commit -m "feat(3b): tesseract.js Web Worker host + pdfjs worker wiring"
```

---

## Task 8: Stage orchestrator — `pipeline.ts`

Ties stages 0 → 1 → 2 together. Uses an injected worker-factory so tests can swap a fake.

**Files:**
- Create: `apps/desktop/src/lib/invoices/extraction/pipeline.ts`
- Test: `apps/desktop/src/lib/invoices/extraction/pipeline.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { runPipeline } from "./pipeline";
import type { PageOcr } from "./types";

const fakePages: PageOcr[] = [{ pageIndex: 0, text: "Total: $42.00", lines: [{ text: "Total: $42.00", bbox: { x0: 0, y0: 800, x1: 100, y1: 820 }, confidence: 95 }] }];

describe("runPipeline", () => {
  it("emits two pipeline.stages entries in order (layout-ocr then schema-extraction)", async () => {
    const fakeOcr = vi.fn(async () => ({ pages: fakePages, elapsed_ms: 100, version: "5.1.1" }));
    const fakeRasterise = vi.fn(async () => ({ pages: [{} as ImageBitmap], pageCount: 1 }));
    const result = await runPipeline(new Blob([], { type: "image/png" }), { rasterise: fakeRasterise, ocr: fakeOcr });
    expect(result.stages.map((s) => s.name)).toEqual(["layout-ocr", "schema-extraction"]);
    expect(result.body.total).toBe(42);
  });

  it("propagates OCR worker errors as a thrown failure with reason", async () => {
    const fakeOcr = vi.fn(async () => { throw new Error("WASM init failed"); });
    const fakeRasterise = vi.fn(async () => ({ pages: [{} as ImageBitmap], pageCount: 1 }));
    await expect(runPipeline(new Blob([], { type: "image/png" }), { rasterise: fakeRasterise, ocr: fakeOcr }))
      .rejects.toThrow(/WASM init failed/);
  });

  it("records elapsed_ms on stage 1", async () => {
    const fakeOcr = vi.fn(async () => ({ pages: fakePages, elapsed_ms: 1234, version: "5.1.1" }));
    const fakeRasterise = vi.fn(async () => ({ pages: [{} as ImageBitmap], pageCount: 1 }));
    const result = await runPipeline(new Blob([], { type: "image/png" }), { rasterise: fakeRasterise, ocr: fakeOcr });
    expect(result.stages[0].elapsed_ms).toBe(1234);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --workspace apps/desktop test -- extraction/pipeline
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `pipeline.ts`**

```ts
import type { ExtractionResult, PageOcr, Stage0Output } from "./types";
import { rasterise as defaultRasterise } from "./rasterise";
import { extractFields } from "./rules";

export interface OcrFn {
  (pages: ImageBitmap[]): Promise<{ pages: PageOcr[]; elapsed_ms: number; version: string }>;
}

export interface PipelineDeps {
  rasterise?: (blob: Blob) => Promise<Stage0Output>;
  ocr: OcrFn;
}

export async function runPipeline(blob: Blob, deps: PipelineDeps): Promise<ExtractionResult> {
  const rasterise = deps.rasterise ?? defaultRasterise;
  const stage0 = await rasterise(blob);
  const stage1 = await deps.ocr(stage0.pages);
  const stage2 = extractFields(stage1.pages);
  return {
    stages: [
      { name: "layout-ocr", model: "tesseract.js", version: stage1.version, elapsed_ms: stage1.elapsed_ms },
      ...stage2.stages,
    ],
    body: stage2.body,
    field_confidences: stage2.field_confidences,
    warnings: stage2.warnings,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --workspace apps/desktop test -- extraction/pipeline
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/invoices/extraction/pipeline.ts apps/desktop/src/lib/invoices/extraction/pipeline.test.ts
git commit -m "feat(3b): three-stage pipeline orchestrator"
```

---

## Task 9: `ExtractionService` singleton with queue

Owns the Worker, queues jobs at concurrency=1, dispatches results/errors back into the store.

**Files:**
- Create: `apps/desktop/src/lib/invoices/extraction/index.ts`
- Test: `apps/desktop/src/lib/invoices/extraction/index.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtractionService } from "./index";

interface FakeStore {
  markExtractionRunning: ReturnType<typeof vi.fn>;
  applyExtraction: ReturnType<typeof vi.fn>;
  markExtractionFailed: ReturnType<typeof vi.fn>;
}

function fakeStore(): FakeStore {
  return {
    markExtractionRunning: vi.fn(),
    applyExtraction: vi.fn(),
    markExtractionFailed: vi.fn(),
  };
}

describe("ExtractionService", () => {
  let store: FakeStore;
  beforeEach(() => { store = fakeStore(); });

  it("enqueue moves invoice through running -> extracted (happy path)", async () => {
    let resolveOcr: (v: { pages: []; elapsed_ms: number; version: string }) => void = () => {};
    const ocr = vi.fn(() => new Promise<{ pages: []; elapsed_ms: number; version: string }>((r) => { resolveOcr = r; }));
    const rasterise = vi.fn(async () => ({ pages: [], pageCount: 0 }));
    const svc = new ExtractionService(store, { ocr, rasterise });
    const done = svc.enqueue("inv_1", new Blob([], { type: "image/png" }));
    // synchronously moved to running
    expect(store.markExtractionRunning).toHaveBeenCalledWith("inv_1");
    resolveOcr({ pages: [], elapsed_ms: 50, version: "5.1.1" });
    await done;
    expect(store.applyExtraction).toHaveBeenCalledWith("inv_1", expect.objectContaining({
      stages: expect.any(Array),
    }));
  });

  it("enqueue calls markExtractionFailed on worker error", async () => {
    const ocr = vi.fn(async () => { throw new Error("WASM init failed"); });
    const rasterise = vi.fn(async () => ({ pages: [], pageCount: 0 }));
    const svc = new ExtractionService(store, { ocr, rasterise });
    await svc.enqueue("inv_1", new Blob([], { type: "image/png" }));
    expect(store.markExtractionFailed).toHaveBeenCalledWith("inv_1", expect.stringContaining("WASM init failed"));
  });

  it("concurrency=1: second enqueue waits for first to finish", async () => {
    const order: string[] = [];
    const ocr = vi.fn(async () => { order.push("ocr"); return { pages: [] as [], elapsed_ms: 1, version: "5.1.1" }; });
    const rasterise = vi.fn(async () => { order.push("ras"); return { pages: [], pageCount: 0 }; });
    const svc = new ExtractionService(store, { ocr, rasterise });
    const a = svc.enqueue("inv_a", new Blob([], { type: "image/png" }));
    const b = svc.enqueue("inv_b", new Blob([], { type: "image/png" }));
    await Promise.all([a, b]);
    // expect first job's ras+ocr to complete before second starts
    expect(order).toEqual(["ras", "ocr", "ras", "ocr"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --workspace apps/desktop test -- extraction/index
```

Expected: FAIL — `ExtractionService` not exported.

- [ ] **Step 3: Implement `index.ts`**

```ts
import { runPipeline, type OcrFn } from "./pipeline";
import type { ExtractionResult, Stage0Output } from "./types";

export interface ExtractionStoreSlice {
  markExtractionRunning: (id: string) => void;
  applyExtraction: (id: string, result: ExtractionResult) => void;
  markExtractionFailed: (id: string, error: string) => void;
}

export interface ExtractionDeps {
  ocr: OcrFn;
  rasterise?: (blob: Blob) => Promise<Stage0Output>;
}

interface QueueEntry { invoiceId: string; blob: Blob; resolve: () => void }

export class ExtractionService {
  private queue: QueueEntry[] = [];
  private running = false;

  constructor(private store: ExtractionStoreSlice, private deps: ExtractionDeps) {}

  enqueue(invoiceId: string, blob: Blob): Promise<void> {
    this.store.markExtractionRunning(invoiceId);
    return new Promise<void>((resolve) => {
      this.queue.push({ invoiceId, blob, resolve });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      try {
        const result = await runPipeline(entry.blob, this.deps);
        this.store.applyExtraction(entry.invoiceId, result);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.store.markExtractionFailed(entry.invoiceId, reason);
      } finally {
        entry.resolve();
      }
    }
    this.running = false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --workspace apps/desktop test -- extraction/index
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/invoices/extraction/index.ts apps/desktop/src/lib/invoices/extraction/index.test.ts
git commit -m "feat(3b): ExtractionService singleton + concurrency=1 queue"
```

---

## Task 10: Real worker wiring — `extractionService` singleton boot

Wires the Web Worker into a real `OcrFn` and exports a process-wide singleton for the UI to call.

**Files:**
- Modify: `apps/desktop/src/lib/invoices/extraction/index.ts`

- [ ] **Step 1: Add the singleton + real-worker `OcrFn` factory**

Append to `apps/desktop/src/lib/invoices/extraction/index.ts`:

```ts
import { useInvoicesStore } from "@/stores/invoices";
import type { PageOcr } from "./types";

interface WorkerDoneMsg { type: "done"; jobId: string; pages: PageOcr[]; elapsed_ms: number; version: string }
interface WorkerErrMsg { type: "error"; jobId: string; reason: string }

let workerPromise: Promise<Worker> | null = null;

function bootWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    // Vite worker import — bundles the entrypoint as a Web Worker.
    const TesseractWorker = (await import("./worker.ts?worker")).default;
    return new TesseractWorker();
  })();
  return workerPromise;
}

let jobCounter = 0;

const realOcr: OcrFn = async (pages: ImageBitmap[]) => {
  const worker = await bootWorker();
  const jobId = `job_${++jobCounter}`;
  return await new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<WorkerDoneMsg | WorkerErrMsg>) => {
      if (e.data.jobId !== jobId) return;
      worker.removeEventListener("message", onMsg as EventListener);
      if (e.data.type === "done") {
        resolve({ pages: e.data.pages, elapsed_ms: e.data.elapsed_ms, version: e.data.version });
      } else {
        reject(new Error(e.data.reason));
      }
    };
    worker.addEventListener("message", onMsg as EventListener);
    worker.postMessage({ type: "recognize", jobId, pages }, pages);
  });
};

let _singleton: ExtractionService | null = null;
export function extractionService(): ExtractionService {
  if (_singleton) return _singleton;
  const slice: ExtractionStoreSlice = {
    markExtractionRunning: useInvoicesStore.getState().markExtractionRunning,
    applyExtraction: useInvoicesStore.getState().applyExtraction,
    markExtractionFailed: useInvoicesStore.getState().markExtractionFailed,
  };
  _singleton = new ExtractionService(slice, { ocr: realOcr });
  return _singleton;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm --workspace apps/desktop run typecheck
```

Expected: green. If Vite's `?worker` import type isn't recognised, add to `apps/desktop/src/vite-env.d.ts`:

```ts
declare module "*?worker" {
  const Ctor: new () => Worker;
  export default Ctor;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/invoices/extraction/index.ts apps/desktop/src/vite-env.d.ts
git commit -m "feat(3b): extractionService singleton with real Web Worker"
```

---

## Task 11: `NewInvoiceForm` — drop sync wait, enqueue + navigate

**Files:**
- Modify: `apps/desktop/src/features/invoices/NewInvoiceForm.tsx`
- Modify: `apps/desktop/src/features/invoices/NewInvoiceForm.test.tsx`

- [ ] **Step 1: Read current `NewInvoiceForm.test.tsx` to understand what tests exist**

```bash
cat apps/desktop/src/features/invoices/NewInvoiceForm.test.tsx
```

- [ ] **Step 2: Add a test that the form calls `extractionService().enqueue` after addInvoice and before navigate**

Append to `NewInvoiceForm.test.tsx`:

```ts
import { extractionService } from "@/lib/invoices/extraction";

vi.mock("@/lib/invoices/extraction", () => {
  const enqueue = vi.fn();
  return { extractionService: () => ({ enqueue }) };
});

it("enqueues extraction and navigates without awaiting it", async () => {
  // ...arrange: render form, pick vendor, drop a file
  // ...act: click Continue
  // ...assert: extractionService().enqueue called once with (newInvoiceId, file)
  // ...assert: navigate called with /invoices/<id>/review
  // (fill in using the existing render helpers in this test file)
});
```

(Use the existing render helpers from the file; this is a sketch — the helpers and the exact arrange-step depend on what's already there.)

- [ ] **Step 3: Run test to verify it fails**

```bash
npm --workspace apps/desktop test -- NewInvoiceForm
```

Expected: FAIL — `extractionService` not yet called.

- [ ] **Step 4: Modify `NewInvoiceForm.tsx` to enqueue without awaiting**

```ts
import { extractionService } from "@/lib/invoices/extraction";

// inside onContinue, after addInvoice(invoice):
extractionService().enqueue(invoice.id, file);
navigate(`/invoices/${invoice.id}/review`);
```

Remove `await` if any was wrapping a hypothetical extraction call (3a doesn't have one, so this is just additive).

- [ ] **Step 5: Run all related tests**

```bash
npm --workspace apps/desktop test -- NewInvoiceForm
npm --workspace apps/desktop run typecheck
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/features/invoices/NewInvoiceForm.tsx apps/desktop/src/features/invoices/NewInvoiceForm.test.tsx
git commit -m "feat(3b): NewInvoiceForm enqueues extraction + navigates immediately"
```

---

## Task 12: `useExtractionLive` hook

**Files:**
- Create: `apps/desktop/src/features/invoices/hooks/useExtractionLive.ts`
- Test: `apps/desktop/src/features/invoices/hooks/useExtractionLive.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useExtractionLive } from "./useExtractionLive";
import { useInvoicesStore } from "@/stores/invoices";

const blank = (id: string) => ({
  id, createdAt: "t", updatedAt: "t", schema_version: "0.1.0" as const,
  intake: { source: "manual-upload" as const, received_at: "t", raw_file: { sha256: "0".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "s://x" } },
  invoice: { flow: "one-off-vendor" as const, payee: { kind: "vendor" as const, display_name: "" }, currency: "AUD", total: 0 },
  extraction: { pipeline: { stages: [] }, extracted_at: "t" },
  approval: { status: "draft" as const },
});

describe("useExtractionLive", () => {
  beforeEach(() => useInvoicesStore.setState({ invoices: [] }));

  it("returns current status and updates when store changes", () => {
    act(() => { useInvoicesStore.getState().addInvoice(blank("inv_1")); });
    const { result } = renderHook(() => useExtractionLive("inv_1"));
    expect(result.current.status).toBe("pending");
    act(() => { useInvoicesStore.getState().markExtractionRunning("inv_1"); });
    expect(result.current.status).toBe("running");
  });

  it("returns null status when invoice not found", () => {
    const { result } = renderHook(() => useExtractionLive("nope"));
    expect(result.current.status).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --workspace apps/desktop test -- useExtractionLive
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the hook**

```ts
import { useInvoicesStore } from "@/stores/invoices";
import type { ExtractionStatus } from "@/stores/invoices";

export interface ExtractionLive {
  status: ExtractionStatus | null;
  error: string | undefined;
  confidences: Record<string, number>;
  warnings: NonNullable<import("@chain-pay/shared").Invoice["extraction"]["warnings"]>;
}

export function useExtractionLive(invoiceId: string): ExtractionLive {
  return useInvoicesStore((s) => {
    const inv = s.invoices.find((i) => i.id === invoiceId);
    if (!inv) {
      return { status: null, error: undefined, confidences: {}, warnings: [] };
    }
    return {
      status: inv.extractionStatus,
      error: inv.extractionError,
      confidences: inv.extraction.field_confidences ?? {},
      warnings: inv.extraction.warnings ?? [],
    };
  });
}
```

If `ExtractionStatus` isn't exported from `invoices.ts`, add `export` to its declaration in Task 3's diff. (Do that fix now — small.)

- [ ] **Step 4: Run test to verify it passes**

```bash
npm --workspace apps/desktop test -- useExtractionLive
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/invoices/hooks/useExtractionLive.ts apps/desktop/src/features/invoices/hooks/useExtractionLive.test.ts apps/desktop/src/stores/invoices.ts
git commit -m "feat(3b): useExtractionLive hook"
```

---

## Task 13: `ReviewInvoiceForm` — three render states + confidence chips + retry

**Files:**
- Modify: `apps/desktop/src/features/invoices/ReviewInvoiceForm.tsx`
- Modify: `apps/desktop/src/features/invoices/ReviewInvoiceForm.test.tsx`

- [ ] **Step 1: Write failing tests for the three states**

Append to `ReviewInvoiceForm.test.tsx`:

```ts
import { useInvoicesStore } from "@/stores/invoices";

vi.mock("@/lib/invoices/extraction", () => {
  const enqueue = vi.fn();
  return { extractionService: () => ({ enqueue }) };
});

describe("ReviewInvoiceForm — extraction states", () => {
  it("shows shimmer banner while running", () => {
    // arrange: add invoice with extractionStatus=running
    // render form
    // assert: 'Extracting…' banner visible; inputs still editable
  });

  it("shows confidence chip when field_confidences[field] < 0.85", () => {
    // arrange: add invoice with extractionStatus=extracted + field_confidences={total: 0.5}
    // assert: amber chip on total input
  });

  it("shows failure banner with Retry on failed", () => {
    // arrange: add invoice with extractionStatus=failed, extractionError="WASM init failed"
    // assert: banner says "Auto-extraction failed: WASM init failed"
    // act: click Retry
    // assert: extractionService().enqueue called once
  });
});
```

(Flesh out the arrange/act steps using whatever render helpers already exist in the test file.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --workspace apps/desktop test -- ReviewInvoiceForm
```

Expected: FAIL — UI doesn't yet render shimmer, chips, or retry.

- [ ] **Step 3: Modify `ReviewInvoiceForm.tsx`**

Add at the top of the component body, after the existing hooks:

```tsx
import { useExtractionLive } from "./hooks/useExtractionLive";
import { extractionService } from "@/lib/invoices/extraction";
import { fileFromStorage } from "@/lib/invoices/file-storage"; // existing in 3a

const live = useExtractionLive(invoiceId);
const isExtracting = live.status === "running" || live.status === "pending";
const isFailed = live.status === "failed";

async function onRetry() {
  if (!invoice) return;
  const file = await fileFromStorage(invoice.intake.raw_file.storage_uri);
  extractionService().enqueue(invoiceId, file);
}

function chipFor(field: string) {
  const c = live.confidences[field];
  return c !== undefined && c < 0.85
    ? <span className="text-xs text-amber-600 ml-2">Low confidence — please check</span>
    : null;
}
```

Render the banners/chips:

```tsx
{isExtracting && <div className="rounded bg-blue-50 p-2 text-sm">Extracting…</div>}
{isFailed && (
  <div className="rounded bg-red-50 p-2 text-sm">
    Auto-extraction failed: {live.error}.{" "}
    <button type="button" onClick={onRetry} className="underline">Retry</button>
  </div>
)}
```

And next to inputs that have a confidence-keyed field, e.g.:

```tsx
<label>
  Total {chipFor("total")}
  <input ... />
</label>
```

(`fileFromStorage` should already exist from 3a; check `apps/desktop/src/lib/invoices/file-storage.ts`. If it doesn't expose a reader, add one. The 3a plan referenced an IPC `electron.invoiceFiles.read`.)

- [ ] **Step 4: Run all related tests**

```bash
npm --workspace apps/desktop test -- ReviewInvoiceForm
npm --workspace apps/desktop run typecheck
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/invoices/ReviewInvoiceForm.tsx apps/desktop/src/features/invoices/ReviewInvoiceForm.test.tsx
git commit -m "feat(3b): ReviewInvoiceForm extraction states + confidence chips + retry"
```

---

## Task 14: `canBundle` pure eligibility check

**Files:**
- Create: `apps/desktop/src/lib/invoices/bundling.ts`
- Test: `apps/desktop/src/lib/invoices/bundling.test.ts`

- [ ] **Step 1: Write failing table-driven tests**

```ts
import { describe, it, expect } from "vitest";
import type { StoredInvoiceRecord } from "@/stores/invoices";
import { canBundle } from "./bundling";

function inv(overrides: Partial<StoredInvoiceRecord> = {}): StoredInvoiceRecord {
  return {
    id: overrides.id ?? "inv_x",
    createdAt: "t", updatedAt: "t", schema_version: "0.1.0",
    intake: { source: "manual-upload", received_at: "t", raw_file: { sha256: "0".repeat(64), mime_type: "application/pdf", byte_size: 1, filename: "x.pdf", storage_uri: "s://x" } },
    invoice: {
      flow: "one-off-vendor",
      payee: { kind: "vendor", display_name: "" },
      currency: "AUD",
      total: 100,
      payment_details: { ckb_address: "ckt1abc" },
    },
    extraction: { pipeline: { stages: [] }, extracted_at: "t" },
    approval: { status: "in-review" },
    extractionStatus: "extracted",
    ...overrides,
  };
}

describe("canBundle", () => {
  it("ok: two AUD one-off-vendor invoices with CKB addresses", () => {
    expect(canBundle([inv({ id: "a" }), inv({ id: "b" })])).toEqual({ ok: true });
  });

  it("fail: mixed currencies", () => {
    const r = canBundle([inv({ id: "a" }), inv({ id: "b", invoice: { ...inv().invoice, currency: "USD" } })]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/currency/i);
  });

  it("fail: extraction still running", () => {
    const r = canBundle([inv({ id: "a" }), inv({ id: "b", extractionStatus: "running" })]);
    expect(r.ok).toBe(false);
  });

  it("fail: employee-payment flow not bundle-eligible (use PayrollBatch)", () => {
    const r = canBundle([inv({ id: "a", invoice: { ...inv().invoice, flow: "employee-payment" } })]);
    expect(r.ok).toBe(false);
  });

  it("fail: missing CKB address", () => {
    const r = canBundle([inv({ id: "a", invoice: { ...inv().invoice, payment_details: {} } })]);
    expect(r.ok).toBe(false);
  });

  it("fail: fewer than 2", () => {
    expect(canBundle([inv()]).ok).toBe(false);
    expect(canBundle([]).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --workspace apps/desktop test -- bundling
```

Expected: FAIL — `canBundle` missing.

- [ ] **Step 3: Implement `bundling.ts`**

```ts
import type { StoredInvoiceRecord } from "@/stores/invoices";

export type CanBundleResult = { ok: true } | { ok: false; reason: string };

const BUNDLE_FLOWS = new Set(["one-off-vendor", "recurring-vendor"]);

export function canBundle(invoices: StoredInvoiceRecord[]): CanBundleResult {
  if (invoices.length < 2) return { ok: false, reason: "Select at least two invoices to bundle." };

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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --workspace apps/desktop test -- bundling
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/invoices/bundling.ts apps/desktop/src/lib/invoices/bundling.test.ts
git commit -m "feat(3b): canBundle eligibility check"
```

---

## Task 15: `InvoiceList` checkbox column + selection state lifted to page

**Files:**
- Modify: `apps/desktop/src/features/invoices/InvoiceList.tsx`
- Modify: `apps/desktop/src/features/invoices/InvoiceList.test.tsx`

- [ ] **Step 1: Add a failing test**

Append:

```ts
it("renders a checkbox per row in 'in-review' section and reports selection up", () => {
  // arrange: store with two in-review invoices
  const onSelectionChange = vi.fn();
  render(<InvoiceList onSelectionChange={onSelectionChange} />, { wrapper: MemoryRouter });
  const checks = screen.getAllByRole("checkbox");
  fireEvent.click(checks[0]);
  expect(onSelectionChange).toHaveBeenCalledWith(new Set([/* the first invoice id */]));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --workspace apps/desktop test -- InvoiceList
```

Expected: FAIL.

- [ ] **Step 3: Modify `InvoiceList.tsx`**

```tsx
interface InvoiceListProps {
  onSelectionChange?: (selected: Set<string>) => void;
}

export function InvoiceList({ onSelectionChange }: InvoiceListProps = {}) {
  const invoices = useInvoicesStore((s) => s.invoices);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
    onSelectionChange?.(next);
  }

  // inside the in-review row render, add a leading <td>:
  // <input type="checkbox" checked={selected.has(invoice.id)} onChange={() => toggle(invoice.id)} />
  // ...
}
```

Other sections do not gain checkboxes — only `in-review` (and `draft` if you decide to allow it; bundling rule allows both). Match the eligibility scope.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --workspace apps/desktop test -- InvoiceList
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/invoices/InvoiceList.tsx apps/desktop/src/features/invoices/InvoiceList.test.tsx
git commit -m "feat(3b): InvoiceList multi-select checkbox column"
```

---

## Task 16: `InvoicesPage` — bundle toolbar + CTA

Wires selection from `InvoiceList` up to a toolbar that calls `canBundle` and (on click) constructs a `VendorPaymentBatch` with `invoiceIds: [...]` via the existing batch builder, then navigates.

**Files:**
- Modify: `apps/desktop/src/features/invoices/InvoicesPage.tsx`
- Modify: `apps/desktop/src/features/invoices/InvoicesPage.test.tsx`

- [ ] **Step 1: Locate the existing vendor batch builder**

```bash
grep -rn "VendorPaymentBatch" apps/desktop/src/lib apps/desktop/src/features --include='*.ts' --include='*.tsx' | head -20
```

Expected to surface a builder in `apps/desktop/src/lib/invoices/route-to-batch.ts` (from 3a). The builder previously took `(invoice, treasury)`. Adjust to take `(invoices[], treasury)` and produce one batch with `invoiceIds`. If the builder is a hot path for the existing single-invoice approve flow, leave it and add a parallel `routeInvoicesToBatch` for the bundle case.

- [ ] **Step 2: Add a failing test**

```ts
it("CTA disabled with currency-mismatch tooltip when selection is mixed", () => {
  // arrange: AUD + USD invoices in store, both in-review and extracted
  render(<InvoicesPage />, { wrapper: MemoryRouter });
  // act: click both checkboxes
  // assert: 'Bundle into batch' button is disabled
  // assert: tooltip / title includes 'currency'
});

it("clicking Bundle into batch creates one VendorPaymentBatch with invoiceIds", async () => {
  // arrange: two eligible AUD invoices
  // act: select both, click Bundle
  // assert: payrollBatchesStore (or wherever batches land) has one new VendorPaymentBatch with invoiceIds.length === 2
  // assert: navigate to /payments/<batchId>
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm --workspace apps/desktop test -- InvoicesPage
```

Expected: FAIL.

- [ ] **Step 4: Add toolbar + CTA to `InvoicesPage.tsx`**

```tsx
import { canBundle } from "@/lib/invoices/bundling";
import { routeInvoicesToBatch } from "@/lib/invoices/route-to-batch"; // add this if not present (see Step 1 outcome)

export function InvoicesPage() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const invoices = useInvoicesStore((s) => s.invoices);
  const treasury = useTreasuryStore((s) => s.active);
  const navigate = useNavigate();

  const selected = invoices.filter((i) => selectedIds.has(i.id));
  const eligibility = canBundle(selected);

  async function onBundle() {
    if (!eligibility.ok || !treasury) return;
    const batch = routeInvoicesToBatch(selected, treasury);
    // persist via the existing batches store action
    usePayrollBatchesStore.getState().addBatch(batch);
    // mark each invoice queued-for-signing with the same batchId
    for (const inv of selected) {
      useInvoicesStore.getState().markQueuedForSigning(inv.id, batch.id, CURRENT_USER_ID);
    }
    navigate(`/payments/${batch.id}`);
  }

  return (
    <div>
      <header>...</header>
      {selected.length >= 2 && (
        <div className="flex items-center gap-2 p-2">
          <button type="button" disabled={!eligibility.ok} onClick={onBundle}
                  title={eligibility.ok ? "" : eligibility.reason}>
            Bundle into batch ({selected.length})
          </button>
          {!eligibility.ok && <span className="text-xs">{eligibility.reason}</span>}
        </div>
      )}
      <InvoiceList onSelectionChange={setSelectedIds} />
    </div>
  );
}
```

- [ ] **Step 5: Add `routeInvoicesToBatch` if it doesn't exist**

In `apps/desktop/src/lib/invoices/route-to-batch.ts`:

```ts
export function routeInvoicesToBatch(invoices: StoredInvoiceRecord[], treasury: Treasury): VendorPaymentBatch {
  // mirror the existing route-to-batch shape; the only change is plural invoiceIds.
  // Reuse the existing builder's per-output construction by iterating invoices.
  // Identifier, timestamps, kind: "vendor", etc — keep consistent with existing single-invoice path.
  return {
    id: `vbatch_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // ...other VendorPaymentBatch fields populated from invoices + treasury
    invoiceIds: invoices.map((i) => i.id),
    // ...
  };
}
```

(Use the existing single-invoice builder as the template — match its field-by-field shape; iterate where it used to take `invoice` singular.)

- [ ] **Step 6: Run all related tests**

```bash
npm --workspace apps/desktop test -- InvoicesPage
npm --workspace apps/desktop test
npm --workspace apps/desktop run typecheck
```

Expected: green across the workspace.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/features/invoices/InvoicesPage.tsx apps/desktop/src/features/invoices/InvoicesPage.test.tsx apps/desktop/src/lib/invoices/route-to-batch.ts
git commit -m "feat(3b): InvoicesPage bundle toolbar + CTA"
```

---

## Task 17: Smoke playbook doc

**Files:**
- Create: `docs/phase-3b-smoke-playbook.md`

- [ ] **Step 1: Write the playbook**

Create `docs/phase-3b-smoke-playbook.md`:

```markdown
# Phase 3b Smoke Playbook

**Goal:** verify OCR extraction + multi-invoice bundling end-to-end against the desktop app.

## Setup

1. Pull `feat/phase-3b-ocr-bundling`, run `npm install`, then `npm run dev:desktop`.
2. Have ready: a clean AUD PDF invoice, a photographed receipt (JPG/PNG), and a password-protected PDF.

## Cases

### 1. Clean PDF — happy path
- New invoice → one-off-vendor → pick a vendor → drop the clean PDF → Continue.
- Review form opens within ~1s with shimmer in fields.
- Within ~30s fields populate. Confidence chips appear on `payee.display_name` (low) and absent on `total` (high).
- Approve & queue → batch opens.

### 2. Photographed receipt
- Same flow with a photographed receipt.
- Fields populate partially; warning banner says "We couldn't read much — please check all fields."
- Form remains editable; manual entry completes the workflow.

### 3. Password-protected PDF
- Same flow with a password-protected PDF.
- Review form opens; "Auto-extraction failed: PDF is password-protected. [Retry]"
- Manual fill completes the workflow.

### 4. User-typing race
- Drop a PDF; immediately type a vendor name in the review form.
- When extraction lands ~20s later, vendor name is preserved; other fields populate.

### 5. Bundle happy path
- Have two AUD vendor invoices both `in-review` and `extracted` with CKB addresses.
- InvoicesPage → select both → "Bundle into batch (2)" enabled.
- Click → new VendorPaymentBatch opens with two outputs.

### 6. Bundle currency mismatch
- One AUD + one USD selected.
- CTA disabled; tooltip explains currency mismatch.
```

- [ ] **Step 2: Commit**

```bash
git add docs/phase-3b-smoke-playbook.md
git commit -m "docs(3b): phase 3b smoke playbook"
```

---

## Task 18: Whole-branch verification + PR

**Files:** none

- [ ] **Step 1: Run full workspace checks**

```bash
npm run typecheck
npm --workspace apps/desktop test
npm --workspace packages/shared test
npm --workspace apps/desktop run lint
```

Expected: green across the board. Fix any spillover before opening PR.

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin feat/phase-3b-ocr-bundling
gh pr create --title "feat(3b): OCR extraction + multi-invoice bundling" --body "$(cat <<'EOF'
## Summary
- Three-stage extraction pipeline (rasterise → tesseract.js worker → rules) populates the existing `extraction.pipeline.stages` slots; no schema bump.
- `VendorPaymentBatch.invoiceId` → `invoiceIds: string[]` (hard rename — no real-fund vendor batches on main yet).
- Async-inline UX: `NewInvoiceForm` enqueues + navigates immediately; `ReviewInvoiceForm` renders pending/running, extracted (with confidence chips), and failed (with retry) states.
- `InvoiceList` multi-select + `InvoicesPage` "Bundle into batch" CTA, gated on `canBundle` (same currency, same CKB chain, both extracted, both draft/in-review).

## Test plan
- [ ] Drop a real PDF — fields populate; high-confidence total, low-confidence vendor name.
- [ ] Drop a photographed receipt — partial fields + warning banner; form usable manually.
- [ ] Drop a password-protected PDF — failed banner with retry; manual fill works.
- [ ] Type a vendor name before extraction lands; it's preserved.
- [ ] Bundle two AUD vendor invoices → one VendorPaymentBatch with 2 outputs.
- [ ] Bundle AUD + USD → CTA disabled with reason.

EOF
)"
```

- [ ] **Step 3: Watch CI to green**

```bash
gh pr checks --watch
```

Expected: all green.

---

## Self-Review

**Spec coverage**

- Architecture (three stages + worker boundary): Tasks 4–10 ✓
- `VendorPaymentBatch` plural rename: Task 2 ✓
- `extractionStatus` on the wrapper + idempotent `applyExtraction` + user-typed-preserve merge: Task 3 ✓
- v1 field rules (total, currency, invoice number, dates, vendor name heuristic, BSB, CKB, EVM): Task 5 ✓
- `NewInvoiceForm` async fire-and-forget: Task 11 ✓
- `ReviewInvoiceForm` three render states + confidence chips + retry: Tasks 12–13 ✓
- `canBundle` eligibility: Task 14 ✓
- `InvoiceList` multi-select + `InvoicesPage` CTA: Tasks 15–16 ✓
- Failure taxonomy (worker boot, password PDF, NaN total, timeout): covered by `markExtractionFailed` paths in Tasks 3, 6, 9; user messages in Task 13's UI.
- Retry semantics — appended stages (not overwrites): Task 3's idempotency lets retries append; Task 13 wires the Retry button.
- Manual smoke: Task 17 ✓
- Whole-branch verification: Task 18 ✓

**Placeholder scan**

- No "TBD" / "implement later" steps.
- Test arrange blocks in Tasks 11/13/15/16 leave room ("use existing render helpers" / "fill in using the existing helpers") because the 3a test files have their own setup — fully specifying it would require copy-pasting that setup. Acceptable in a plan; the implementer reads the existing test files and matches the pattern.
- Task 16 Step 5 says "use the existing single-invoice builder as the template — match its field-by-field shape." This is unavoidable without inlining the entire builder, which exists in 3a code. The implementer will discover it via Task 16 Step 1's grep.

**Type consistency**

- `ExtractionResult.stages` — defined in Task 4, populated by `extractFields` in Task 5, returned by `runPipeline` in Task 8, passed to `applyExtraction` in Task 3 and consumed by Task 9. Consistent across all uses.
- `PageOcr.lines[].confidence` is `0-100` (tesseract.js native scale) — noted in `types.ts` comment; `rules.ts` doesn't normalize, but `field_confidences` it emits are in `0-1`. No conflict because the two confidence domains don't mix.
- `markExtractionRunning` / `applyExtraction` / `markExtractionFailed` action names — consistent across Tasks 3, 9, 10, 12.
- `extractionService()` (function returning singleton) vs `ExtractionService` (class) — distinct names; usage matches in Tasks 9, 10, 11, 13.
- `canBundle` return shape `{ ok: true } | { ok: false; reason: string }` — consistent in Tasks 14 and 16.
- `routeInvoicesToBatch` (plural) introduced in Task 16, expected to exist as new sibling of existing 3a `routeInvoiceToBatch`. Task 16 Step 5 covers the case where it must be added.

**Gaps fixed inline**

- Added explicit note in Task 12 Step 3 to export `ExtractionStatus` from the store (small backfill on Task 3).
- Task 10 Step 2 includes the Vite `?worker` module declaration to head off a TS error at first build.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-31-phase-3b-ocr-and-bundling.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration. Matches how 2.7c and 3a shipped on this repo (subagent-driven catches cross-task seam bugs that per-task TDD ships clean).

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
