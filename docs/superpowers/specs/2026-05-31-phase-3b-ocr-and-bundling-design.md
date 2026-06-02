# Phase 3b — Invoice OCR extraction + multi-invoice bundling

**Status:** spec, awaiting implementation plan
**Date:** 2026-05-31
**Builds on:** 3a (PR #7, `8a3b426`) — manual entry, payee + vendor flows, draft autosave, batch↔invoice confirmation sync
**Schema impact:** none — `extraction.pipeline.stages`, `field_confidences`, `warnings`, `raw_file.page_count` slots already exist at `InvoiceSchema` v0.1.0

## Goal

Two deliverables, one phase:

1. **OCR extraction** — when a user drops a PDF/image into the invoice ingest flow, auto-populate the review form's fields (total, dates, vendor name, payment details, etc.) as a non-blocking background extraction. Manual entry stays a peer-class path, not a fallback.
2. **Multi-invoice bundling** — let a user multi-select N vendor invoices on `InvoicesPage` and bundle them into a single `VendorPaymentBatch` that settles all N in one transaction. Each invoice maps to one output and (in Phase 4) one journal entry.

## Design pillars this is constrained by

- **Local-first.** No invoice content is shipped to a third-party API by default. Tesseract.js runs in the renderer's Web Worker. (Optional LLM-backed stages B/C are explicitly out of scope for v3b; the pipeline shape leaves room for them.)
- **Manual entry is never gated.** Auto-extraction is help, not a precondition. The review form is always editable, even mid-extraction.
- **Adapters stay adapters.** Bundling reshapes the `VendorPaymentBatch` model and the CKB tx builder consumes it transparently. The OCR pipeline knows nothing about chains.
- **Schema-first.** Existing `extraction` slots are populated; no version bump.

## Architecture

A two-stage pipeline runs in the renderer, with the OCR engine isolated in a dedicated Web Worker. Each stage corresponds to one entry in the existing `extraction.pipeline.stages` array.

```
NewInvoiceForm
  └─ storeBlob (existing, 3a)
  └─ createDraftInvoice(status: draft, extractionStatus: pending)
  └─ extractionService.enqueue(invoiceId, blob)   ◄── fire-and-forget
  └─ navigate(`/invoices/${invoiceId}/review`)

ExtractionService (renderer singleton, lazy-booted worker)
  │   queue: concurrency = 1
  ▼
  Stage 0 — rasterise  (main thread, pdfjs-dist for PDFs; pass-through for images)
      in:  PDF | PNG | JPG blob
      out: ImageBitmap[] (one per page) + page_count
      writes: invoice.intake.raw_file.page_count
  │
  ▼
  Stage 1 — `layout-ocr`  (Web Worker, tesseract.js)
      in:  ImageBitmap[]
      out: PageOcr[] where PageOcr = {
             pageIndex: number,
             text: string,
             lines: { text, bbox: {x0,y0,x1,y1}, confidence }[]
           }
      writes: pipeline.stages[0] = { name, model, version, elapsed_ms }
  │
  ▼
  Stage 2 — `schema-extraction`  (main thread, rules.ts, pure)
      in:  PageOcr[]
      out: Partial<InvoiceBody>, field_confidences, warnings
      writes: pipeline.stages[1] + populated body fields

invoicesStore.applyExtraction(invoiceId, result)
  │
  ▼
ReviewInvoiceForm subscribes → shimmer → populated fields w/ confidence chips
```

### Key boundaries

- `ExtractionService` is the only thing that imports Tesseract. Swappable.
- Stage 2 is a pure function `(rawText, hints) => { body, confidences, warnings }`. Trivially testable; LLM-backed replacement is a future drop-in.
- Bundling is a UI/store concern only — no new service.

### Files

**New**
- `apps/desktop/src/lib/invoices/extraction/rasterise.ts` — stage 0: PDF→ImageBitmap[] via pdfjs-dist; pass-through for images
- `apps/desktop/src/lib/invoices/extraction/worker.ts` — Tesseract host (Web Worker entrypoint)
- `apps/desktop/src/lib/invoices/extraction/pipeline.ts` — stage orchestrator (stage 0 → 1 → 2)
- `apps/desktop/src/lib/invoices/extraction/rules.ts` — stage 2 heuristics (pure, `PageOcr[] → { body, confidences, warnings }`)
- `apps/desktop/src/lib/invoices/extraction/types.ts` — shared `PageOcr`, `ExtractionResult` types
- `apps/desktop/src/lib/invoices/extraction/index.ts` — `ExtractionService` singleton
- `apps/desktop/src/lib/invoices/bundling.ts` — `canBundle(invoices)` eligibility check (pure)
- `docs/phase-3b-smoke-playbook.md` — manual smoke recipe

**Touched**
- `apps/desktop/src/stores/invoices.ts` — `extractionStatus` per record, `applyExtraction` action, idempotency guard
- `apps/desktop/src/features/invoices/NewInvoiceForm.tsx` — drop sync wait; enqueue + nav immediately
- `apps/desktop/src/features/invoices/ReviewInvoiceForm.tsx` — three render states (pending/running, extracted, failed); shimmer + confidence chips
- `apps/desktop/src/features/invoices/InvoicesPage.tsx` — multi-select toolbar + "Bundle into batch" CTA
- `apps/desktop/src/features/invoices/InvoiceList.tsx` — checkbox column
- `packages/shared/src/payroll-vendor.ts` (and tests) — `invoiceId: string` → `invoiceIds: string[]`
- Any consumer of `VendorPaymentBatch.invoiceId` in `apps/desktop/src/features/payroll/`

## Data model

### `VendorPaymentBatch` — singular → plural

```ts
// Before (current main)
interface VendorPaymentBatch {
  // ...
  invoiceId: string;
}

// After
interface VendorPaymentBatch {
  // ...
  invoiceIds: string[];   // one batch settles N invoices
}
```

Hard rename, not a migration — no real-fund vendor batches exist on main yet. The 1:1 invoice↔output mapping (load-bearing for Phase 4 journal entries) stays implicit via output ordering: `batch.invoiceIds[i]` ↔ `tx.outputs[i]`.

### `InvoiceRecord` — runtime extraction lifecycle

The durable `Invoice` schema is untouched (still `v0.1.0`). Runtime status lives on the wrapper layer 3a established:

```ts
export type ExtractionStatus = "pending" | "running" | "extracted" | "failed";

export interface InvoiceRecord extends Invoice {
  id: string;
  createdAt: string;
  updatedAt: string;
  extractionStatus: ExtractionStatus;
  extractionError?: string;   // populated only when failed
}
```

### Stage 2 v1 — extracted fields

YAGNI cut: stage 2 v1 targets the fields users most often type during 3a review.

| Field | Source signal | Confidence basis |
|---|---|---|
| `total` | "Total", "Amount due", largest currency-looking number near bottom | regex strength + position |
| `currency` | "AUD"/"USD"/"$"/"€" tokens | direct match |
| `invoice_number` | "Invoice #", "Invoice number" labels | label proximity |
| `issue_date` / `due_date` | "Issued", "Due" + `\d{1,2}/\d{1,2}/\d{2,4}` near label | label proximity + date validity |
| `payee.display_name` | Largest text in top 25% of page 1 | layout heuristic — low confidence by default |
| `payment_details.bank` (AUD) | BSB `\d{3}-\d{3}` + account `\d{6,10}` | regex strength |
| `payment_details.ckb_address` | bech32 pattern `ckb1…` / `ckt1…` | direct match |
| `payment_details.evm_address` | `0x[0-9a-f]{40}` | direct match |

**Deferred to 3c / LLM stage:** line items, tax-line breakdown, multi-page reconciliation, table extraction.

### Pipeline stage shape

Stage 1 writes:
```ts
{ name: "layout-ocr", model: "tesseract.js", version: "5.x.x", elapsed_ms: 4200 }
```

Stage 2 writes:
```ts
{ name: "schema-extraction", model: "rules-v1", version: "0.1.0", elapsed_ms: 12 }
```

Plus `field_confidences: Record<string, number>` and `warnings: { field, severity, message }[]` per the existing schema.

## Flow

### `NewInvoiceForm`

```ts
async function onContinue() {
  if (!canContinue || !file) return;
  setSubmitting(true);
  const { uri, sha256 } = await storeBlob(file);
  const invoice = buildDraftRecord({ file, uri, sha256, flow, vendor, employeeId });
  addInvoice(invoice);                            // status: "pending"
  extractionService.enqueue(invoice.id, file);    // fire-and-forget
  navigate(`/invoices/${invoice.id}/review`);
}
```

`submitting` is only a click debounce. Extraction does not block navigation.

### `ReviewInvoiceForm` — three states

Driven by `invoice.extractionStatus`:

- **`pending` / `running`** — input fields show shimmer placeholders; "Extracting…" banner with elapsed time; **the form is editable throughout**. When extraction lands, fields the user has not touched are auto-populated; fields the user has typed in are preserved.
- **`extracted`** — fields populated; each field with `field_confidences[field] < 0.85` gets a small amber chip "Low confidence — please check". Warnings render as inline hints under the relevant field.
- **`failed`** — banner "Auto-extraction failed: <reason>. [Retry]". Form is fully usable manually.

A `useExtractionLive(invoiceId)` hook subscribes to `invoicesStore` and returns `{ status, confidences, warnings }`. Strict-Mode-safe via the store's idempotent `applyExtraction` (lesson from 3a's double-effect bug).

### `InvoicesPage` — multi-select + bundle CTA

`InvoiceList` gains a checkbox column. Selection state is component-local. When ≥2 invoices are selected:

- **All eligible** → "Bundle into batch" CTA enabled. Click builds one `VendorPaymentBatch` with `invoiceIds: [...]`, navigates to existing batch review.
- **Ineligible (mixed currency / mixed flow / extraction not landed)** → CTA disabled with tooltip explaining why.

**Eligibility (v1)** — pure function `canBundle(invoices: InvoiceRecord[]) => { ok: true } | { ok: false; reason: string }`:

1. All selected are `approval.status ∈ {"draft", "in-review"}` with `extractionStatus === "extracted"` (not still extracting, not failed).
2. All have the same `invoice.currency`.
3. All have `invoice.flow ∈ {"one-off-vendor", "recurring-vendor"}`. Employee payments route through `PayrollBatch`, which already handles N outputs.
4. All have a payable address of the same chain kind. v1 gates the CTA on `chain === "ckb"`; EVM bundling unlocks when Phase 3 (EVM Safe) lands.

### Extraction worker lifecycle

- Single shared `Worker`, created on first `enqueue`.
- Internal queue, **concurrency = 1** (Tesseract WASM is single-threaded; parallel jobs thrash).
- Worker lives for the session — not terminated on route unmount. Cheap, avoids re-init.
- `enqueue` → store `pending → running`. Worker `done` → store applies result + `extracted`. Worker `error` → `failed` + `extractionError` set.

## Error handling

OCR failures are enumerated explicitly — silent zero-confidence fields are worse than clean failure.

### Failure taxonomy

| Failure | Surface | Status | User message |
|---|---|---|---|
| Worker fails to boot (WASM init, asset 404) | `enqueue` first call | `failed` | "Auto-extraction unavailable. Fill manually." |
| Unsupported MIME slips through (defence in depth — form filters too) | Worker | `failed` | "Couldn't read this file format." |
| PDF is encrypted / password-protected | Stage 0 (pdfjs-dist) | `failed` | "PDF is password-protected. Decrypt and re-upload." |
| PDF is structurally corrupt (pdfjs-dist throws) | Stage 0 | `failed` | "Couldn't open this PDF. Try re-exporting." |
| Image too small / blurry, Tesseract returns no text | Stage 1 success, stage 2 yields nothing | `extracted` with **every field below confidence** + top-level warning | "We couldn't read much — please check all fields." |
| Tesseract crashes mid-extraction | Worker `error` event | `failed` | "Auto-extraction crashed. [Retry]" |
| Stage 2 throws on malformed input (defensive) | Caught in `pipeline.ts` | `failed` | Same retry path |
| Total extracted but `NaN` / negative | Stage 2 validation | `extracted` but field is **not written**, warning emitted | Inline "Total looked invalid" |
| Extraction > 60s (runaway page count) | Per-job timeout | `failed` | "Took too long. Try splitting the PDF." |

**Principle: a partial result is not a failure.** If Tesseract finds text but rules only nail `total` and nothing else, status is `extracted` — `total` populates, other fields stay empty (shimmer off), `field_confidences` records the gaps. The form is always editable.

### Retry semantics

- `failed` invoices keep their `raw_file` blob. Retry re-reads same bytes via `fileFromStorage(invoice.intake.raw_file.storage_uri)`.
- **No automatic retry on first failure.** Silent retry hides bugs (lesson from 2.7b ack-loop tuning).
- Each retry appends a *new* entry to `pipeline.stages` — never overwrites. The schema is an array for a reason; provenance over time matters at audit.

### Bundling failure paths

- **Eligibility flips between selection and click** (e.g., extraction status changes mid-selection): CTA gracefully disables, no error toast.
- **Batch tx construction fails** (insufficient capacity for N outputs at current fee rate): existing batch builder surfaces this — no new error UI in 3b. Trust the seam (adapter stays adapter).
- **Concurrent invoice edits across windows:** out of scope. ChainPay is single-window desktop in v1.

### Deliberately out of scope for v3b

- **Page-by-page progress within one extraction.** Tesseract reports it; we show elapsed time only. LLM stage will report progress differently anyway.
- **Cancel mid-extraction.** Navigating away leaves the worker churning; status updates are idempotent.
- **Duplicate detection via `raw_file.sha256`.** 3a captures the hash; the "you already uploaded this" check is one query away but not a 3b deliverable. Tracked as a follow-up.

## Testing strategy

### Unit tests (vitest)

- **`rules.ts`** — table-driven, ~15-20 cases over real Tesseract output fixtures: clean AUD vendor, photographed receipt, BSB present, ABN present, CKB address, EVM address, mixed-currency edge, NaN-total guard, missing-everything fallback.
- **`pipeline.ts`** — mocked Tesseract host returning canned text. Covers stage ordering, `pipeline.stages` array shape, `elapsed_ms` recording, error propagation, retry appends not overwrites.
- **`ExtractionService`** — mocked pipeline. Covers concurrency=1 queueing, status transitions, enqueue-during-running queues correctly, worker boot failure → `failed` with reason.
- **`invoicesStore.applyExtraction`** — Strict-Mode idempotency (repeated apply of same result is a no-op), user-typed-fields-preserved merge logic, `field_confidences` populated, `pipeline.stages` appended not replaced.
- **`canBundle`** — table-driven over the v1 eligibility rules.
- **`payroll-vendor.ts`** — type-level assertion `VendorPaymentBatch.invoiceIds: string[]`, builder test for N-output → N-invoice mapping.

### Component tests (React Testing Library)

- **`NewInvoiceForm`** — file pick calls `enqueue` and navigates immediately; no `await` on extraction. Existing 3a tests stay green with minimal edits.
- **`ReviewInvoiceForm`** — three render-state tests against mocked store: shimmer, populated-with-confidence-chips, failed-with-retry. Plus: user-typed-field-preserved when extraction lands after typing.
- **`InvoicesPage`** — multi-select toolbar appears at selection ≥ 2; CTA enabled vs disabled per eligibility; clicking CTA calls the batch builder with `invoiceIds`.

### Not tested in v3b

- **Real Tesseract WASM in CI.** External dependency — we test our orchestration, not its output quality. Manual smoke covers it.
- **End-to-end OCR accuracy.** Confidence thresholds live in `rules.ts` as a tuning knob; failure mode is "amber chip", not "silently wrong value".
- **Worker lifecycle on app quit.** Trusts Electron unload.

### Manual smoke (`docs/phase-3b-smoke-playbook.md`)

1. Drop a real PDF invoice → review form opens → fields populate within ~30s with confidence chips.
2. Drop a photographed receipt → fields shimmer → most land low-confidence or empty; warning banner shown; form usable manually.
3. Drop a password-protected PDF → `failed` state → manual fill works.
4. Type a vendor name into the review form *before* extraction lands → typed value preserved when result arrives.
5. Two AUD vendor invoices → InvoicesPage → multi-select → "Bundle into batch" → review shows one batch with two outputs and `invoiceIds.length === 2`.
6. One AUD + one USD selected → CTA disabled with currency-mismatch tooltip.

### Coverage target

Global rule: 80%. The pure-function-shaped pipeline + table-driven rules tests should land well over that for new code.

## Out of scope (explicit)

- LLM-backed extraction stages (B: Tesseract + Ollama text-structuring; C: vision-LLM single-shot). The pipeline shape supports them as future drop-ins.
- Line item and tax-line extraction.
- Cross-chain bundling (`InvoiceBundle` entity above batches) — deferred until Phase 3 EVM Safe lands.
- Duplicate invoice detection via SHA-256.
- Per-page progress UI within a single extraction.
- Mid-extraction cancel.

## Open questions

None blocking. Tracked for later:

- **Confidence threshold tuning.** v1 ships at `0.85` across the board. Real fixtures will likely show per-field thresholds want adjustment (e.g., `total` more strict, `payee.display_name` more lenient). Hot-reloadable from `rules.ts` constants; not a schema change.
- **Worker asset bundling.** Three assets need Vite wiring: tesseract.js WASM core, tesseract `eng.traineddata`, and pdfjs-dist's own worker bundle. The light-client WASM integration (`@nervosnetwork/ckb-light-client-js`) already proves the renderer-WASM pattern; match its approach.
- **PDF rasterisation DPI.** Stage 0 picks a render DPI for `pdfjs-dist`. Too low → OCR misses small text; too high → memory blows up on multi-page docs. v1 ships at 200 DPI; tune from real fixtures.
