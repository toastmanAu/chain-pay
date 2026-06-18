# Phase 5 / Slice B — Frappe env standup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a reproducible local ERPNext environment with the editable `crypto_payroll` app installed and a minimal seed, so a balanced Journal Entry can be posted end-to-end (the deploy target for Slice C).

**Architecture:** Use the official prebuilt `frappe/erpnext:version-15` image (ERPNext baked) orchestrated by a slim docker-compose stack. `crypto_payroll` is bind-mounted into the backend container and installed at site-setup time so it stays editable. One idempotent bootstrap script brings everything up; a smoke script is the acceptance test.

**Tech Stack:** Docker Compose, `frappe/erpnext:version-15`, MariaDB 10.6, Redis 6.2, Bash, Python (Frappe app code + Frappe test).

> **Refinement vs spec:** The spec said "build a custom image from apps.json (frappe + erpnext)". This plan instead uses the **official prebuilt `frappe/erpnext:version-15`** image — same "baked reproducible base + editable app" intent, but no multi-GB local build (just a pull). The `apps.json` layered build is retained only as a documented escape hatch for baking *additional* apps later (HRMS, payments). This was flagged to and accepted by the user.

## Global Constraints

- **Frappe/ERPNext pinned to version 15.** Image: `frappe/erpnext:version-15` (record the resolved digest in the smoke playbook after first pull for reproducibility).
- **MariaDB 10.6**, **Redis 6.2-alpine** — the frappe-blessed versions for v15 (changes the Phase-0 stub's MariaDB 11).
- **No secrets committed.** All passwords via gitignored `docker/.env`; `.env.example` (repo root) documents keys.
- **No private keys, ever** (ChainPay hard rule #1) — N/A here, but the env never holds signing keys.
- **HRMS deferred.** Do not install Frappe HR. Do not reference HRMS-only roles (e.g. `HR Manager`) in DocType permissions.
- **No new DocTypes.** Only the 4 existing stubs are made to migrate. `Crypto Exchange Rate` / `Network Fee` / `Audit Log` etc. are deferred to their consuming slices.
- **Site name:** `chainpay.localhost` (Frappe resolves `*.localhost` to 127.0.0.1; avoids `/etc/hosts` edits). Exposed on `localhost:8000`.
- **Seeded Company:** name `ChainPay Test`, abbr `CPT`, default currency `USD`, country `Australia`.
- **Commands mirror frappe_docker's known-good `pwd.yml` patterns** (https://github.com/frappe/frappe_docker). When a command needs live adjustment, the smoke assertions are the source of truth.

---

### Task 1: Compose stack, env scaffolding, retire hand-rolled Dockerfile

**Files:**
- Create: `docker/docker-compose.yml` (rewrite — replaces the Phase-0 placeholder)
- Create: `docker/.gitignore` (ignore `.env`)
- Delete: `docker/frappe.Dockerfile`
- Modify: `.env.example` (repo root — add backend keys)
- Create: `docker/.env` (gitignored — local secrets; created by copying example)

**Interfaces:**
- Produces: a compose project named `chainpay-backend` with services `db`, `redis-cache`, `redis-queue`, `backend`, `scheduler`, `queue-default`. Backend published on host `8000`. Sites live in named volume `sites`.
- Consumes: nothing.

- [ ] **Step 1: Write the compose file**

`docker/docker-compose.yml`:

```yaml
# Phase 5 / Slice B — slim ERPNext dev stack for the accounting bridge.
# Official prebuilt frappe/erpnext image; crypto_payroll bind-mounted editable.
x-backend-defaults: &backend_defaults
  image: ${ERPNEXT_IMAGE:-frappe/erpnext:version-15}
  restart: unless-stopped
  volumes:
    - sites:/home/frappe/frappe-bench/sites
    # editable custom app — installed at site-setup time, not baked
    - ../apps/backend/apps/crypto_payroll/crypto_payroll:/home/frappe/frappe-bench/apps/crypto_payroll/crypto_payroll
    - ../apps/backend/apps/crypto_payroll/setup.py:/home/frappe/frappe-bench/apps/crypto_payroll/setup.py:ro
    - ../apps/backend/apps/crypto_payroll/requirements.txt:/home/frappe/frappe-bench/apps/crypto_payroll/requirements.txt:ro
    - ../apps/backend/apps/crypto_payroll/MANIFEST.in:/home/frappe/frappe-bench/apps/crypto_payroll/MANIFEST.in:ro

services:
  db:
    image: mariadb:10.6
    container_name: chainpay-db
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: ${MARIADB_ROOT_PASSWORD:-frappe}
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
      - --skip-character-set-client-handshake
    volumes:
      - db-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      retries: 20

  redis-cache:
    image: redis:6.2-alpine
    container_name: chainpay-redis-cache
    restart: unless-stopped
    volumes:
      - redis-cache-data:/data

  redis-queue:
    image: redis:6.2-alpine
    container_name: chainpay-redis-queue
    restart: unless-stopped
    volumes:
      - redis-queue-data:/data

  backend:
    <<: *backend_defaults
    container_name: chainpay-backend
    ports:
      - "8000:8000"
    # `bench serve` runs the werkzeug app server on 8000 against the default site.
    command: ["bench", "serve", "--port", "8000"]
    depends_on:
      db:
        condition: service_healthy
      redis-cache:
        condition: service_started
      redis-queue:
        condition: service_started

  scheduler:
    <<: *backend_defaults
    container_name: chainpay-scheduler
    command: ["bench", "schedule"]
    depends_on:
      - backend

  queue-default:
    <<: *backend_defaults
    container_name: chainpay-queue-default
    command: ["bench", "worker", "--queue", "short,default,long"]
    depends_on:
      - backend

volumes:
  sites:
  db-data:
  redis-cache-data:
  redis-queue-data:
```

- [ ] **Step 2: Write `docker/.gitignore`**

```
.env
```

- [ ] **Step 3: Extend repo-root `.env.example`**

Append:

```sh
# ---- Phase 5 / Slice B: Frappe backend ----
ERPNEXT_IMAGE=frappe/erpnext:version-15
MARIADB_ROOT_PASSWORD=frappe
ADMIN_PASSWORD=admin
SITE_NAME=chainpay.localhost
```

- [ ] **Step 4: Create the local `docker/.env`**

```bash
cp .env.example docker/.env
```

(Edit `docker/.env` later for real passwords; defaults are fine for local dev.)

- [ ] **Step 5: Delete the hand-rolled Dockerfile**

```bash
git rm docker/frappe.Dockerfile
```

- [ ] **Step 6: Validate compose config**

Run: `docker compose --env-file docker/.env -f docker/docker-compose.yml config -q`
Expected: exit 0, no output (config is valid).

- [ ] **Step 7: Bring up infra services and confirm DB healthy**

Run:
```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml up -d db redis-cache redis-queue
sleep 5
docker inspect --format '{{.State.Health.Status}}' chainpay-db
```
Expected: eventually prints `healthy` (retry the inspect for up to ~60s).

- [ ] **Step 8: Tear infra back down (clean slate for Task 2's script)**

Run: `docker compose --env-file docker/.env -f docker/docker-compose.yml down`
Expected: services removed.

- [ ] **Step 9: Commit**

```bash
git add docker/docker-compose.yml docker/.gitignore .env.example
git rm docker/frappe.Dockerfile
git commit -m "feat(phase5): slim ERPNext dev compose stack; retire hand-rolled Dockerfile"
```

---

### Task 2: Bootstrap script — bring up, configure, create site, install ERPNext

**Files:**
- Create: `scripts/backend-up.sh` (executable)
- Create: `scripts/lib/backend-common.sh` (shared compose invocation + helpers)

**Interfaces:**
- Consumes: the compose stack from Task 1.
- Produces: an idempotent `scripts/backend-up.sh`. After it runs, site `$SITE_NAME` exists with `erpnext` installed; `dc()` helper (a wrapped `docker compose` call) is reusable by later scripts via `scripts/lib/backend-common.sh`.

- [ ] **Step 1: Write the shared helper `scripts/lib/backend-common.sh`**

```bash
#!/usr/bin/env bash
# Shared helpers for ChainPay backend scripts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/docker/.env"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"

# Load SITE_NAME / ADMIN_PASSWORD / MARIADB_ROOT_PASSWORD from docker/.env
set -a; [ -f "$ENV_FILE" ] && . "$ENV_FILE"; set +a
SITE_NAME="${SITE_NAME:-chainpay.localhost}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
MARIADB_ROOT_PASSWORD="${MARIADB_ROOT_PASSWORD:-frappe}"

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
# Run a bench command inside the backend container.
bench_exec() { dc exec -T backend bench "$@"; }
# Run a bench command scoped to our site.
bench_site() { dc exec -T backend bench --site "$SITE_NAME" "$@"; }

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
```

- [ ] **Step 2: Write `scripts/backend-up.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/backend-common.sh"

log "Pulling image and starting stack"
dc pull
dc up -d

log "Waiting for MariaDB to be healthy"
for i in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' chainpay-db 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && break
  sleep 3
done
[ "$status" = "healthy" ] || { echo "DB did not become healthy"; exit 1; }

log "Configuring bench service hosts (idempotent)"
bench_exec set-config -g db_host db || true
bench_exec set-config -gp db_port 3306 || true
bench_exec set-config -g redis_cache redis://redis-cache:6379 || true
bench_exec set-config -g redis_queue redis://redis-queue:6379 || true
bench_exec set-config -g redis_socketio redis://redis-queue:6379 || true

if dc exec -T backend test -d "sites/$SITE_NAME"; then
  log "Site $SITE_NAME already exists — skipping new-site"
else
  log "Creating site $SITE_NAME with ERPNext"
  bench_exec new-site "$SITE_NAME" \
    --mariadb-user-host-login-scope=% \
    --db-root-password "$MARIADB_ROOT_PASSWORD" \
    --admin-password "$ADMIN_PASSWORD" \
    --install-app erpnext
  bench_exec use "$SITE_NAME"
fi

log "ERPNext install confirmed"
bench_site list-apps
```

- [ ] **Step 3: Make scripts executable**

```bash
chmod +x scripts/backend-up.sh scripts/lib/backend-common.sh
```

- [ ] **Step 4: Run the bootstrap (first real boot — slow, pulls image + builds site)**

Run: `./scripts/backend-up.sh`
Expected: ends with `list-apps` output containing `frappe` and `erpnext`. (First run pulls a multi-GB image and takes 10–20 min.)

- [ ] **Step 5: Verify ERPNext is installed and site answers**

Run:
```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml exec -T backend bench --site chainpay.localhost list-apps
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/api/method/ping
```
Expected: `list-apps` includes `erpnext`; curl prints `200`.

- [ ] **Step 6: Re-run to prove idempotency**

Run: `./scripts/backend-up.sh`
Expected: prints `Site chainpay.localhost already exists — skipping new-site`, still ends green.

- [ ] **Step 7: Commit**

```bash
git add scripts/backend-up.sh scripts/lib/backend-common.sh
git commit -m "feat(phase5): idempotent backend bootstrap script (site + ERPNext install)"
```

---

### Task 3: Install editable crypto_payroll + make the 4 DocTypes migrate

**Files:**
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/doctype/crypto_wallet/__init__.py`
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/doctype/crypto_wallet/crypto_wallet.py`
- Create: `.../crypto_payee_profile/__init__.py` and `crypto_payee_profile.py`
- Create: `.../crypto_payment_batch/__init__.py` and `crypto_payment_batch.py`
- Create: `.../crypto_transaction/__init__.py` and `crypto_transaction.py`
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/doctype/__init__.py` (if absent)
- Modify: all 4 DocType `.json` files — drop `HR Manager` permission rows
- Modify: `scripts/backend-up.sh` — add crypto_payroll install + migrate step

**Interfaces:**
- Consumes: `bench_site` / `dc` helpers from Task 2.
- Produces: site has `crypto_payroll` in `list-apps`; DocTypes `Crypto Wallet`, `Crypto Payee Profile`, `Crypto Payment Batch`, `Crypto Transaction` exist in the DB.

- [ ] **Step 1: Create the controller for each DocType**

`crypto_wallet/crypto_wallet.py`:
```python
import frappe
from frappe.model.document import Document


class CryptoWallet(Document):
    pass
```

`crypto_payee_profile/crypto_payee_profile.py`:
```python
import frappe
from frappe.model.document import Document


class CryptoPayeeProfile(Document):
    pass
```

`crypto_payment_batch/crypto_payment_batch.py`:
```python
import frappe
from frappe.model.document import Document


class CryptoPaymentBatch(Document):
    pass
```

`crypto_transaction/crypto_transaction.py`:
```python
import frappe
from frappe.model.document import Document


class CryptoTransaction(Document):
    pass
```

- [ ] **Step 2: Create the `__init__.py` files**

Create empty `__init__.py` in each of the 4 doctype folders AND in the `doctype/` parent folder:
```bash
touch apps/backend/apps/crypto_payroll/crypto_payroll/doctype/__init__.py
for d in crypto_wallet crypto_payee_profile crypto_payment_batch crypto_transaction; do
  touch "apps/backend/apps/crypto_payroll/crypto_payroll/doctype/$d/__init__.py"
done
```

- [ ] **Step 3: Drop the `HR Manager` permission rows from all 4 JSON files**

In each `.json`, remove the object `{ "role": "HR Manager", ... }` from the `permissions` array. Keep `System Manager` and `Accounts User`. Example for `crypto_transaction.json` — the `permissions` becomes:
```json
  "permissions": [
    { "role": "System Manager", "read": 1, "write": 1, "create": 1 },
    { "role": "Accounts User",  "read": 1 }
  ]
```
For `crypto_wallet.json` it becomes:
```json
  "permissions": [
    { "role": "System Manager", "read": 1, "write": 1, "create": 1, "delete": 1 }
  ]
```
Apply the equivalent removal to `crypto_payee_profile.json` and `crypto_payment_batch.json`.

- [ ] **Step 4: Add the install + migrate step to `scripts/backend-up.sh`**

Insert before the final `log "ERPNext install confirmed"` block:
```bash
if bench_site list-apps | grep -qw crypto_payroll; then
  log "crypto_payroll already installed — running migrate"
else
  log "Installing editable crypto_payroll"
  # app source is bind-mounted at apps/crypto_payroll; register it in the env + apps.txt
  dc exec -T backend bash -lc '
    set -e
    grep -qxF crypto_payroll sites/apps.txt || echo crypto_payroll >> sites/apps.txt
    ./env/bin/pip install -e apps/crypto_payroll
  '
  bench_site install-app crypto_payroll
fi
bench_site migrate
```

- [ ] **Step 5: Run the updated bootstrap**

Run: `./scripts/backend-up.sh`
Expected: ends green; `migrate` completes without role/controller errors.

- [ ] **Step 6: Verify the app and DocTypes exist**

Run:
```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml exec -T backend \
  bench --site chainpay.localhost list-apps | grep -w crypto_payroll
docker compose --env-file docker/.env -f docker/docker-compose.yml exec -T backend \
  bench --site chainpay.localhost execute frappe.client.get_count --kwargs '{"doctype":"DocType","filters":{"module":"Crypto Payroll"}}'
```
Expected: `crypto_payroll` printed; count `4`.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/apps/crypto_payroll/crypto_payroll/doctype scripts/backend-up.sh
git commit -m "feat(phase5): install editable crypto_payroll; add controllers, fix DocType perms to migrate"
```

---

### Task 4: Seed module — Company + 4 GL accounts (idempotent, tested)

**Files:**
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/setup/__init__.py`
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/setup/seed.py`
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/setup/test_seed.py`
- Modify: `scripts/backend-up.sh` — call seed after migrate

**Interfaces:**
- Consumes: a migrated ERPNext site (Task 3).
- Produces: `crypto_payroll.setup.seed.run()` — idempotent; creates Company `ChainPay Test` (abbr `CPT`) and 4 GL accounts (`Salary or Wage Expense`→Expense, `Crypto Treasury Asset`→Asset, `Network Fee Expense`→Expense, `FX Gain/Loss`→Income). Returns `dict` `{"company": str, "accounts": list[str]}`.

- [ ] **Step 1: Write the failing test `setup/test_seed.py`**

```python
import frappe
from frappe.tests.utils import FrappeTestCase
from crypto_payroll.setup import seed

ACCOUNTS = [
    "Salary or Wage Expense",
    "Crypto Treasury Asset",
    "Network Fee Expense",
    "FX Gain/Loss",
]


class TestSeed(FrappeTestCase):
    def test_run_creates_company_and_accounts(self):
        result = seed.run()
        self.assertEqual(result["company"], "ChainPay Test")
        self.assertTrue(frappe.db.exists("Company", "ChainPay Test"))
        for acc in ACCOUNTS:
            self.assertTrue(
                frappe.db.exists("Account", {"account_name": acc, "company": "ChainPay Test"}),
                f"missing account {acc}",
            )

    def test_run_is_idempotent(self):
        seed.run()
        before = frappe.db.count("Account", {"company": "ChainPay Test"})
        seed.run()
        after = frappe.db.count("Account", {"company": "ChainPay Test"})
        self.assertEqual(before, after)
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml exec -T backend \
  bench --site chainpay.localhost run-tests --app crypto_payroll --module crypto_payroll.setup.test_seed
```
Expected: FAIL — `ModuleNotFoundError: crypto_payroll.setup.seed` (seed not written yet).

- [ ] **Step 3: Write `setup/__init__.py` (empty) and `setup/seed.py`**

`setup/seed.py`:
```python
"""Idempotent seed for the ChainPay accounting bridge dev/test env.

Creates one test Company and the four GL accounts the accounting model
(docs/accounting-model.md) requires. Safe to run repeatedly.
"""
import frappe

COMPANY = "ChainPay Test"
ABBR = "CPT"

# (account_name, root_type, parent group account name without abbr)
ACCOUNTS = [
    ("Salary or Wage Expense", "Expense", "Expenses"),
    ("Crypto Treasury Asset", "Asset", "Current Assets"),
    ("Network Fee Expense", "Expense", "Expenses"),
    ("FX Gain/Loss", "Income", "Income"),
]


def _ensure_company() -> str:
    if not frappe.db.exists("Company", COMPANY):
        frappe.get_doc(
            {
                "doctype": "Company",
                "company_name": COMPANY,
                "abbr": ABBR,
                "default_currency": "USD",
                "country": "Australia",
            }
        ).insert()
        frappe.db.commit()
    return COMPANY


def _ensure_account(account_name: str, root_type: str, parent_group: str) -> str:
    existing = frappe.db.get_value(
        "Account", {"account_name": account_name, "company": COMPANY}, "name"
    )
    if existing:
        return existing
    parent = frappe.db.get_value(
        "Account", {"account_name": parent_group, "company": COMPANY, "is_group": 1}, "name"
    )
    doc = frappe.get_doc(
        {
            "doctype": "Account",
            "account_name": account_name,
            "company": COMPANY,
            "parent_account": parent,
            "root_type": root_type,
            "is_group": 0,
        }
    ).insert()
    frappe.db.commit()
    return doc.name


def run() -> dict:
    _ensure_company()
    names = [_ensure_account(a, rt, pg) for a, rt, pg in ACCOUNTS]
    return {"company": COMPANY, "accounts": names}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml exec -T backend \
  bench --site chainpay.localhost run-tests --app crypto_payroll --module crypto_payroll.setup.test_seed
```
Expected: PASS (2 tests).

- [ ] **Step 5: Wire seed into the bootstrap script**

In `scripts/backend-up.sh`, immediately after the `bench_site migrate` line, add:
```bash
log "Seeding test Company + GL accounts"
bench_site execute crypto_payroll.setup.seed.run
```

- [ ] **Step 6: Run bootstrap and confirm seed present**

Run: `./scripts/backend-up.sh`
Expected: green; final steps create/confirm Company + accounts.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/apps/crypto_payroll/crypto_payroll/setup scripts/backend-up.sh
git commit -m "feat(phase5): idempotent seed (test Company + 4 GL accounts) with Frappe tests"
```

---

### Task 5: Smoke script (post+cancel JE) and teardown script

**Files:**
- Create: `scripts/backend-smoke.sh` (executable)
- Create: `scripts/backend-down.sh` (executable)
- Modify: `scripts/backend-up.sh` — call smoke at the end

**Interfaces:**
- Consumes: `scripts/lib/backend-common.sh` helpers; a fully seeded site.
- Produces: `scripts/backend-smoke.sh` exits 0 only if all 5 acceptance assertions pass; `scripts/backend-down.sh [-v]` tears the stack down.

- [ ] **Step 1: Write `scripts/backend-smoke.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/backend-common.sh"

fail() { echo "✗ $*"; exit 1; }
ok() { echo "✓ $*"; }

log "1. Site responds on :8000"
code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/method/ping || true)"
[ "$code" = "200" ] && ok "ping 200" || fail "ping returned $code"

log "2. erpnext + crypto_payroll installed"
apps="$(bench_site list-apps)"
echo "$apps" | grep -qw erpnext        || fail "erpnext not installed"
echo "$apps" | grep -qw crypto_payroll || fail "crypto_payroll not installed"
ok "both apps installed"

log "3. The 4 DocTypes exist"
count="$(bench_site execute frappe.client.get_count \
  --kwargs '{"doctype":"DocType","filters":{"module":"Crypto Payroll"}}' | tr -dc '0-9')"
[ "$count" = "4" ] && ok "4 DocTypes" || fail "expected 4 DocTypes, got '$count'"

log "4. Seed present (Company + 4 accounts)"
bench_site execute frappe.client.get_value \
  --kwargs '{"doctype":"Company","filters":{"name":"ChainPay Test"},"fieldname":"name"}' \
  | grep -q "ChainPay Test" || fail "Company missing"
acc_count="$(bench_site execute frappe.client.get_count \
  --kwargs '{"doctype":"Account","filters":{"company":"ChainPay Test","account_name":["in",["Salary or Wage Expense","Crypto Treasury Asset","Network Fee Expense","FX Gain/Loss"]]}}' | tr -dc '0-9')"
[ "$acc_count" = "4" ] && ok "4 GL accounts" || fail "expected 4 accounts, got '$acc_count'"

log "5. A balanced Journal Entry posts and cancels"
bench_site execute crypto_payroll.setup.smoke_je.post_and_cancel || fail "JE post/cancel failed"
ok "JE post + cancel"

echo; echo "ALL SMOKE CHECKS PASSED"
```

- [ ] **Step 2: Write the JE helper used by smoke — `setup/smoke_je.py`**

`apps/backend/apps/crypto_payroll/crypto_payroll/setup/smoke_je.py`:
```python
"""Smoke-only: prove a balanced JE can be posted and cancelled."""
import frappe

COMPANY = "ChainPay Test"


def _acct(name: str) -> str:
    return frappe.db.get_value("Account", {"account_name": name, "company": COMPANY}, "name")


def post_and_cancel() -> str:
    je = frappe.get_doc(
        {
            "doctype": "Journal Entry",
            "voucher_type": "Journal Entry",
            "company": COMPANY,
            "accounts": [
                {"account": _acct("Salary or Wage Expense"), "debit_in_account_currency": 100},
                {"account": _acct("Crypto Treasury Asset"), "credit_in_account_currency": 100},
            ],
        }
    )
    je.insert()
    je.submit()
    je.cancel()
    return je.name
```

- [ ] **Step 3: Write `scripts/backend-down.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/backend-common.sh"

if [ "${1:-}" = "-v" ]; then
  log "Tearing down stack AND wiping volumes"
  dc down -v
else
  log "Tearing down stack (volumes preserved; pass -v to wipe)"
  dc down
fi
```

- [ ] **Step 4: Make executable and call smoke from bootstrap**

```bash
chmod +x scripts/backend-smoke.sh scripts/backend-down.sh
```
At the end of `scripts/backend-up.sh`, replace the `log "ERPNext install confirmed"` / `bench_site list-apps` tail with:
```bash
log "Running smoke checks"
"$REPO_ROOT/scripts/backend-smoke.sh"
```

- [ ] **Step 5: Full run from clean slate**

Run:
```bash
./scripts/backend-down.sh -v
./scripts/backend-up.sh
```
Expected: ends with `ALL SMOKE CHECKS PASSED`.

- [ ] **Step 6: Run smoke standalone (proves it works against an already-up stack)**

Run: `./scripts/backend-smoke.sh`
Expected: `ALL SMOKE CHECKS PASSED`.

- [ ] **Step 7: Commit**

```bash
git add scripts/backend-smoke.sh scripts/backend-down.sh scripts/backend-up.sh \
  apps/backend/apps/crypto_payroll/crypto_payroll/setup/smoke_je.py
git commit -m "feat(phase5): smoke script (post+cancel JE) + teardown script"
```

---

### Task 6: Smoke playbook doc + backend README refresh

**Files:**
- Create: `docs/phase-5-slice-b-smoke-playbook.md`
- Modify: `apps/backend/README.md` (replace the Phase-4-preview manual steps with the scripted flow)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: documentation only; no code.

- [ ] **Step 1: Write `docs/phase-5-slice-b-smoke-playbook.md`**

```markdown
# Phase 5 / Slice B — backend env smoke playbook

Stands up a local ERPNext + crypto_payroll environment for the accounting bridge.

## One-command standup

\`\`\`bash
cp .env.example docker/.env   # first time only; edit passwords if desired
./scripts/backend-up.sh       # first run pulls a multi-GB image (~10–20 min)
\`\`\`

Success ends with `ALL SMOKE CHECKS PASSED`. ERPNext is then at http://localhost:8000
(Administrator / the ADMIN_PASSWORD in docker/.env).

## What the smoke checks assert

1. Site answers on :8000 (`/api/method/ping` → 200)
2. `erpnext` and `crypto_payroll` are installed
3. The 4 Crypto Payroll DocTypes exist
4. Seeded Company `ChainPay Test` + 4 GL accounts exist
5. A balanced Journal Entry posts and cancels

## Re-running / resetting

- `./scripts/backend-up.sh` — idempotent; safe to re-run.
- `./scripts/backend-smoke.sh` — re-run smoke against a running stack.
- `./scripts/backend-down.sh` — stop (keeps data).
- `./scripts/backend-down.sh -v` — stop and wipe volumes for a clean rebuild.

## Reproducibility

Record the resolved image digest after first pull and pin it in `docker/.env`:
\`\`\`bash
docker image inspect frappe/erpnext:version-15 --format '{{index .RepoDigests 0}}'
# set ERPNEXT_IMAGE=frappe/erpnext@sha256:... in docker/.env
\`\`\`

## Troubleshooting

- **DB never healthy:** `docker logs chainpay-db`; ensure port 3306 isn't taken by a host MariaDB.
- **`new-site` fails on db root auth:** check `MARIADB_ROOT_PASSWORD` matches between `docker/.env` and the running `db` (wipe with `-v` if you changed it after first boot).
- **migrate role error:** confirm no DocType `.json` references `HR Manager` (HRMS is deferred).
- **app not found on install:** confirm the bind mount populated `apps/crypto_payroll` and it's in `sites/apps.txt`.
```

- [ ] **Step 2: Refresh `apps/backend/README.md`**

Replace the `## Phase 4 setup (preview)` section's manual `bench` block with:
```markdown
## Local standup (Phase 5 / Slice B)

The environment is scripted. From the repo root:

\`\`\`bash
cp .env.example docker/.env
./scripts/backend-up.sh
\`\`\`

See [../../docs/phase-5-slice-b-smoke-playbook.md](../../docs/phase-5-slice-b-smoke-playbook.md)
for details, reset, and troubleshooting. HRMS and additional DocTypes are added by later slices.
```

- [ ] **Step 3: Commit**

```bash
git add docs/phase-5-slice-b-smoke-playbook.md apps/backend/README.md
git commit -m "docs(phase5): backend smoke playbook + scripted-standup README"
```

---

## Self-Review

**Spec coverage:**
- Reproducible base image → Task 1 (official pinned image; refinement noted). ✓
- Slim compose topology → Task 1. ✓
- Bootstrap + teardown scripts → Tasks 2, 5. ✓
- Editable crypto_payroll install → Task 3. ✓
- DocType migration fix-up → Task 3 (controllers + `__init__` + drop `HR Manager`). ✓
- Seed module (Company + 4 accounts) → Task 4. ✓
- Smoke test (5 assertions incl. post+cancel JE) → Task 5. ✓
- Smoke playbook doc → Task 6. ✓
- Retire `frappe.Dockerfile` → Task 1. ✓
- No secrets committed (`.env` gitignored, `.env.example` documents keys) → Task 1. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases". Every code step shows full content. The only acknowledged live-iteration points (image-install command shape) cite frappe_docker and are validated by the smoke assertions.

**Type/name consistency:** `seed.run()` returns `{"company", "accounts"}` — consumed by `test_seed.py` (`result["company"]`). `smoke_je.post_and_cancel()` referenced in `backend-smoke.sh` step 5 and defined in step 2. `dc`/`bench_site`/`bench_exec`/`REPO_ROOT` defined in `backend-common.sh` (Task 2) and used in Tasks 2/5. Site name `chainpay.localhost`, Company `ChainPay Test`, 4 account names consistent across seed, test, smoke. ✓
```
