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
