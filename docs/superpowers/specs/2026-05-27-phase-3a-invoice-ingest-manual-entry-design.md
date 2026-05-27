# Phase 3a — Invoice Ingest (Manual Entry) Design

| | |
|---|---|
| **Date** | 2026-05-27 |
| **Status** | Spec — pending implementation |
| **Predecessor** | Phase 2.7c (mainnet plumbing + auto-broadcast lifecycle) shipped 2026-05-26 |
| **Successor (planned)** | Phase 3b: OCR sidecar — wires PaddleOCR-VL + NuExtract-2.0 to pre-fill the same form |
| **Slicing** | Single-PR slice; subagent-driven execution; mirrors Phase 2.7c cadence |
| **Vault source plan** | `~/Documents/loacal-vault/Projects/ChainPay/Invoice Ingest — Manual Upload Plan.md` (2026-05-22) |
| **Schema** | `~/Documents/loacal-vault/Projects/ChainPay/schemas/invoice-extraction-v0.schema.json` (`schema_version: 0.1.0`) |

## Goals

- Land the invoice-extraction schema (`v0.1.0`) as TypeScript + Zod inside chain-pay, with the schema as the durable contract for all future intake paths (manual upload now, OCR later, email/API later still).
- Deliver a working **manual entry → multisig handoff** vertical: treasurer types invoice fields into a form, attaches a PDF, and the resulting record routes into the existing 2.7c multisig pipeline.
- Cover **both** invoice flows from the schema: `employee-payment` (reimbursement) and `one-off-vendor`. Recurring vendor + email/API sources deferred.
- Introduce a new `VendorPaymentBatch` type alongside the existing `PayrollBatch`, both reusing the broadcast/retry/auto-broadcast machinery shipped in 2.7c.
- One-tx-per-invoice in this slice. Bundling N invoices into one tx is explicitly deferred — the data model already supports it.

## Non-goals

- OCR / VLM auto-extraction (deferred to Phase 3b).
- Email-forwarded intake (deferred to ChainPay's all-employee phase).
- Frappe doctype mapping / Phase 4 accounting wire-up.
- Vendor address-book dedup heuristics beyond display-name + tax-id exact match.
- Multi-tenant invoice namespacing (the `org_id` schema field is preserved but unused — single-tenant for now).
- Hardening against treasurer-supplied malicious PDFs (manual-entry phase inherits trust from the operator's own machine, per vault plan).

## Architecture

### Module layout

```
packages/shared/src/
  invoices.ts                       NEW   z.infer types from invoice-schema.ts
  vendors.ts                        NEW   VendorProfile type
  invoice-schema.ts                 NEW   Zod schema — single source of truth
  payroll.ts                        EXTEND  add VendorPaymentBatch + VendorPaymentLine types

apps/desktop/src/stores/
  invoices.ts                       NEW   zustand store w/ persist (chain-pay:invoices)
  vendors.ts                        NEW   zustand store w/ persist (chain-pay:vendors)
  invoice-drafts.ts                 NEW   zustand store w/ persist (chain-pay:invoice-drafts)
  payroll-batches.ts                EXTEND  add kind discriminator + version 1→2 migration

apps/desktop/src/lib/
  invoices/
    state-machine.ts                NEW   draft → in-review → queued-for-signing → signed | rejected
    file-storage.ts                 NEW   content-addressed PDF blob storage (IPC bridge to main)
    route-to-batch.ts               NEW   invoice → PayrollBatch | VendorPaymentBatch
    approve-and-queue.ts            NEW   safe-ordered handoff: write batch → update invoice → nav

apps/desktop/electron/main/
  invoice-files-host.ts             NEW   IPC handler: store/read/delete PDFs in userData/invoice-pdfs/

apps/desktop/src/features/invoices/
  InvoicesPage.tsx                  NEW   List screen + "New invoice" button
  InvoiceList.tsx                   NEW   Status-grouped table
  NewInvoiceForm.tsx                NEW   Stage A: flow + payee + PDF upload
  ReviewInvoiceForm.tsx             NEW   Stage B: editable fields + approve & queue
  VendorPicker.tsx                  NEW   Search-or-create vendor address-book entry
  hooks/useInvoiceDraft.ts          NEW   Debounced autosave to invoice-drafts store

apps/desktop/src/features/payroll/
  (no changes — employee-payment invoices route into existing PayrollBatch via route-to-batch.ts)
```

### Critically untouched

- `ChainAdapter` interface (`apps/desktop/src/lib/chains/types.ts`)
- Treasury layer + multisig signing
- Broadcast pipeline (2.7c auto-broadcast + lifecycle retry)
- `PayrollBatch` state machine (`apps/desktop/src/lib/payroll/state-machine.ts`)
- Existing CKB transaction construction

`VendorPaymentBatch` reuses the same `PayrollBatchState` enum, the same `state-machine.ts` transitions, the same `stateTone` exhaustive switch (just fixed in 2.7c), and the same `useCommSendRetry` hook. The two batch types differ only in payee shape (`PayeeProfile` vs `VendorProfile`), line cardinality (N lines vs 1 line), and cycle metadata (cycleStart/End vs invoiceId backlink).

### Routing seam

```typescript
// apps/desktop/src/lib/invoices/route-to-batch.ts
export function routeInvoiceToBatch(
  invoice: InvoiceRecord,
  treasury: Treasury,
): PayrollBatch | VendorPaymentBatch {
  if (invoice.invoice.flow === "employee-payment") {
    return buildPayrollBatchFromInvoice(invoice, treasury); // 1-line PayrollBatch
  }
  if (invoice.invoice.flow === "one-off-vendor") {
    return buildVendorPaymentBatch(invoice, treasury);
  }
  throw new Error(`Unsupported flow for batch handoff: ${invoice.invoice.flow}`);
}
```

`recurring-vendor` and `unknown` flows are out-of-scope for this slice — they throw at routing time and the form-level guard prevents them from being selected.

## Data model

### Invoice (`packages/shared/src/invoice-schema.ts`)

Zod schema mirroring `invoice-extraction-v0.json` (`schema_version: "0.1.0"`). Types derived via `z.infer<typeof InvoiceSchema>`.

Wrapper for chain-pay storage adds two fields not in the bare schema:

```typescript
export interface InvoiceRecord extends z.infer<typeof InvoiceSchema> {
  id: string;             // ULID, chain-pay-local
  createdAt: string;      // ISO
  updatedAt: string;      // ISO
}
```

For manual entry, `extraction.pipeline.stages: []` (no OCR ran) and `extraction.field_confidences: {}` are deliberately legal — Phase 3b populates them.

### Vendor (`packages/shared/src/vendors.ts`)

```typescript
export interface VendorProfile extends Identified, Timestamped {
  displayName: string;
  taxId?: string;
  taxIdCountry?: string;   // ISO 3166-1 alpha-2
  preferredChain: ChainId;
  walletAddress?: PayeeAddress;
  bankDetails?: {
    bsb?: string;
    accountNumber?: string;
    iban?: string;
    swift?: string;
    accountName?: string;
  };
  notes?: string;
  active: boolean;
}
```

Dedup: search-or-create flow keys off `(displayName, taxId)` exact match. Fuzzy heuristics deferred.

### VendorPaymentBatch (`packages/shared/src/payroll.ts` — extended)

```typescript
export interface VendorPaymentBatch extends Identified, Timestamped {
  kind: "vendor";                          // discriminator (see Storage §)
  label: string;
  treasuryId: string;
  invoiceId: string;
  vendorId: string;
  fxSnapshot: FxQuote[];
  line: VendorPaymentLine;                 // exactly one line
  state: PayrollBatchState;                // identical enum reused
  pendingTxId?: string;
  txBytes?: string;
  sighashDigest?: string;
  commPacket?: string;
  partialSigs?: PartialSigEntry[];
  commSendStatus?: Record<number, CommSendSlotStatus>;
  autoBroadcast?: boolean;
  broadcastError?: string;
  broadcastInFlight?: boolean;
  expiresAt?: number;
}

export interface VendorPaymentLine {
  vendorId: string;
  fiat: FiatAmount;
  crypto: Money;
  fxRate: string;
  feeAllocated: Money;
}
```

`PayrollBatch` gains a `kind: "payroll"` discriminator field (added to the existing interface in `packages/shared/src/payroll.ts`). Existing persisted batches without `kind` are backfilled by a one-shot migration on first launch — see Storage §.

### Invoice state machine

```
draft  ──treasurer clicks "Review"──▶  in-review
       │                                    │
       │                                    ├──approve & queue──▶  queued-for-signing
       │                                    │                              │
       └──save as draft──────────────────────                              │
                                            └──reject──▶  rejected         │
                                                                           │
                                       linked batch state===confirmed ─────▶  signed
```

Transitions enforced in `apps/desktop/src/lib/invoices/state-machine.ts`. Illegal transitions throw `IllegalInvoiceTransition`.

## User flow

### Screen 1: `InvoicesPage`

Sibling of `payments`, `payroll`, `treasury` in main nav.

```
┌────────────────────────────────────────────────────────────────┐
│  Invoices                                  [+ New invoice]     │
├────────────────────────────────────────────────────────────────┤
│  In review (2)                                                 │
│    INV-2025-001  Acme Pty       $1,247.50 AUD   [Review →]    │
│    —             Sarah Chen     $312.00 AUD     [Review →]    │
│                                                                │
│  Queued for signing (1)                                        │
│    INV-2025-003  GitHub Inc     $50.00 USD      [Open batch →]│
│                                                                │
│  Signed this month (4)        [↓ expand]                       │
│  Rejected (1)                 [↓ expand]                       │
└────────────────────────────────────────────────────────────────┘
```

### Screen 2: `NewInvoiceForm` — Stage A

Flow + payee + file upload. Modal or full page. PDF MIME-sniffed + size-checked client-side, then hashed (Web Crypto sha256), then handed to main via IPC for content-addressed storage.

### Screen 3: `ReviewInvoiceForm` — Stage B

Side-by-side PDF preview (pdf.js) + editable fields. All invoice fields editable inline. Three terminal actions:

- **Save as draft** — writes to `invoiceDrafts` store; invoice stays in `draft`.
- **Reject** — captures `rejection_reason`, invoice moves to `rejected`. No batch created.
- **Approve & queue** — validates via Zod, captures edit audit trail, transitions to `queued-for-signing`, creates `PayrollBatch` or `VendorPaymentBatch`, navigates to existing `PayPanel`.

Form-state autosave on every change (debounced 500ms) so closing the window mid-review and reopening lands back on the same Stage B with all fields populated.

## Data flow — happy path

```
1. Treasurer drops PDF in NewInvoiceForm Stage A
   ├─ Renderer hashes blob (Web Crypto sha256)
   ├─ IPC: invoice-files:store(blob, sha256) → file:// URI
   └─ In-memory only; not persisted

2. Click Continue → InvoiceRecord built with intake.raw_file populated
   ├─ status: "draft"
   ├─ extraction.pipeline.stages: []
   └─ useInvoicesStore.addInvoice()

3. Stage B field edits
   └─ debounced 500ms → useInvoiceDraftsStore.upsertDraft()

4. Click "Approve & queue"
   ├─ InvoiceSchema.safeParse() — block on failure
   ├─ Diff against draft baseline → append approval.edits_made[]
   ├─ approveAndQueue() — safe-ordered handoff:
   │    ├─ usePayrollBatchesStore.addBatch(batch)   ← write batch FIRST
   │    └─ useInvoicesStore.markQueuedForSigning(invoiceId, batchId)
   └─ Navigate to /payments/{batchId}

5. Existing 2.7c pipeline takes over
   └─ on batch.state === "confirmed":
      ├─ useInvoicesStore.markSigned(invoiceId, { txHash, chain })
      └─ writes chainpay_link + approval.status = "signed"
```

## Storage

### Storage layer (zustand + localStorage)

Chain-pay's existing storage stack is **zustand stores with `persist` middleware backed by localStorage**, using a `"123n"`-suffix replacer/reviver to round-trip bigints (see `apps/desktop/src/stores/payroll-batches.ts` for the canonical pattern).

Three new zustand stores under `apps/desktop/src/stores/`:

| Store | localStorage key | Shape | Notes |
|---|---|---|---|
| `useInvoicesStore` | `chain-pay:invoices` | `{ invoices: InvoiceRecord[] }` | Schema-validated on write |
| `useVendorsStore` | `chain-pay:vendors` | `{ vendors: VendorProfile[] }` | Search-or-create flow |
| `useInvoiceDraftsStore` | `chain-pay:invoice-drafts` | `{ drafts: Record<invoiceId, Partial<InvoiceRecord>> }` | Free-form, no schema validation |

Each uses the same bigint-suffix replacer/reviver as `payroll-batches.ts` for consistency.

### PDF storage

Content-addressed under Electron `userData`, two-level sharded by first 2 chars of sha256:

```
{userData}/invoice-pdfs/
  ab/cdef0123…sha256.pdf       ← raw_file.storage_uri = "file://…/ab/cdef…sha256.pdf"
```

Same blob uploaded twice resolves to same file — automatic dedup.

IPC bridge (matches existing pattern in `light-client-host.ts`):
- `invoice-files:store(blob, sha256) → storageUri`
- `invoice-files:read(storageUri) → blob`
- `invoice-files:delete(storageUri)` (on invoice delete only)

### Batch discriminator + migration

`usePayrollBatchesStore` is extended to hold both `PayrollBatch` and `VendorPaymentBatch` records, discriminated by the `kind: "payroll" | "vendor"` field. A zustand `persist` migration bumps the store's `version: 1 → 2` and backfills `kind: "payroll"` on existing persisted records (idempotent — checks before writing). The migration runs once per browser-profile on first launch after this slice.

## Error handling

### File ingestion (Stage A)

| Failure | Detection | Behavior |
|---|---|---|
| File > 50 MB | Pre-hash size check | Inline error; don't hash |
| Non-PDF/PNG/JPG | MIME sniff + extension | Inline error |
| Hash compute fails | Web Crypto throws | Inline error + retry button |
| IPC store rejects | Main returns `{ok:false, error}` | Inline error; blob stays in memory |
| Duplicate sha256 | Main pre-write check | Not an error — reuse existing path |

### Schema validation (Stage B → Approve)

- `InvoiceSchema.safeParse()` is the only gate.
- On failure: map `ZodIssue[]` to per-field inline errors; block submission; don't write `invoices` store.
- "Save as draft" stays enabled (writes to `invoiceDrafts` which has no schema).

### Batch handoff (Approve & queue → routing)

| Failure | Detection | Behavior |
|---|---|---|
| No active treasury | Pre-check | Block; deep-link to Treasury Settings |
| Treasury has no signers | Pre-check | Block; deep-link |
| `addBatch` throws | zustand set throws (rare: localStorage quota) | Surface error; abort handoff; invoice stays in `in-review` |
| `routeInvoiceToBatch` throws | try/catch | Block; invoice stays in `in-review` |

Handoff ordering (no true multi-store transactions in zustand — synchronous sequential writes with safe ordering):

```typescript
function approveAndQueue(invoice: InvoiceRecord, treasury: Treasury): { batchId: string } {
  const batch = routeInvoiceToBatch(invoice, treasury);   // pure; throws on missing payee/treasury
  // Write batch FIRST: if the second call fails, the batch is an orphan
  // visible in the payroll list — recoverable. If we wrote invoice first
  // and addBatch failed, the invoice would point at a non-existent batch — worse.
  usePayrollBatchesStore.getState().addBatch(batch);
  useInvoicesStore.getState().markQueuedForSigning(invoice.id, batch.id, currentUserId);
  return { batchId: batch.id };
}
```

Failure recovery: if `addBatch` succeeds but `markQueuedForSigning` throws (rare — localStorage quota hit on the invoices key only), the user sees an orphan batch in PayPanel. The invoice remains in `in-review`. Operator can either cancel the orphan batch (existing PayPanel "Cancel" path) or re-approve the invoice (idempotent — `addBatch` no-ops on duplicate id).

### Out of scope

- OCR/extraction failures (no OCR in this slice).
- Network errors (no network calls — Phase 4 Frappe sync is later).
- Tx-broadcast failures (handled by existing 2.7c retry — invoice sits in `queued-for-signing` until batch resolves).

## Testing strategy

Mirrors Phase 2.7 conventions: vitest unit + integration; RTL component tests; coverage ≥ 80% on new code per `~/.claude/rules/testing.md`.

### Test file layout

```
packages/shared/src/
  invoice-schema.test.ts                       schema happy paths + boundaries + round-trip against vault JSON schema
  invoices.test.ts                             type derivation sanity

apps/desktop/src/stores/
  invoices.test.ts                             store CRUD + status filters + markQueuedForSigning + markSigned
  vendors.test.ts                              vendor CRUD + dedup on (displayName, taxId)
  invoice-drafts.test.ts                       upsert + read + clear
  payroll-batches.test.ts                      EXTEND  add cases for kind discriminator + v1→v2 migration

apps/desktop/src/lib/invoices/
  state-machine.test.ts                        legal / illegal transition matrix
  file-storage.test.ts                         content-addressed write + dedup + delete
  route-to-batch.test.ts                       both flows → correct batch types
  approve-and-queue.test.ts                    safe-ordered write; orphan-batch outcome on second-write failure

apps/desktop/src/features/invoices/
  NewInvoiceForm.test.tsx                      RTL: stage transitions, validation, draft autosave
  ReviewInvoiceForm.test.tsx                   RTL: edit tracking → edits_made[], approve & queue
  VendorPicker.test.tsx                        RTL: search-or-create

```

### Highest-priority tests (write first per TDD)

1. **`approve-and-queue.test.ts`** — safe-ordered write under injected `markQueuedForSigning` failure: assert the batch is persisted AND the invoice remains in `in-review` (the orphan-batch outcome is recoverable).
2. **Schema completeness round-trip** — every field from vault `invoice-extraction-v0.schema.json` survives Zod parse without silent drop.
3. **Edits audit trail** — N field edits + approve ⇒ `approval.edits_made.length === N` with matching `before`/`after`.
4. **Migration idempotency** — v1→v2 `kind` backfill twice ⇒ no duplicate writes; existing-records-with-kind unchanged.
5. **Batch confirmation hook** — simulated `state === "confirmed"` ⇒ invoice transitions to `signed` with `chainpay_link.tx_hash` populated.

### Test count estimate

~50–70 new tests. Smaller than 2.7c (+109) because no chain code is touched.

### Operator-driven smoke checklist (lands in PR body)

1. Add a one-off vendor invoice (PDF + fields) → confirm record in `Invoices`.
2. Edit a field on Stage B → close window → reopen → confirm draft persists.
3. Approve & queue an employee-payment invoice → confirm it lands in PayPanel as a `PayrollBatch` with 1 line.
4. Approve & queue a vendor invoice → confirm `VendorPaymentBatch` created, PayPanel handles it identically.
5. Walk an approved invoice all the way through to `confirmed` on testnet → confirm `invoice.approval.status === "signed"` and `chainpay_link.tx_hash` populated.
6. Reject an in-review invoice → confirm rejection reason captured, no batch created.
7. Reload mid-Stage-B → confirm form state recovers.

## Open questions deferred to Phase 3b or later

- OCR pipeline picks: PaddleOCR-VL + NuExtract-2.0 (two-stage) vs olmOCR-2-7B-1025 (single-shot) — bench in vault before 3b starts.
- Sidecar service host: localhost on the operator's machine vs separate driveThree-style box. Vault recommendation: sidecar (option 2 in the plan).
- Per-field confidence calibration: irrelevant for manual entry; matters when an OCR pipeline can auto-approve.
- Frappe doctype mapping for `chainpay_link.frappe_doctype` — Phase 4.
- Vendor address-book fuzzy-match-suggest-existing flow — current slice does exact match only on (displayName, taxId).
- PDF sanitisation hardening (ClamAV, password-protected PDFs) — Phase 2+ per vault plan.
- Bundling N invoices into one tx — data model supports it; UX deferred.

## Risk register

| Risk | Mitigation |
|---|---|
| Schema drift between vault JSON schema and Zod port | Round-trip test against vault file in CI |
| Semantic conflation of `cancelled` state across batch types | Documented; UI shows context-appropriate label |
| Treasurer over-trusts pre-filled fields when OCR ships | Out of 3a scope; Phase 3b adds "I verified totals" affordance |
| Vendor address-book pollution from new-vendor inline creation | Exact-match dedup in this slice; fuzzy-match deferred |
| Non-atomic two-store handoff leaves orphan batch on second-write failure | Safe ordering (batch first, then invoice) makes the failure mode recoverable; tested in `approve-and-queue.test.ts` |
| `kind` discriminator migration races UI reads | Zustand `persist` migration runs synchronously during `hydrate` before any consumer reads from the store |

## References

- Vault plan: `~/Documents/loacal-vault/Projects/ChainPay/Invoice Ingest — Manual Upload Plan.md`
- Vault schema: `~/Documents/loacal-vault/Projects/ChainPay/schemas/invoice-extraction-v0.schema.json`
- Phase 2.7c predecessor: `docs/superpowers/specs/2026-05-25-phase-2-7c-mainnet-plumbing-design.md`
- Existing PayrollBatch types: `packages/shared/src/payroll.ts`
- Existing state machine: `apps/desktop/src/lib/payroll/state-machine.ts`
- Chain rules: `~/.claude/rules/ckb-transactions.md` (no direct relevance — this slice touches no tx-construction code)
