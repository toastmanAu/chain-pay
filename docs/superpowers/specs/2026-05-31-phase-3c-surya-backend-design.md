# Phase 3c — Surya remote OCR backend

**Status:** spec, awaiting implementation plan
**Date:** 2026-05-31
**Builds on:** Phase 3b (PR #8, OCR pipeline + bundling) — keeps the `OcrFn` seam in `extraction/index.ts`, generalises the orchestrator to also accept a `MapperFn`, adds a second backend behind a Settings toggle.
**Schema impact:** none — `extraction.pipeline.stages`, `field_confidences`, `warnings`, `line_items`, `tax_total`, `subtotal` slots already exist at `InvoiceSchema` v0.1.0. Phase 3b deferred populating the last three; Phase 3c populates them when the Surya backend is selected.

## Goal

Two deliverables, one phase:

1. **Surya backend** — a second extraction backend that swaps both stage 1 (OCR) and stage 2 (mapper). Stage 1 POSTs the rasterised page to a user-configured OpenAI-compatible Surya endpoint; stage 2 parses Surya's structured HTML response and populates the same `ExtractionResult` shape Phase 3b's `rules.ts` produces. User opts in via Settings; Tesseract stays the zero-config default.
2. **Line items + tax_total via Surya's table extraction** — Surya emits proper `<table>` HTML for tabular content. The new mapper walks the table and fills `Invoice.invoice.line_items` plus `tax_total` and `subtotal`. These fields stay empty when the Tesseract backend is selected.

## Design pillars this is constrained by

- **Local-first, user-controlled remote.** Surya runs on hardware the user owns (default ship URL `http://localhost:9991/v1`). No third-party cloud API.
- **Tesseract stays the zero-config default.** New ChainPay installs get the Phase 3b experience unchanged. Surya is an opt-in upgrade for users with a GPU / Apple Silicon / Snapdragon X / NVIDIA-MediaTek ARM box.
- **No silent fallback.** If the user chose Surya and Surya fails, surface the failure. Provenance over convenience.
- **Adapters stay adapters.** The pipeline orchestrator stays chain-agnostic; the new backend is purely an extraction concern.
- **Schema-first.** Existing extraction slots get populated. No version bump.

## Architecture

Phase 3b's pipeline already exposes the `OcrFn` injection seam. Phase 3c generalises it to also inject a `MapperFn`, so each backend supplies both stage 1 and stage 2.

```
NewInvoiceForm (unchanged from 3b)
  └─ extractionService().enqueue(invoiceId, blob)
       │
       ▼
ExtractionService.pump()  ◄── reads settings.extractionBackend at job start
       │
       ▼
runPipeline(blob, { rasterise, ocr, mapper })
  │
  ├── Stage 0 — rasterise (unchanged from 3b)
  │     in:  Blob (PDF/PNG/JPG)
  │     out: ImageBitmap[]
  │
  ├── Stage 1 — ocr  (backend-selected)
  │   ┌── tesseract (default): existing Web Worker → PageOcr[]
  │   └── surya-remote: POST page PNG to ${SURYA_URL}/v1/chat/completions
  │                     parse HTML response → PageOcr[] (PageOcr.text = full HTML)
  │
  └── Stage 2 — mapper  (backend-selected)
      ┌── tesseract: existing rules.ts extractFields → ExtractionResult
      └── surya-remote: new surya-mapper → ExtractionResult
                        walks Surya HTML blocks, fills:
                        - total, currency, invoice_number, dates
                        - payee.display_name (Section-Header / top-of-page)
                        - payment_details.bank, ckb_address, evm_address
                        - line_items, tax_total, subtotal (from <table>)
```

### Key boundaries

- `MapperFn` is `(pages: PageOcr[]) => ExtractionResult`. Both backends produce the same shape; `applyExtraction` in the store is unchanged.
- `surya-ocr.ts` is the only file that knows about the Surya HTTP endpoint shape. The mapper is pure (works on string input) — testable against fixture HTML.
- Settings are read at `pump()` time, not per-frame. Switching backend mid-extraction-job is benign: current job finishes on the old backend; the next uses the new one.

### Files added/touched

**New**
- `apps/desktop/src/lib/invoices/extraction/surya-ocr.ts` — stage 1 implementation: ImageBitmap → PNG Blob → base64 → POST → HTML response with well-formedness guard.
- `apps/desktop/src/lib/invoices/extraction/surya-mapper.ts` — stage 2 implementation: HTML → ExtractionResult.
- `apps/desktop/src/lib/invoices/extraction/surya-html.ts` — pure helpers: `parseBlocks(html)`, `parseTable(html)`, bbox parsing.
- `apps/desktop/src/lib/invoices/extraction/__fixtures__/surya/*.html` — captured real Surya responses for table-driven mapper tests.
- `apps/desktop/src/features/settings/ExtractionSection.tsx` — Settings UI section (mirrors `NetworkSection.tsx` pattern).
- `apps/desktop/src/lib/invoices/extraction/regex-shared.ts` — re-exports the regexes / parse helpers Phase 3b's `rules.ts` uses (`CURRENCY_TOKENS`, `parseCurrency`, `parseDate`, `BSB_RE`, `CKB_RE`, `EVM_RE`, `INVOICE_NUMBER_RE`, `ISSUED_RE`, `DUE_RE`). `rules.ts` imports from here; `surya-mapper.ts` imports from here. No duplication, no abstraction creep.
- `docs/phase-3c-smoke-playbook.md` — manual smoke recipe.

**Modified**
- `apps/desktop/src/stores/settings.ts` — add `extractionBackend`, `suryaEndpointUrl`, `suryaLastTestedAt`, `suryaLastTestResult` fields plus three actions.
- `apps/desktop/src/lib/invoices/extraction/types.ts` — add `MapperFn`, `BackendId`, `SuryaInfraError`, `SuryaContentError`.
- `apps/desktop/src/lib/invoices/extraction/pipeline.ts` — accept injected `mapper`; replace direct `extractFields()` call.
- `apps/desktop/src/lib/invoices/extraction/index.ts` — `extractionService()` reads settings, builds the right `{ ocr, mapper }` pair.
- `apps/desktop/src/lib/invoices/extraction/rules.ts` — import shared regexes from `regex-shared.ts` (no behaviour change).

## Settings store + UI

### Settings store fields

```ts
type ExtractionBackend = "tesseract" | "surya-remote";
type SuryaTestResult = "ok" | "unreachable" | "bad-response";

interface SettingsState {
  // ...existing fields
  extractionBackend: ExtractionBackend;     // default "tesseract"
  suryaEndpointUrl: string;                  // default "http://localhost:9991/v1"
  suryaLastTestedAt?: string;                // ISO timestamp; cleared on URL change
  suryaLastTestResult?: SuryaTestResult;     // cleared on URL change
}
```

Three actions on the store: `setExtractionBackend(id)`, `setSuryaEndpointUrl(url)` (clears `suryaLastTested*`), `recordSuryaTest(result)`.

### `ExtractionSection.tsx` — Settings UI

Mirrors `NetworkSection.tsx` (Phase 2.7c). Backend radio + URL field + Test button + status pill + Save/Cancel.

```
┌─ Document extraction ───────────────────────────────┐
│                                                     │
│  Backend                                            │
│  ( ) Built-in (Tesseract.js)  — default, offline   │
│  (•) Remote (Surya)            — better accuracy,  │
│                                  needs server      │
│                                                     │
│  Surya endpoint URL                                 │
│  ┌─────────────────────────────────────────┐ ┌────┐│
│  │ http://localhost:9991/v1                │ │Test││
│  └─────────────────────────────────────────┘ └────┘│
│                                                     │
│  ✓ Reachable · last tested 2 min ago                │
│                                                     │
│  [Save]   [Cancel]                                  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Test connection flow

`[Test]` enabled when URL passes shape validation: `^https?://[^/]+(/v\d+)?$`. On click:

1. GET `${url%/v1}/health` with `AbortSignal.timeout(5000)`.
2. 200 OK → `recordSuryaTest("ok")`, green `✓ Reachable · last tested Xs ago`.
3. Network error / timeout → `recordSuryaTest("unreachable")`, red `✗ Unreachable: <reason>`.
4. Non-200 → `recordSuryaTest("bad-response")`, red `✗ Endpoint responded but didn't look like Surya`.

### Save gating

`[Save]` is disabled when: backend is `surya-remote` AND (URL is empty OR `suryaLastTestResult !== "ok"` for the current URL). Switching back to `tesseract` is unconditional.

### What's not in the settings UI

- No DPI / image-token override.
- No per-invoice backend toggle.
- No fallback toggle (we always hard-fail per Q2).
- No model picker — the endpoint serves one model.

## Stage 1 — `surya-ocr.ts`

```ts
const PROMPT = "Convert this document page to HTML, including bounding boxes for each layout block.";
const TIMEOUT_MS = 60_000;
const MAX_TOKENS = 8192;

export function makeSuryaOcr(endpointUrl: string): OcrFn {
  return async (pages: ImageBitmap[]) => {
    const t0 = performance.now();
    const out: PageOcr[] = [];
    for (let i = 0; i < pages.length; i++) {
      const pngBlob = await imageBitmapToPngBlob(pages[i]);
      const dataUri = await blobToDataUri(pngBlob);
      const html = await callSurya(endpointUrl, dataUri, AbortSignal.timeout(TIMEOUT_MS));
      assertWellFormed(html);
      out.push({ pageIndex: i, text: html, lines: [] });
    }
    return { pages: out, elapsed_ms: Math.round(performance.now() - t0), version: "surya-2-gguf" };
  };
}
```

`PageOcr.text` carries the full HTML string. `PageOcr.lines = []` because the Surya OpenAI endpoint doesn't expose per-line bboxes — the mapper consumes the HTML directly.

### Well-formedness guard (the silent-truncation defence)

```ts
function assertWellFormed(html: string): void {
  const trimmed = html.trimEnd();
  if (!trimmed.endsWith("</div>") && !trimmed.endsWith("</p>") && !trimmed.endsWith("</table>")) {
    throw new SuryaContentError(`response appears truncated (ends with: ${trimmed.slice(-50)})`);
  }
  const open = (html.match(/<div\b/g) ?? []).length;
  const close = (html.match(/<\/div>/g) ?? []).length;
  if (open !== close) {
    throw new SuryaContentError(`unbalanced <div>: open=${open}, close=${close}`);
  }
}
```

Catches the per-slot-context-exhaustion bug observed during the 2026-05-31 spike (silent truncation when `--parallel 8 --ctx-size 18000` left only 243 output tokens per slot).

### Error classes

```ts
class SuryaInfraError extends Error {}     // network, timeout, 5xx, DNS
class SuryaContentError extends Error {}   // truncation, malformed HTML, zero blocks, etc.
```

`runPipeline` lets these bubble; the orchestrator translates to user-facing messages (see Error handling section).

## Stage 2 — `surya-mapper.ts`

Pure function. Uses the renderer's `DOMParser`. Re-uses Phase 3b regexes via `regex-shared.ts`.

```ts
export function mapSuryaPages(pages: PageOcr[]): ExtractionResult {
  const t0 = performance.now();
  const body: Partial<Invoice["invoice"]> = {};
  const field_confidences: Record<string, number> = {};
  const warnings: NonNullable<Invoice["extraction"]["warnings"]> = [];
  const blocks: Block[] = pages.flatMap((p, i) => parseBlocks(p.text, i));

  if (blocks.length === 0) {
    throw new SuryaContentError("Surya returned no blocks — page may be blank");
  }

  fillPayeeDisplayName(blocks, body, field_confidences);
  fillCurrencyAndTotal(blocks, body, field_confidences, warnings);
  fillInvoiceNumberAndDates(blocks, body, field_confidences);
  fillPaymentDetails(blocks, body, field_confidences);
  fillSubtotal(blocks, body, field_confidences);
  fillTaxTotal(blocks, body, field_confidences);
  fillLineItems(blocks, body, field_confidences, warnings);

  return {
    stages: [{ name: "schema-extraction", model: "surya-mapper-v1", version: "0.1.0",
               elapsed_ms: Math.max(0, Math.round(performance.now() - t0)) }],
    body, field_confidences, warnings,
  };
}
```

### Block parsing

```ts
interface Block {
  bbox: { x0: number; y0: number; x1: number; y1: number };
  label: string;        // "Section-Header" | "Text" | "Table" | "Page-Footer" | "Image" | "Page-Header"
  pageIndex: number;
  text: string;         // visible text content, tags stripped
  html: string;         // raw innerHTML, preserved for <table> walks
}

function parseBlocks(htmlPage: string, pageIndex: number): Block[] {
  const doc = new DOMParser().parseFromString(`<root>${htmlPage}</root>`, "text/html");
  return [...doc.querySelectorAll("[data-bbox]")].map((el) => {
    const [x0, y0, x1, y1] = (el.getAttribute("data-bbox") ?? "").split(/\s+/).map(Number);
    return {
      bbox: { x0, y0, x1, y1 },
      label: el.getAttribute("data-label") ?? "Text",
      pageIndex,
      text: el.textContent?.trim() ?? "",
      html: el.innerHTML,
    };
  });
}
```

### Field mapping

| Field | Strategy | Confidence |
|---|---|---|
| `payee.display_name` | First `Section-Header` block on page 0 with text length > 1; OR largest text block in top 25 % of page 0 (fallback) | 0.85 / 0.55 |
| `total` | Last block whose text matches `/total[^a-z].*[\$£€]?\s*[\d,]+\.\d{2}/i`; uses `parseCurrency` (EU comma-decimal guard preserved) | 0.9 / 0.7 |
| `currency` | `CURRENCY_TOKENS` over concatenated text of all blocks | 0.9 |
| `invoice_number` | `INVOICE_NUMBER_RE` over block text | 0.85 |
| `issue_date`, `due_date` | `ISSUED_RE` / `DUE_RE` + `parseDate` (dd/mm/yyyy AU convention preserved) | 0.85 |
| `payment_details.bank.bsb`, `account_number` | `BSB_RE` (confidence 0.75) / `ACCOUNT_RE` (0.9) | 0.75 / 0.9 |
| `payment_details.ckb_address`, `evm_address` | `CKB_RE` (≥ 20 chars after prefix) / `EVM_RE` (40 hex) | 0.99 |
| `subtotal` | Block matching `/subtotal\s*[:\-]?/i` + trailing amount | 0.85 |
| `tax_total` | Block matching `/^(tax\|gst\|vat)\s*[:\-]?\s*\(?[\d.%]*\)?\s*[\$£€]?\s*[\d,]+\.\d{2}/i` | 0.85 |
| `line_items` | Walk `label === "Table"` blocks. Parse `<table>` inside `html`. Map header row to `{ description, quantity, unit_price, line_total }` by header text matching (`/desc/i`, `/qty/i`, `/unit/i`, `/total\|amount/i`). Skip `<tfoot>`. | 0.85 if all 4 header positions identified; 0.6 if partial; warning emitted |

### Confidence model

`llama-server` does not surface per-block confidence in the OpenAI response. We synthesise from *signal strength*: a structural cue (matching label, regex match) → high; heuristic fallback → moderate. The `0.85` chip threshold from Phase 3b stays unchanged — low-confidence amber chips appear for fallback fields; structural-cue fields are silent. UI is unmodified.

## Error handling

Hard fail with retry (Q2 → option B). Two error classes, two user-facing message families.

### Failure taxonomy

| Failure | Surface | Status | User message |
|---|---|---|---|
| `AbortSignal.timeout(60s)` fires | `fetch` rejects | `failed` | "Surya endpoint at `<host>` timed out after 60s. Check the server." |
| Network refused / DNS / TCP reset | `fetch` rejects | `failed` | "Surya endpoint at `<host>` unreachable. Check the server or switch backend in settings." |
| HTTP 5xx | `callSurya` throws `SuryaInfraError` | `failed` | "Surya endpoint returned 5xx — server may be overloaded or restarting." |
| HTTP 401 / 403 | `callSurya` throws `SuryaInfraError` | `failed` | "Surya endpoint rejected the request (auth) — check URL." |
| HTTP 400 | `callSurya` throws `SuryaInfraError` | `failed` | "Surya endpoint rejected the request body — please file a bug." |
| Non-JSON response | `callSurya` throws `SuryaContentError` | `failed` | "Surya endpoint didn't return valid JSON. URL may not point at a Surya server." |
| Response truncated | `assertWellFormed` throws `SuryaContentError` | `failed` | "Surya returned a truncated response — server may be misconfigured (check --parallel and --ctx-size)." |
| Zero blocks parsed | mapper throws `SuryaContentError` | `failed` | "Surya returned no blocks — the page may be blank or unrecognized." |
| Stage 2 mapper throws (defensive) | bubbles through `runPipeline`, caught by `ExtractionService.pump()` | `failed` | "Couldn't parse Surya's output. Try Retry or switch backend." |

**Principle (carried from 3b):** a partial result is not a failure. If the mapper extracts `total` and nothing else, status is `extracted` with `field_confidences` recording the gaps.

### Retry semantics

- `failed` invoices keep their `raw_file.storage_uri`.
- The Phase 3b Retry button re-invokes `extractionService().enqueue` — which reads `settings.extractionBackend` again. Backend swaps between failure and retry are honoured.
- Each retry appends a new entry to `pipeline.stages`. The `applyExtraction` idempotency guard from 3b uses signature equality; a Surya retry differs from the failed Tesseract attempt and lands cleanly.

### No silent fallback

If the user chose `surya-remote`, the failure surfaces. No automatic switch to Tesseract — that masks misconfiguration and muddies field provenance (whose `total` did I get?).

### Out of scope

- No queue persistence across app restarts.
- No automatic re-tries on `failed`.
- No client-side rate limiting (concurrency=1 from 3b).
- No telemetry.

## Testing strategy

### Unit tests (vitest)

- **`surya-html.test.ts`** — pure helpers: `parseBlocks(html)`, `parseTable(html)`, bbox parsing with edge cases.
- **`surya-mapper.test.ts`** — table-driven, ~15 cases against captured real Surya output. Fixtures saved as HTML files under `apps/desktop/src/lib/invoices/extraction/__fixtures__/surya/`. Cases include: clean AUD invoice with `<table>`, Nervos sparse render with CKB address, POS screen photo, EU comma-decimal block, truncated HTML (manually mangled), zero-block response, table with missing header columns, table with `<tfoot>`, URL-tagged block.
- **`surya-ocr.test.ts`** — mocked `fetch`: happy path, network error, HTTP 502, 401/403, non-JSON body, truncated HTML body, timeout via AbortSignal. Each variant must assert the right error class.
- **`pipeline.test.ts` (modified)** — new case that the generalised orchestrator dispatches the injected `mapper`.
- **`extractionService` (modified)** — new case that the singleton reads `settings.extractionBackend` at `pump()` time and selects the correct `{ ocr, mapper }` pair.
- **`settings.test.ts`** — `setExtractionBackend`, `setSuryaEndpointUrl` (clears `suryaLastTested*`), `recordSuryaTest`, persist round-trip.

### Component tests (React Testing Library)

- **`ExtractionSection.test.tsx`** — backend radio wires to store; URL field disabled when Tesseract; `[Test]` button disabled until URL passes shape validation; `[Save]` disabled until `suryaLastTestResult === "ok"` for current URL; `[Save]` always enabled for Tesseract.
- **No new `ReviewInvoiceForm` tests.** Phase 3b's three render-state tests still cover the failure UI shape; only the `extractionError` string content changes, which isn't asserted in 3b's tests.

### Mocking

`surya-ocr.test.ts` mocks `globalThis.fetch` directly via `vi.spyOn`. No MSW; fetch is the only network call and direct mocking is the cleanest seam.

### Not tested in v3c

- Real-network calls to a live Surya endpoint in CI (external dependency).
- End-to-end OCR accuracy on photographic sources (same scope cut as 3b).
- Confidence-threshold calibration (knob in `surya-mapper.ts`; regression mode is "amber chip", not "silently wrong").

### Coverage target

80 % global. The mapper and ocr files are pure-function-shaped; should land well above.

### Manual smoke (`docs/phase-3c-smoke-playbook.md`)

1. Settings → Extraction → switch to Remote (Surya) → enter `http://localhost:9991/v1` → click Test → green pill → Save.
2. Drop a real PDF invoice → fields populate within ~5 s; `line_items` table filled; `tax_total` set if document has tax.
3. Stop the Surya server (`sudo systemctl stop surya-llama-server`) → drop another PDF → "unreachable" message → restart server → Retry → succeeds.
4. Temporarily reconfigure server with `--parallel 8` → drop a busy invoice → "truncated response" message → restore `--parallel 1`.
5. Switch back to Built-in (Tesseract) → drop a PDF → Phase 3b path runs unchanged (line_items empty, slower).
6. Mid-session backend swap: extract one invoice with Surya, change backend to Tesseract, extract a second invoice — verify the second uses Tesseract.

## Out of scope (explicit)

- Bundled local Surya server (no native sidecar — opt-in remote endpoint only).
- Per-invoice backend toggle.
- Automatic fallback chain.
- Block-mode dual-pass extraction (Surya supports it; v3c uses single-pass full-page mode, which the 2026-05-31 spike showed is sufficient when `--parallel 1`).
- Per-token log-probability confidence harvesting (would need `logprobs: true` and per-block correlation work).
- DPI override (hardcoded match for Phase 3b's existing rasterise output — 200 DPI inside `rasterise.ts`).
- Telemetry / phone-home.

## Open questions

None blocking. Tracked for later:

- **Banner copy.** Spec lists illustrative messages; implementer pins down final wording.
- **Confidence threshold tuning.** Per-field thresholds may want adjustment after running against real corpora. Hot-reloadable from constants in `surya-mapper.ts`; not a schema change.
- **Image-token cap.** Surya load warning suggests `--image-min-tokens 1024` for grounding accuracy. Not adopted in v3c because the spike showed `--parallel 1` already solves the truncation problem. Worth revisiting if line-item accuracy on busy tables comes back lower than expected.
