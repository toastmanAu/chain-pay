# Phase 4 — compliance export smoke playbook

This verifies the live ERPNext-backed CSV/PDF export, including persistence
across a desktop restart. The automated suite covers authorization, filter and
response validation, source/Journal tamper rejection, deterministic bytes,
spreadsheet formula neutralization, and CKB/Sepolia field parity.

## Prerequisites

1. Start and seed ERPNext with `./scripts/backend-up.sh`.
2. Generate the local main-process credential file with
   `bash scripts/configure-local-accounting.sh`.
3. Launch ChainPay with `npm run dev:desktop:accounting`.
4. Have at least one CKB and one Sepolia Safe payment shown as **posted**. Use
   the existing Slice C/D playbooks if records need to be created.

## Export both formats

1. Open **Reports → Compliance exports**.
2. Choose an inclusive date range containing both payments and leave Network
   at **All supported networks**.
3. Export CSV. Choose a destination in the native save dialog.
4. Confirm the success notice reports a positive payment-line count and a
   64-character SHA-256 digest.
5. Export the same filters again. Confirm the two CSV files are byte-identical
   (for example, `sha256sum file-1.csv file-2.csv`).
6. Export printable PDF twice and confirm those files are also byte-identical,
   open successfully, and print without clipped evidence lines.

## Evidence checks

Inspect the CSV and PDF and verify:

- each payment line has its ERPNext source record, external batch ID,
  payee/payslip reference, and submitted Journal Entry;
- crypto is present both as an exact smallest-unit integer and a decimal amount;
- fiat is present both as exact minor units and a decimal amount;
- transaction hash and UTC confirmation time match the submitted source;
- Sepolia includes SafeTx hash, confirmed block, and executor-paid gas in wei
  and ETH; the payer is `executor`;
- CKB block/fee evidence and legacy FX fields say `unavailable` when they were
  not persisted—there are no zeroes or invented rates;
- rows are ordered by confirmation time, batch ID, and payment-line index.

CSV retains Unicode text directly. The dependency-free PDF represents any
non-ASCII character as its explicit `\uXXXX`/`\UXXXXXXXX` code point so audit
identifiers remain lossless and printable with the embedded base font.

Repeat with each Network filter. A range with no matching records must show a
clear error and must not create a file. Canceling the save dialog must also
leave no file behind.

## Restart recovery

1. Quit ChainPay completely and relaunch with
   `npm run dev:desktop:accounting`.
2. Return to **Reports** and repeat one export without recreating or reposting
   either payment.
3. Confirm the digest matches the pre-restart export. The report is rebuilt
   from ERPNext; no report rows or Frappe credentials are persisted in renderer
   state.

## Authorization and integrity negatives

Use a Frappe API user without Accounts User/Accounts Manager and call
`crypto_payroll.api.export_compliance`; it must return a permission error.
Unknown filters, invalid dates, unsupported chains, and formats other than
`csv`/`pdf` must fail. In a disposable test site only, alter a linked Journal
Entry source hash and verify export fails with an identity-mismatch error;
restore or reset the site afterward.
