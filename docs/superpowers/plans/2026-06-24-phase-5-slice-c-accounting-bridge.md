# Phase 5 / Slice C — Accounting Bridge + Accounting REST — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a payroll batch reaches `confirmed`, automatically build its balanced journal, POST it to a new whitelisted Frappe endpoint that creates+submits a real ERPNext Journal Entry, and record the returned JE name back on the batch.

**Architecture:** Renderer reactor fires on `confirmed` → calls a shared `postBatchJournal(batchId)` that transitions the batch to `posting` (re-entry guard), builds an `AccountingJournalPreview` via the merged `buildBatchJournal`, and calls `ipc.postJournal`. Electron **main** holds Frappe credentials and does the HTTP POST. The Frappe endpoint is idempotent on a unique `crypto_batch_id` custom field. Success → `posted {jeName}`; failure → `post_failed {error}` with a Retry that re-runs the same `postBatchJournal`.

**Tech Stack:** TypeScript, React 19, Zustand (persist), Electron (contextBridge IPC), vitest (desktop), Python/Frappe v15 + ERPNext (backend), `bench run-tests`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-24-phase-5-slice-c-accounting-bridge-design.md`.
- Frappe credentials live ONLY in the Electron main process (`process.env`). The renderer never receives them.
- Frappe `bench serve` routes by HTTP `Host` header — requests must target `chainpay.localhost:PORT` or carry `Host: chainpay.localhost`, else 404 (Slice B gotcha #1).
- Backend editable installs / custom fields are re-registered every boot via `scripts/backend-up.sh` (container `env/` is not volume-persisted — Slice B gotcha #4).
- Single company `ChainPay Test` (abbr `CPT`), single fiat currency, CKB-only this slice.
- Idempotency anchor: unique `crypto_batch_id` Data field on Journal Entry.
- Carrying-cost / FX policy: `carryingCost = obligation + feeFiat` ⇒ zero FX line (placeholder until lot tracking). `feeAllocated` is currently always `0n`, so `feeFiat = 0` today.
- Immutability everywhere (spread copies); files <800 lines, functions <50 lines; no `console.log`; no hardcoded secrets.
- Avoid shell commands containing the literal `.env` token (PreToolUse hook blocks them) — write env docs via file tools.

## Cross-task interfaces (defined once, referenced throughout)

```ts
// packages/shared/src/payroll.ts — additions to existing PayrollBatchState union:
//   | "posting" | "posted" | "post_failed"
// PayrollBatch additions:
//   jeName?: string;     // ERPNext Journal Entry name once posted
//   postError?: string;  // failure message when state === "post_failed"

// packages/shared/src/accounting.ts (already merged) — reused:
export interface PaymentJournalInput { /* payeeId, obligation, feeFiat, carryingCost, crypto, chain, txHash, salaryAccount, treasuryAccount */ }
export interface JournalAccounts { networkFeeExpense: string; fxGainLoss: string }
export function buildBatchJournal(batchId: string, payments: PaymentJournalInput[], accounts: JournalAccounts): AccountingJournalPreview;

// src/lib/accounting/account-map.ts
export interface AccountMap { salary: string; treasury: string; networkFeeExpense: string; fxGainLoss: string }
export const DEFAULT_ACCOUNT_MAP: AccountMap;

// src/lib/accounting/batch-to-journal-inputs.ts
export function buildBatchJournalForBatch(batch: PayrollBatch, map: AccountMap): AccountingJournalPreview;

// src/lib/accounting/ipc.ts (renderer) + electron/main/accounting-host.ts (main)
export interface PostJournalResult { jeName: string; idempotent: boolean }
// main postJournal(batchId, preview) resolves PostJournalResult or REJECTS (throws) on any failure.

// src/lib/accounting/post-batch-journal.ts
export async function postBatchJournal(batchId: string): Promise<void>;

// Frappe: crypto_payroll.api.post_journal(batch_id: str, preview: dict) -> {"je_name": str, "idempotent": bool}
```

---

### Task 1: Backend — `crypto_batch_id` custom field on Journal Entry

**Files:**
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/setup/custom_fields.py`
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/setup/test_custom_fields.py`
- Modify: `scripts/backend-up.sh` (invoke the ensure step before smoke)

**Interfaces:**
- Produces: `crypto_payroll.setup.custom_fields.ensure_custom_fields() -> None` (idempotent).

- [ ] **Step 1: Write the failing test**

```python
# apps/backend/apps/crypto_payroll/crypto_payroll/setup/test_custom_fields.py
import frappe
from frappe.tests.utils import FrappeTestCase
from crypto_payroll.setup.custom_fields import ensure_custom_fields


class TestCustomFields(FrappeTestCase):
    def test_crypto_batch_id_field_exists_and_is_unique(self):
        ensure_custom_fields()
        ensure_custom_fields()  # idempotent: second call must not raise
        cf = frappe.db.get_value(
            "Custom Field",
            {"dt": "Journal Entry", "fieldname": "crypto_batch_id"},
            ["fieldtype", "unique", "read_only"],
            as_dict=True,
        )
        self.assertIsNotNone(cf)
        self.assertEqual(cf.fieldtype, "Data")
        self.assertEqual(cf.unique, 1)
        self.assertEqual(cf.read_only, 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker/scripts wrapper` — in repo: `bash scripts/backend-up.sh` (env up), then
`docker compose -p chainpay-backend exec backend bench --site chainpay.localhost run-tests --module crypto_payroll.setup.test_custom_fields`
Expected: FAIL — `ModuleNotFoundError: crypto_payroll.setup.custom_fields`.

- [ ] **Step 3: Write minimal implementation**

```python
# apps/backend/apps/crypto_payroll/crypto_payroll/setup/custom_fields.py
"""Idempotently ensure ChainPay custom fields exist on stock DocTypes."""
import frappe


def ensure_custom_fields() -> None:
    """Add the unique crypto_batch_id Data field to Journal Entry if absent.

    Idempotent: safe to call on every backend boot. The unique index is the
    backend's at-most-one-JE-per-batch guarantee.
    """
    if frappe.db.exists(
        "Custom Field", {"dt": "Journal Entry", "fieldname": "crypto_batch_id"}
    ):
        return
    frappe.get_doc(
        {
            "doctype": "Custom Field",
            "dt": "Journal Entry",
            "fieldname": "crypto_batch_id",
            "label": "Crypto Batch ID",
            "fieldtype": "Data",
            "unique": 1,
            "read_only": 1,
            "no_copy": 1,
            "insert_after": "user_remark",
        }
    ).insert(ignore_permissions=True)
    frappe.db.commit()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose -p chainpay-backend exec backend bench --site chainpay.localhost run-tests --module crypto_payroll.setup.test_custom_fields`
Expected: PASS (1 test).

- [ ] **Step 5: Wire into backend-up.sh**

In `scripts/backend-up.sh`, after the seed step and before the smoke step, add a line that runs the ensure step (mirror the existing `bench_exec`/`bench --site ... execute` pattern already used for seed). Example (match the file's existing helper style):

```bash
log "Ensuring custom fields (crypto_batch_id on Journal Entry)…"
bench_site execute crypto_payroll.setup.custom_fields.ensure_custom_fields
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/apps/crypto_payroll/crypto_payroll/setup/custom_fields.py \
        apps/backend/apps/crypto_payroll/crypto_payroll/setup/test_custom_fields.py \
        scripts/backend-up.sh
git commit -m "feat(phase5): crypto_batch_id unique custom field on Journal Entry (Slice C)"
```

---

### Task 2: Backend — move Fiscal Year + Cost Center into seed

**Files:**
- Modify: `apps/backend/apps/crypto_payroll/crypto_payroll/setup/seed.py` (add `_ensure_fiscal_year`, `_ensure_cost_center`, call from `run()`)
- Modify: `apps/backend/apps/crypto_payroll/crypto_payroll/setup/smoke_je.py` (import from seed, drop local copies)
- Modify: `apps/backend/apps/crypto_payroll/crypto_payroll/setup/test_seed.py` (assert FY + cost center exist)

**Interfaces:**
- Produces: `crypto_payroll.setup.seed.ensure_fiscal_year() -> None`, `crypto_payroll.setup.seed.ensure_cost_center() -> str` (returns leaf cost center name).
- `run()` now also ensures FY + cost center so the seed delivers a postable GL.

- [ ] **Step 1: Write the failing test**

Add to `test_seed.py`:

```python
def test_seed_delivers_postable_gl(self):
    from crypto_payroll.setup import seed
    seed.run()
    year = str(frappe.utils.getdate(frappe.utils.today()).year)
    self.assertTrue(frappe.db.exists("Fiscal Year", year))
    self.assertTrue(frappe.db.exists("Cost Center", "Main - CPT"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -p chainpay-backend exec backend bench --site chainpay.localhost run-tests --module crypto_payroll.setup.test_seed`
Expected: FAIL — `Cost Center "Main - CPT"` does not exist (seed doesn't create it yet).

- [ ] **Step 3: Move the helpers into seed.py**

Copy `_ensure_fiscal_year` and `_ensure_cost_center` verbatim from `smoke_je.py` into `seed.py`, rename to public `ensure_fiscal_year` / `ensure_cost_center` (keep identical bodies — they already work, see Slice B). In `seed.run()`, call them after `_ensure_company()`:

```python
def run() -> dict:
    _ensure_company()
    ensure_fiscal_year()
    cost_center = ensure_cost_center()
    names = [_ensure_account(a, rt, pg) for a, rt, pg in ACCOUNTS]
    return {"company": COMPANY, "accounts": names, "cost_center": cost_center}
```

In `smoke_je.py`, replace the local `_ensure_fiscal_year`/`_ensure_cost_center` with:

```python
from crypto_payroll.setup.seed import ensure_fiscal_year, ensure_cost_center
```

and update `post_and_cancel()` to call the imported names.

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker compose -p chainpay-backend exec backend bench --site chainpay.localhost run-tests --module crypto_payroll.setup.test_seed`
Then re-run smoke: `bash scripts/backend-smoke.sh`
Expected: seed tests PASS (3); smoke still 5/5.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/apps/crypto_payroll/crypto_payroll/setup/seed.py \
        apps/backend/apps/crypto_payroll/crypto_payroll/setup/smoke_je.py \
        apps/backend/apps/crypto_payroll/crypto_payroll/setup/test_seed.py
git commit -m "refactor(phase5): seed delivers postable GL (move FY + cost center from smoke_je)"
```

---

### Task 3: Backend — `post_journal` REST endpoint

**Files:**
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/api.py`
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/test_api.py`

**Interfaces:**
- Consumes: `crypto_batch_id` field (Task 1); `ensure_fiscal_year`/`ensure_cost_center` (Task 2); seeded accounts.
- Produces: `crypto_payroll.api.post_journal(batch_id, preview) -> {"je_name": str, "idempotent": bool}`.
- `preview` shape (from renderer `AccountingJournalPreview`): `{"batchId": str, "entries": [{"account": str, "debit"?: {"currency": str, "minor": str}, "credit"?: {...}, "memo"?: str, "crypto"?: {...}}]}`. NOTE: `minor` arrives as a string (bigint serialized).

- [ ] **Step 1: Write the failing tests**

```python
# apps/backend/apps/crypto_payroll/crypto_payroll/test_api.py
import frappe
from frappe.tests.utils import FrappeTestCase
from crypto_payroll.setup import seed
from crypto_payroll.setup.custom_fields import ensure_custom_fields
from crypto_payroll.api import post_journal

COMPANY = "ChainPay Test"


def _acct(name):
    return frappe.db.get_value("Account", {"account_name": name, "company": COMPANY}, "name")


def _preview(batch_id, salary_minor="10000", treasury_minor="10000"):
    return {
        "batchId": batch_id,
        "entries": [
            {"account": _acct("Salary or Wage Expense"),
             "debit": {"currency": "USD", "minor": salary_minor}, "memo": "t"},
            {"account": _acct("Crypto Treasury Asset"),
             "credit": {"currency": "USD", "minor": treasury_minor}, "memo": "t"},
        ],
    }


class TestPostJournal(FrappeTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        seed.run()
        ensure_custom_fields()

    def test_posts_balanced_submitted_je_with_batch_id(self):
        res = post_journal("batch-A", _preview("batch-A"))
        self.assertFalse(res["idempotent"])
        je = frappe.get_doc("Journal Entry", res["je_name"])
        self.assertEqual(je.docstatus, 1)               # submitted
        self.assertEqual(je.crypto_batch_id, "batch-A")
        self.assertEqual(je.total_debit, je.total_credit)

    def test_idempotent_repost_returns_same_je(self):
        first = post_journal("batch-B", _preview("batch-B"))
        second = post_journal("batch-B", _preview("batch-B"))
        self.assertEqual(first["je_name"], second["je_name"])
        self.assertTrue(second["idempotent"])
        count = frappe.db.count("Journal Entry", {"crypto_batch_id": "batch-B"})
        self.assertEqual(count, 1)

    def test_unbalanced_rejected(self):
        with self.assertRaises(frappe.ValidationError):
            post_journal("batch-C", _preview("batch-C", salary_minor="10000", treasury_minor="9000"))

    def test_missing_account_rejected(self):
        bad = _preview("batch-D")
        bad["entries"][0]["account"] = "No Such Account - CPT"
        with self.assertRaises(frappe.ValidationError):
            post_journal("batch-D", bad)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose -p chainpay-backend exec backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`
Expected: FAIL — `ModuleNotFoundError: crypto_payroll.api`.

- [ ] **Step 3: Implement the endpoint**

```python
# apps/backend/apps/crypto_payroll/crypto_payroll/api.py
"""Whitelisted REST: post a balanced journal from a confirmed payment batch."""
import frappe
from frappe.utils import today
from crypto_payroll.setup.seed import ensure_fiscal_year, ensure_cost_center

COMPANY = "ChainPay Test"


def _minor_to_major(currency: str, minor_str: str) -> float:
    """Convert integer minor units (cents) to major units using currency precision."""
    precision = frappe.db.get_value("Currency", currency, "smallest_currency_fraction_value")
    # Default to 2-decimal currencies (cents) when precision is unset.
    divisor = 100
    return int(minor_str) / divisor


@frappe.whitelist()
def post_journal(batch_id: str, preview: dict) -> dict:
    """Create+submit a Journal Entry for a confirmed batch. Idempotent on batch_id.

    Returns {"je_name": str, "idempotent": bool}. Raises frappe.ValidationError on
    a malformed, unbalanced, or unknown-account payload.
    """
    preview = frappe.parse_json(preview) if isinstance(preview, str) else preview
    if not batch_id:
        frappe.throw("batch_id is required")
    entries = (preview or {}).get("entries") or []
    if not entries:
        frappe.throw(f"preview for batch {batch_id} has no entries")

    existing = frappe.db.get_value("Journal Entry", {"crypto_batch_id": batch_id}, "name")
    if existing:
        return {"je_name": existing, "idempotent": True}

    ensure_fiscal_year()
    cost_center = ensure_cost_center()

    accounts = []
    total_debit = 0.0
    total_credit = 0.0
    for e in entries:
        account = e.get("account")
        if not account or not frappe.db.exists("Account", account):
            frappe.throw(f"unknown account: {account!r}")
        row = {"account": account}
        if e.get("debit"):
            amt = _minor_to_major(e["debit"]["currency"], e["debit"]["minor"])
            row["debit_in_account_currency"] = amt
            row["cost_center"] = cost_center
            total_debit += amt
        elif e.get("credit"):
            amt = _minor_to_major(e["credit"]["currency"], e["credit"]["minor"])
            row["credit_in_account_currency"] = amt
            total_credit += amt
        else:
            frappe.throw(f"entry for {account} has neither debit nor credit")
        accounts.append(row)

    if round(total_debit, 2) != round(total_credit, 2):
        frappe.throw(f"unbalanced journal for batch {batch_id}: {total_debit} != {total_credit}")

    je = frappe.get_doc(
        {
            "doctype": "Journal Entry",
            "voucher_type": "Journal Entry",
            "company": COMPANY,
            "posting_date": today(),
            "crypto_batch_id": batch_id,
            "user_remark": f"ChainPay batch {batch_id}",
            "accounts": accounts,
        }
    )
    je.insert(ignore_permissions=True)
    je.submit()
    frappe.db.commit()
    return {"je_name": je.name, "idempotent": False}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker compose -p chainpay-backend exec backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/apps/crypto_payroll/crypto_payroll/api.py \
        apps/backend/apps/crypto_payroll/crypto_payroll/test_api.py
git commit -m "feat(phase5): post_journal whitelisted REST endpoint, idempotent on batch_id (Slice C)"
```

---

### Task 4: Shared — new batch states + state machine transitions

**Files:**
- Modify: `packages/shared/src/payroll.ts` (`PayrollBatchState` union, `PayrollBatch` fields)
- Modify: `apps/desktop/src/lib/payroll/state-machine.ts` (`TRANSITIONS`)
- Modify: `apps/desktop/src/lib/payroll/state-machine.test.ts`

**Interfaces:**
- Produces: states `"posting" | "posted" | "post_failed"`; `PayrollBatch.jeName?`, `PayrollBatch.postError?`.
- Transitions: `confirmed → posting`; `posting → posted | post_failed`; `post_failed → posting`. `posted` terminal.

- [ ] **Step 1: Write the failing test**

Add to `state-machine.test.ts`:

```ts
it("allows the accounting-post lifecycle", () => {
  expect(canTransition("confirmed", "posting")).toBe(true);
  expect(canTransition("posting", "posted")).toBe(true);
  expect(canTransition("posting", "post_failed")).toBe(true);
  expect(canTransition("post_failed", "posting")).toBe(true);
});

it("treats posted as terminal and blocks illegal post transitions", () => {
  expect(isTerminal("posted")).toBe(true);
  expect(canTransition("posted", "posting")).toBe(false);
  expect(canTransition("confirmed", "posted")).toBe(false); // must go via posting
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/payroll/state-machine.test.ts`
Expected: FAIL — type error / `confirmed` has no `posting` transition.

- [ ] **Step 3: Implement**

In `packages/shared/src/payroll.ts`, extend the union:

```ts
export type PayrollBatchState =
  | "draft"
  | "calculated"
  | "approved"
  | "broadcast_countdown"
  | "broadcast_initiating"
  | "broadcast_failed"
  | "broadcasted"
  | "confirmed"
  | "posting"
  | "posted"
  | "post_failed"
  | "failed"
  | "cancelled";
```

Add to the `PayrollBatch` interface (near `broadcastError`):

```ts
  /** ERPNext Journal Entry name once the batch's journal is posted. */
  jeName?: string;
  /** Failure message when state === "post_failed". */
  postError?: string;
```

In `state-machine.ts`, update `TRANSITIONS` (`confirmed` is no longer terminal):

```ts
  broadcasted: ["confirmed", "failed"],
  confirmed: ["posting"],
  posting: ["posted", "post_failed"],
  post_failed: ["posting"],
  posted: [],
  failed: [],
  cancelled: [],
```

And update `terminalStates`:

```ts
export const terminalStates: readonly PayrollBatchState[] = ["posted", "failed", "cancelled"];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/lib/payroll/state-machine.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (a `confirmed`-is-terminal assumption elsewhere will surface here if any — fix by allowing the new states).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/payroll.ts apps/desktop/src/lib/payroll/state-machine.ts apps/desktop/src/lib/payroll/state-machine.test.ts
git commit -m "feat(phase5): posting/posted/post_failed batch states + transitions (Slice C)"
```

---

### Task 5: Desktop main — `accounting-host.ts` (HTTP POST to Frappe)

**Files:**
- Create: `apps/desktop/electron/main/accounting-host.ts`
- Create: `apps/desktop/electron/main/accounting-host.test.ts`
- Modify: `apps/desktop/electron/main/index.ts` (call `registerAccountingIpc()`)

**Interfaces:**
- Consumes: env `FRAPPE_URL`, `FRAPPE_API_KEY`, `FRAPPE_API_SECRET`.
- Produces: `postJournalToFrappe(batchId, preview) -> Promise<PostJournalResult>` (throws on failure); `registerAccountingIpc()` registering `accounting:postJournal`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/electron/main/accounting-host.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postJournalToFrappe } from "./accounting-host";

const preview = { batchId: "b1", entries: [] };

describe("postJournalToFrappe", () => {
  beforeEach(() => {
    process.env.FRAPPE_URL = "http://chainpay.localhost:8001";
    process.env.FRAPPE_API_KEY = "key";
    process.env.FRAPPE_API_SECRET = "secret";
  });
  afterEach(() => vi.restoreAllMocks());

  it("POSTs to the whitelisted method and returns the parsed message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { je_name: "ACC-JV-0001", idempotent: false } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await postJournalToFrappe("b1", preview);
    expect(res).toEqual({ jeName: "ACC-JV-0001", idempotent: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://chainpay.localhost:8001/api/method/crypto_payroll.api.post_journal");
    expect(init.headers.Authorization).toBe("token key:secret");
    // Host is NOT set manually (forbidden header); fetch derives it from the URL.
    expect(init.headers.Host).toBeUndefined();
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 417, text: async () => "ValidationError: unbalanced",
    }));
    await expect(postJournalToFrappe("b1", preview)).rejects.toThrow(/417|unbalanced/);
  });

  it("throws fast when credentials are missing", async () => {
    delete process.env.FRAPPE_API_KEY;
    await expect(postJournalToFrappe("b1", preview)).rejects.toThrow(/FRAPPE_API_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run electron/main/accounting-host.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/electron/main/accounting-host.ts
import { ipcMain } from "electron";

export interface PostJournalResult {
  jeName: string;
  idempotent: boolean;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured (Frappe accounting bridge)`);
  return v;
}

/**
 * POST an AccountingJournalPreview to the whitelisted Frappe endpoint.
 * Credentials live only here in the main process. Throws on any failure so the
 * renderer's postBatchJournal can transition the batch to post_failed.
 */
export async function postJournalToFrappe(
  batchId: string,
  preview: unknown,
): Promise<PostJournalResult> {
  const base = requireEnv("FRAPPE_URL").replace(/\/$/, "");
  const key = requireEnv("FRAPPE_API_KEY");
  const secret = requireEnv("FRAPPE_API_SECRET");
  const res = await fetch(`${base}/api/method/crypto_payroll.api.post_journal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${key}:${secret}`,
    },
    // Slice B gotcha #1: Frappe routes by Host header. We do NOT set Host
    // manually (fetch/undici treats it as a forbidden header). Instead FRAPPE_URL
    // MUST be the site host (http://chainpay.localhost:PORT), so fetch derives the
    // correct Host automatically. chainpay.localhost resolves to 127.0.0.1 on the
    // host where Electron main runs.
    body: JSON.stringify({ batch_id: batchId, preview }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Frappe post_journal failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { message: { je_name: string; idempotent: boolean } };
  return { jeName: body.message.je_name, idempotent: body.message.idempotent };
}

export function registerAccountingIpc(): void {
  ipcMain.handle("accounting:postJournal", async (_evt, batchId: string, preview: unknown) => {
    return postJournalToFrappe(batchId, preview);
  });
}
```

In `electron/main/index.ts`, call `registerAccountingIpc()` alongside the other `register*Ipc()` calls (import it at the top).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run electron/main/accounting-host.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/accounting-host.ts apps/desktop/electron/main/accounting-host.test.ts apps/desktop/electron/main/index.ts
git commit -m "feat(phase5): accounting-host main-process Frappe POST + IPC register (Slice C)"
```

---

### Task 6: Desktop — preload bridge + renderer IPC wrapper

**Files:**
- Modify: `apps/desktop/electron/preload/index.ts` (add `accounting` namespace to `ChainpayApi`)
- Create: `apps/desktop/src/lib/accounting/ipc.ts`

**Interfaces:**
- Consumes: main `accounting:postJournal` (Task 5).
- Produces: `window.chainpay.accounting.postJournal(batchId, preview)`; renderer `postJournal(batchId, preview): Promise<PostJournalResult>`.

- [ ] **Step 1: Extend the preload bridge**

In `electron/preload/index.ts`, add to the `chainpay` API object (mirror existing namespaces) and to the exported `ChainpayApi` type:

```ts
    accounting: {
      postJournal: (
        batchId: string,
        preview: unknown,
      ): Promise<{ jeName: string; idempotent: boolean }> =>
        ipcRenderer.invoke("accounting:postJournal", batchId, preview),
    },
```

- [ ] **Step 2: Create the renderer wrapper**

```ts
// apps/desktop/src/lib/accounting/ipc.ts
import type { AccountingJournalPreview } from "@chain-pay/shared";

export interface PostJournalResult {
  jeName: string;
  idempotent: boolean;
}

/** Thin renderer wrapper over the typed IPC bridge. Throws on failure. */
export function postJournal(
  batchId: string,
  preview: AccountingJournalPreview,
): Promise<PostJournalResult> {
  return window.chainpay.accounting.postJournal(batchId, preview);
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && npm run typecheck`
Expected: clean (the `ChainpayApi` type now carries `accounting`).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron/preload/index.ts apps/desktop/src/lib/accounting/ipc.ts
git commit -m "feat(phase5): accounting IPC bridge + renderer wrapper (Slice C)"
```

---

### Task 7: Desktop — account map + batch→journal mapping (⚠ carrying-cost policy)

**Files:**
- Create: `apps/desktop/src/lib/accounting/account-map.ts`
- Create: `apps/desktop/src/lib/accounting/batch-to-journal-inputs.ts`
- Create: `apps/desktop/src/lib/accounting/batch-to-journal-inputs.test.ts`

**Interfaces:**
- Consumes: `buildBatchJournal`, `PaymentJournalInput`, `JournalAccounts`, `PayrollBatch`, `PayrollBatchLine`, `FiatAmount`, `Money` from `@chain-pay/shared`.
- Produces: `DEFAULT_ACCOUNT_MAP`, `AccountMap`, `buildBatchJournalForBatch(batch, map): AccountingJournalPreview`.

> **⚠ Execution note (learning contribution):** the `feeFiat` conversion + carrying-cost policy inside `lineToPaymentInput` is the one genuine accounting decision in this slice. Before applying the reference code below, the implementer should pause and offer Phill the chance to write that ~6-line policy himself (per spec §"Carrying cost / FX policy"). The reference implementation here is correct and test-backed (zero-FX), so the plan is non-blocking if he declines.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/lib/accounting/batch-to-journal-inputs.test.ts
import { describe, it, expect } from "vitest";
import type { PayrollBatch } from "@chain-pay/shared";
import { DEFAULT_ACCOUNT_MAP } from "./account-map";
import { buildBatchJournalForBatch } from "./batch-to-journal-inputs";

function batch(over: Partial<PayrollBatch> = {}): PayrollBatch {
  return {
    kind: "payroll", id: "pb_1", createdAt: "t", updatedAt: "t",
    label: "L", treasuryId: "tr1", cycleStart: "a", cycleEnd: "b",
    fxSnapshot: [], state: "confirmed", pendingTxId: "0xabc123",
    lines: [{
      payeeId: "alice",
      fiat: { currency: "USD", minor: 200000n },
      crypto: { asset: "CKB", value: 1000_00000000n, decimals: 8 },
      fxRate: "2.0",
      feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
    }],
    ...over,
  };
}

describe("buildBatchJournalForBatch", () => {
  it("maps a zero-fee line to a balanced two-line journal (no fee/FX lines)", () => {
    const preview = buildBatchJournalForBatch(batch(), DEFAULT_ACCOUNT_MAP);
    expect(preview.batchId).toBe("pb_1");
    expect(preview.entries).toHaveLength(2);
    const debit = preview.entries.find((e) => e.debit);
    const credit = preview.entries.find((e) => e.credit);
    expect(debit?.account).toBe("Salary or Wage Expense");
    expect(debit?.debit?.minor).toBe(200000n);
    expect(credit?.account).toBe("Crypto Treasury Asset");
    expect(credit?.credit?.minor).toBe(200000n); // carryingCost = obligation + 0 fee
  });

  it("throws when a confirmed batch has no pendingTxId", () => {
    expect(() => buildBatchJournalForBatch(batch({ pendingTxId: undefined }), DEFAULT_ACCOUNT_MAP))
      .toThrow(/pendingTxId/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/accounting/batch-to-journal-inputs.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement account-map.ts**

```ts
// apps/desktop/src/lib/accounting/account-map.ts
/** Default ERPNext account names — match the four accounts created by seed.py. */
export interface AccountMap {
  salary: string;
  treasury: string;
  networkFeeExpense: string;
  fxGainLoss: string;
}

export const DEFAULT_ACCOUNT_MAP: AccountMap = {
  salary: "Salary or Wage Expense",
  treasury: "Crypto Treasury Asset",
  networkFeeExpense: "Network Fee Expense",
  fxGainLoss: "FX Gain/Loss",
};
```

- [ ] **Step 4: Implement batch-to-journal-inputs.ts**

```ts
// apps/desktop/src/lib/accounting/batch-to-journal-inputs.ts
import {
  buildBatchJournal,
  type AccountingJournalPreview,
  type FiatAmount,
  type PayrollBatch,
  type PayrollBatchLine,
  type PaymentJournalInput,
  type TransactionHash,
} from "@chain-pay/shared";
import type { AccountMap } from "./account-map";

/**
 * Fee in fiat for a line. CARRYING-COST POLICY (Slice C): feeAllocated is the
 * crypto fee for this line; convert it to fiat at the line's fxRate (fiat per 1
 * whole crypto unit). feeAllocated is currently always 0n, so this is 0 today.
 */
function feeFiatForLine(line: PayrollBatchLine): FiatAmount {
  const currency = line.fiat.currency;
  if (line.feeAllocated.value === 0n) return { currency, minor: 0n };
  const divisor = 10n ** BigInt(line.feeAllocated.decimals);
  const whole = line.feeAllocated.value; // smallest units
  // fiat_minor = cryptoSmallest * rate / 10^decimals, rate scaled to 2dp fiat.
  const rateMinor = BigInt(Math.round(Number(line.fxRate) * 100)); // fiat cents per 1 crypto
  return { currency, minor: (whole * rateMinor) / divisor };
}

function lineToPaymentInput(
  line: PayrollBatchLine,
  txHash: TransactionHash,
  map: AccountMap,
): PaymentJournalInput {
  const obligation = { ...line.fiat };
  const feeFiat = feeFiatForLine(line);
  // Zero-FX policy: carryingCost = obligation + feeFiat ⇒ FX gain/loss plug is 0.
  const carryingCost: FiatAmount = {
    currency: obligation.currency,
    minor: obligation.minor + feeFiat.minor,
  };
  return {
    payeeId: line.payeeId,
    obligation,
    feeFiat,
    carryingCost,
    crypto: { ...line.crypto },
    chain: "ckb",
    txHash,
    salaryAccount: map.salary,
    treasuryAccount: map.treasury,
  };
}

/** Build a balanced AccountingJournalPreview from a confirmed payroll batch. */
export function buildBatchJournalForBatch(
  batch: PayrollBatch,
  map: AccountMap,
): AccountingJournalPreview {
  if (!batch.pendingTxId) {
    throw new Error(`batch ${batch.id} has no pendingTxId; cannot build journal`);
  }
  const txHash = batch.pendingTxId as TransactionHash;
  const payments = batch.lines.map((l) => lineToPaymentInput(l, txHash, map));
  return buildBatchJournal(batch.id, payments, {
    networkFeeExpense: map.networkFeeExpense,
    fxGainLoss: map.fxGainLoss,
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/lib/accounting/batch-to-journal-inputs.test.ts && npm run typecheck`
Expected: PASS (2 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/accounting/account-map.ts apps/desktop/src/lib/accounting/batch-to-journal-inputs.ts apps/desktop/src/lib/accounting/batch-to-journal-inputs.test.ts
git commit -m "feat(phase5): account map + batch→journal mapping with zero-FX policy (Slice C)"
```

---

### Task 8: Desktop — store actions `markPosting / markPosted / markPostFailed`

**Files:**
- Modify: `apps/desktop/src/stores/payroll-batches.ts`
- Modify: `apps/desktop/src/stores/payroll-batches.test.ts`

**Interfaces:**
- Consumes: new states (Task 4).
- Produces: `markPosting(batchId)`, `markPosted(batchId, jeName)`, `markPostFailed(batchId, error)` on the store.

- [ ] **Step 1: Write the failing test**

Add to `payroll-batches.test.ts` (follow the file's existing setup for seeding a `confirmed` batch):

```ts
it("drives the accounting-post lifecycle", () => {
  const store = usePayrollBatchesStore.getState();
  // assume helper adds a confirmed batch with id "pbX" (mirror existing tests)
  addConfirmedBatch("pbX");
  store.markPosting("pbX");
  expect(get("pbX").state).toBe("posting");
  store.markPosted("pbX", "ACC-JV-0009");
  expect(get("pbX").state).toBe("posted");
  expect(get("pbX").jeName).toBe("ACC-JV-0009");
});

it("records a post failure with the error and allows retry", () => {
  addConfirmedBatch("pbY");
  const store = usePayrollBatchesStore.getState();
  store.markPosting("pbY");
  store.markPostFailed("pbY", "boom");
  expect(get("pbY").state).toBe("post_failed");
  expect(get("pbY").postError).toBe("boom");
  store.markPosting("pbY"); // retry: post_failed → posting
  expect(get("pbY").state).toBe("posting");
});
```

(`addConfirmedBatch` / `get` mirror existing helpers in the test file; if absent, add a small local helper that inserts a batch and reads it by id.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/stores/payroll-batches.test.ts`
Expected: FAIL — `markPosting` is not a function.

- [ ] **Step 3: Implement the actions**

Add to the store type (near `markBroadcastFailed`):

```ts
  markPosting: (batchId: string) => void;
  markPosted: (batchId: string, jeName: string) => void;
  markPostFailed: (batchId: string, error: string) => void;
```

Add to the store implementation (mirror the `markBroadcast*` immutable pattern; `assertCanTransition` guards each):

```ts
      markPosting: (batchId) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            assertCanTransition(b.state, "posting");
            const { postError: _drop, ...rest } = b;
            return { ...rest, state: "posting" as PayrollBatchState, updatedAt: new Date().toISOString() };
          }),
        }));
      },
      markPosted: (batchId, jeName) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            assertCanTransition(b.state, "posted");
            return { ...b, state: "posted" as PayrollBatchState, jeName, updatedAt: new Date().toISOString() };
          }),
        }));
      },
      markPostFailed: (batchId, error) => {
        set((s) => ({
          batches: s.batches.map((b) => {
            if (b.id !== batchId) return b;
            assertCanTransition(b.state, "post_failed");
            return { ...b, state: "post_failed" as PayrollBatchState, postError: error, updatedAt: new Date().toISOString() };
          }),
        }));
      },
```

Ensure `assertCanTransition` is imported (the file already imports from the state-machine for `transition`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/stores/payroll-batches.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/payroll-batches.ts apps/desktop/src/stores/payroll-batches.test.ts
git commit -m "feat(phase5): store actions for accounting-post lifecycle (Slice C)"
```

---

### Task 9: Desktop — `postBatchJournal` shared execution + double-fire guard

**Files:**
- Create: `apps/desktop/src/lib/accounting/post-batch-journal.ts`
- Create: `apps/desktop/src/lib/accounting/post-batch-journal.test.ts`

**Interfaces:**
- Consumes: `buildBatchJournalForBatch` (Task 7), `postJournal` (Task 6), store actions (Task 8).
- Produces: `postBatchJournal(batchId): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/lib/accounting/post-batch-journal.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";

const postJournal = vi.fn();
vi.mock("./ipc", () => ({ postJournal: (...a: unknown[]) => postJournal(...a) }));

import { postBatchJournal } from "./post-batch-journal";

beforeEach(() => {
  postJournal.mockReset();
  // reset store to a single confirmed batch "pbZ" with one zero-fee line + pendingTxId
  seedConfirmedBatch("pbZ");
});

describe("postBatchJournal", () => {
  it("posts and marks the batch posted with the JE name", async () => {
    postJournal.mockResolvedValue({ jeName: "ACC-JV-1", idempotent: false });
    await postBatchJournal("pbZ");
    expect(postJournal).toHaveBeenCalledTimes(1);
    expect(usePayrollBatchesStore.getState().batches.find((b) => b.id === "pbZ")!.state).toBe("posted");
  });

  it("marks post_failed on a rejected POST", async () => {
    postJournal.mockRejectedValue(new Error("Frappe 417"));
    await postBatchJournal("pbZ");
    const b = usePayrollBatchesStore.getState().batches.find((x) => x.id === "pbZ")!;
    expect(b.state).toBe("post_failed");
    expect(b.postError).toMatch(/417/);
  });

  it("is a no-op when the batch is already posting (double-fire guard)", async () => {
    usePayrollBatchesStore.getState().markPosting("pbZ"); // now in "posting"
    await postBatchJournal("pbZ");
    expect(postJournal).not.toHaveBeenCalled();
  });
});
```

(`seedConfirmedBatch` mirrors the store test helper — insert a `confirmed` batch with one zero-fee line and a `pendingTxId`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/accounting/post-batch-journal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/lib/accounting/post-batch-journal.ts
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { DEFAULT_ACCOUNT_MAP } from "./account-map";
import { buildBatchJournalForBatch } from "./batch-to-journal-inputs";
import { postJournal } from "./ipc";

/**
 * Single execution path shared by the confirmation reactor and the Retry
 * button. Transitions confirmed|post_failed → posting (which is the re-entry
 * guard: a batch already in "posting" is skipped), POSTs, then records the
 * result. Never throws — failures land as post_failed.
 */
export async function postBatchJournal(batchId: string): Promise<void> {
  const store = usePayrollBatchesStore.getState();
  const batch = store.batches.find((b) => b.id === batchId);
  if (!batch) return;
  if (batch.state !== "confirmed" && batch.state !== "post_failed") return; // guard

  store.markPosting(batchId);
  try {
    const preview = buildBatchJournalForBatch(batch, DEFAULT_ACCOUNT_MAP);
    const { jeName } = await postJournal(batchId, preview);
    usePayrollBatchesStore.getState().markPosted(batchId, jeName);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown posting error";
    usePayrollBatchesStore.getState().markPostFailed(batchId, message);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/lib/accounting/post-batch-journal.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/accounting/post-batch-journal.ts apps/desktop/src/lib/accounting/post-batch-journal.test.ts
git commit -m "feat(phase5): postBatchJournal shared execution + double-fire guard (Slice C)"
```

---

### Task 10: Desktop — confirmation→accounting reactor + app wiring

**Files:**
- Create: `apps/desktop/src/lib/accounting/use-batch-confirmation-to-accounting.ts`
- Create: `apps/desktop/src/lib/accounting/use-batch-confirmation-to-accounting.test.ts`
- Modify: the component that mounts `useBatchConfirmationSync` (find via grep) to also mount the accounting reactor.

**Interfaces:**
- Consumes: `postBatchJournal` (Task 9), payroll-batches store.
- Produces: `syncConfirmedToAccounting(): void`, `useBatchConfirmationToAccounting(): void`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/lib/accounting/use-batch-confirmation-to-accounting.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const post = vi.fn().mockResolvedValue(undefined);
vi.mock("./post-batch-journal", () => ({ postBatchJournal: (id: string) => post(id) }));
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { syncConfirmedToAccounting } from "./use-batch-confirmation-to-accounting";

beforeEach(() => { post.mockClear(); /* reset store */ });

describe("syncConfirmedToAccounting", () => {
  it("calls postBatchJournal for each confirmed batch", () => {
    seedConfirmedBatch("c1");
    seedConfirmedBatch("c2");
    syncConfirmedToAccounting();
    expect(post).toHaveBeenCalledWith("c1");
    expect(post).toHaveBeenCalledWith("c2");
  });

  it("ignores batches not in confirmed (posting/posted/post_failed)", () => {
    seedConfirmedBatch("c3");
    usePayrollBatchesStore.getState().markPosting("c3"); // now posting
    syncConfirmedToAccounting();
    expect(post).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/accounting/use-batch-confirmation-to-accounting.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (mirror `use-batch-confirmation-to-invoice.ts`)**

```ts
// apps/desktop/src/lib/accounting/use-batch-confirmation-to-accounting.ts
import { useEffect } from "react";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { postBatchJournal } from "./post-batch-journal";

/**
 * Side-effect: every batch in `confirmed` gets its journal posted. The
 * confirmed→posting transition inside postBatchJournal is the re-entry guard,
 * so a re-fire (React 19 double-effect, store churn) is a no-op.
 */
export function syncConfirmedToAccounting(): void {
  const batches = usePayrollBatchesStore.getState().batches;
  for (const b of batches) {
    if (b.state !== "confirmed") continue;
    void postBatchJournal(b.id);
  }
}

/** React hook: run on mount and whenever the batches store changes. */
export function useBatchConfirmationToAccounting(): void {
  useEffect(() => {
    syncConfirmedToAccounting();
    const unsub = usePayrollBatchesStore.subscribe(() => syncConfirmedToAccounting());
    return unsub;
  }, []);
}
```

- [ ] **Step 4: Wire into the app**

Run: `grep -rn "useBatchConfirmationSync" apps/desktop/src --include=*.tsx`
In the component that calls `useBatchConfirmationSync()` (the invoice reactor), add `useBatchConfirmationToAccounting()` next to it (import from the new module).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/lib/accounting/use-batch-confirmation-to-accounting.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/accounting/use-batch-confirmation-to-accounting.ts apps/desktop/src/lib/accounting/use-batch-confirmation-to-accounting.test.ts apps/desktop/src/<mounting-component>.tsx
git commit -m "feat(phase5): confirmation→accounting reactor + app wiring (Slice C)"
```

---

### Task 11: Desktop — `PayrollBatches.tsx` posted / post_failed + Retry

**Files:**
- Modify: `apps/desktop/src/features/payroll/PayrollBatches.tsx`

**Interfaces:**
- Consumes: batch `state`, `jeName`, `postError`; `postBatchJournal` (Task 9) for Retry.

- [ ] **Step 1: Render the new states**

In the batch row/status rendering, add branches:
- `state === "posting"` → a subtle "Posting to accounting…" indicator.
- `state === "posted"` → "Posted · {batch.jeName}".
- `state === "post_failed"` → an error chip showing `batch.postError` and a **Retry** button whose `onClick` calls `void postBatchJournal(batch.id)` (import from `@/lib/accounting/post-batch-journal`).

Follow the existing status-rendering pattern in the file (match how `broadcast_failed` + its retry are rendered).

- [ ] **Step 2: Typecheck + full desktop suite**

Run: `cd apps/desktop && npm run typecheck && npx vitest run`
Expected: typecheck clean; full suite green (all prior Slice C tests + existing tests).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/features/payroll/PayrollBatches.tsx
git commit -m "feat(phase5): surface posting/posted/post_failed + Retry in PayrollBatches (Slice C)"
```

---

### Task 12: Smoke playbook + env documentation

**Files:**
- Create: `docs/phase-5-slice-c-smoke-playbook.md`
- Modify: `apps/backend/README.md` (note the three `FRAPPE_*` main-process env vars and how to mint a Frappe API key/secret)

**Interfaces:** none (docs).

- [ ] **Step 1: Write the smoke playbook**

Document the manual end-to-end:
1. `bash scripts/backend-up.sh` (ensures seed, custom field, FY, cost center).
2. Mint a Frappe API key/secret for Administrator (UI: User → Settings → API Access, or `bench` console); set the three `FRAPPE_*` vars in the desktop main process environment (point `FRAPPE_URL` at `http://chainpay.localhost:8001`).
3. Drive a payroll batch to `confirmed` (reuse the Phase 2.5 smoke path).
4. Verify: a submitted Journal Entry appears in ERPNext carrying `crypto_batch_id` = the batch id; the batch row shows "Posted · ACC-JV-…".
5. Re-trigger (wifi cycle / app reload): no duplicate JE (idempotent); batch stays `posted`.
6. Stop the backend (`bash scripts/backend-down.sh`), drive another batch to `confirmed`: batch shows `post_failed`. Restart backend, click **Retry**: transitions to `posted`.

- [ ] **Step 2: Document env vars in backend README**

Add a short "Accounting bridge (desktop → Frappe)" section listing `FRAPPE_URL`, `FRAPPE_API_KEY`, `FRAPPE_API_SECRET` (main-process only; never in renderer / never committed) and the Host-header routing note.

- [ ] **Step 3: Commit**

```bash
git add docs/phase-5-slice-c-smoke-playbook.md apps/backend/README.md
git commit -m "docs(phase5): Slice C smoke playbook + accounting-bridge env vars"
```

---

## Final verification (after all tasks)

- [ ] `cd apps/desktop && npm run typecheck && npx vitest run` — full desktop suite green.
- [ ] Backend: `docker compose -p chainpay-backend exec backend bench --site chainpay.localhost run-tests --app crypto_payroll` — all Frappe tests green.
- [ ] `bash scripts/backend-smoke.sh` — still 5/5.
- [ ] Whole-branch opus review (per `subagent-driven-cross-task-bugs` memory) before PR.
- [ ] Manual smoke per `docs/phase-5-slice-c-smoke-playbook.md`.
- [ ] Update `.remember/remember.md` handoff.

## Spec coverage check

| Spec section | Task(s) |
|---|---|
| Idempotent `crypto_batch_id` field | 1 |
| Seed delivers postable GL (FY + cost center) | 2 |
| `post_journal` endpoint (validate, idempotent, balance, submit) | 3 |
| New batch states + transitions | 4 |
| Main-process HTTP + creds + Host header | 5 |
| Typed IPC bridge + renderer wrapper | 6 |
| Account map + batch→journal mapping + zero-FX policy | 7 |
| Store lifecycle actions | 8 |
| Shared execution + double-fire guard | 9 |
| Confirmation reactor + wiring | 10 |
| UI posted/post_failed/Retry | 11 |
| Smoke playbook + env docs | 12 |
