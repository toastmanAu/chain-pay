# Phase 5 / Slice B — Frappe env standup (design)

**Date:** 2026-06-18
**Branch (suggested):** `feat/phase5-frappe-env-standup`
**Status:** Approved design, ready for implementation plan
**Depends on:** Phase 5 / Slice A (`buildBatchJournal` in `@chain-pay/shared`, PR #13) — only conceptually; no code dependency.
**Unblocks:** Slice C (accounting bridge + accounting REST), which is the first consumer of `buildBatchJournal` and posts ERPNext Journal Entries.

## Goal

Stand up a reproducible local ERPNext environment, via the **official frappe_docker**, with the custom `crypto_payroll` Frappe app installed as an **editable** (bind-mounted) app and a **minimal seed** so that a balanced Journal Entry can be posted end-to-end. This is what Slice C deploys its `accounting_bridge.post_journal()` logic into.

"Done" means: a developer runs one script and gets ERPNext at `localhost:8000` with `erpnext` + `crypto_payroll` installed, the 4 existing DocTypes migrated, a test Company + the 4 required GL accounts seeded, and a smoke script that proves a trivial balanced JE posts and cancels.

## Non-goals (YAGNI)

- **Frappe HR (HRMS)** — deferred until payroll-side wiring (Slice E) needs it.
- **Sample employees / suppliers / realistic payroll data** — deferred to the slice that needs it.
- **FX / CoinGecko integration** — Slice D.
- **The unstubbed DocTypes** (`Crypto Exchange Rate`, `Crypto Network Fee`, `Crypto Audit Log`, `Crypto Payment`, `Crypto Wallet` beyond the existing stub, etc.) — each created by the slice that consumes it. Slice B installs only the 4 existing JSON stubs.
- **Production hardening** — TLS, backups, resource limits, multi-worker scaling.
- **CI wiring** — noted as a follow-up; the seed module and smoke script are designed to be CI-reusable, but CI itself is out of scope.
- **DocType field-correctness** — Slice B makes the 4 stubs *migrate*; it does not make their field sets *correct*. Correctness is the consuming slice's job (see Risks).

## Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Base infra | Adopt official frappe_docker | Maintainable; the hand-rolled `frappe.Dockerfile` would drift from upstream. |
| App delivery | Hybrid — baked base image + editable bind-mounted `crypto_payroll` | Reproducible boot for frappe+erpnext; fast Slice C iteration on the custom app with no image rebuild. |
| Stack scope | ERPNext + minimal seed; defer HRMS | The accounting bridge only needs ERPNext's GL. |
| Compose topology | Slim dev topology | Fewer moving parts to keep green than the full prod-style split. |
| Hand-rolled Dockerfile | Retire `docker/frappe.Dockerfile` | Replaced by the frappe_docker layered build. |

## Architecture

A reproducible local ERPNext environment built on official frappe_docker images, orchestrated by one idempotent bootstrap script, with a smoke script as the acceptance test.

```
docker/
  apps.json              # pins frappe + erpnext to version-15 (base image build input)
  docker-compose.yml     # slim dev topology (rewritten)
  .env (gitignored)      # secrets; .env.example extended at repo root
scripts/
  backend-up.sh          # idempotent: build → up → site → install → migrate → seed → smoke
  backend-down.sh        # teardown (compose down; optional -v volume wipe)
  backend-smoke.sh       # acceptance assertions
apps/backend/apps/crypto_payroll/
  crypto_payroll/
    setup/seed.py        # idempotent Company + 4 GL accounts
    doctype/...          # 4 existing stubs, minimally fixed to migrate
docs/
  phase-5-slice-b-smoke-playbook.md
```

### Components

**a. Reproducible base image**
- `docker/apps.json` lists `frappe` and `erpnext` pinned to **version-15**.
- Built into a local image tag (e.g. `chainpay/erpnext:v15`) via frappe_docker's layered/custom build (apps.json → base-64 build arg → Containerfile).
- ERPNext is **baked**; `crypto_payroll` is **not** baked — it is bind-mounted and installed at site-setup time so it stays editable.

**b. Compose stack (slim dev topology)**
- Services: `backend` (gunicorn), `db` (MariaDB 11), `redis-cache`, `redis-queue`, `scheduler`.
- Drops the prod-only `frontend` (nginx) / `websocket` split; the dev `backend` serves HTTP directly on `:8000`.
- Secrets via `docker/.env` (gitignored); the repo-root `.env.example` is extended with the new keys (`MARIADB_ROOT_PASSWORD`, `ADMIN_PASSWORD`, `SITE_NAME`, image tag, frappe/erpnext branch).
- `apps/backend/apps/crypto_payroll` bind-mounted into the container's apps path so edits are live with no rebuild.

**c. Bootstrap script — `scripts/backend-up.sh`**
- `set -euo pipefail`; idempotent and re-runnable.
- Steps: build base image (skip if present unless `--rebuild`) → `docker compose up -d` → wait for `db` + `redis` healthy → `bench new-site $SITE_NAME` (skip if site exists) → `bench install-app erpnext` (skip if installed) → install editable `crypto_payroll` (`get-app` from bind mount + `install-app`, skip if installed) → `bench migrate` → run seed → run smoke.
- Companion `scripts/backend-down.sh` for teardown (`docker compose down`, `-v` to wipe volumes for a clean rebuild).

**d. Seed module — `crypto_payroll/setup/seed.py`**
- Idempotent get-or-create. Creates:
  - Company `ChainPay Test` (abbr `CPT`) — auto-creates the default Chart of Accounts.
  - 4 custom GL accounts under their correct roots:
    - `Salary or Wage Expense` → Expense
    - `Crypto Treasury Asset` → Asset (parent for per-chain sub-accounts)
    - `Network Fee Expense` → Expense
    - `FX Gain/Loss` → Income root (signed: gains post credit, losses post debit; no special `account_type`)
- Invoked via `bench --site $SITE_NAME execute crypto_payroll.setup.seed.run`.
- Re-running is a no-op (no duplicates).

**e. DocType migration fix-up**
- Verify the 4 existing DocType JSON stubs migrate under `bench migrate`.
- Apply the **minimum** changes to make them valid/installable (e.g. missing required keys, malformed field defs). Do not redesign field sets.
- No new DocTypes.

## Data flow

```
developer
   │  ./scripts/backend-up.sh
   ▼
[base image build] → [compose up] → [new-site] → [install erpnext]
   → [install editable crypto_payroll] → [migrate] → [seed Company + 4 accounts] → [smoke]
   ▼
ERPNext @ localhost:8000  (erpnext + crypto_payroll installed, GL postable)
   ▼
Slice C writes accounting.py / accounting_bridge.post_journal() against this live GL
```

## Error handling

- Bootstrap script is fail-fast (`set -euo pipefail`) and idempotent — safe to re-run after a partial failure.
- Each mutating step is guarded: site-exists check before `new-site`; `list-apps` check before each `install-app`; seed is get-or-create.
- DB and Redis are health-gated before any `bench` command (poll until ready, bounded timeout with a clear error message on exhaustion).
- Teardown script supports a clean wipe (`-v`) so a corrupted state can be reset deterministically.

## Testing (infra-appropriate)

Infra does not get unit-TDD. The acceptance test is **`scripts/backend-smoke.sh`**, which asserts:

1. Site responds on `:8000` (HTTP 200 on the ping/login route).
2. `bench --site $SITE_NAME list-apps` includes `erpnext` and `crypto_payroll`.
3. The 4 DocTypes exist (`frappe.db.exists("DocType", ...)` for each).
4. Seeded Company `ChainPay Test` and all 4 GL accounts exist.
5. **A trivial balanced JE posts and cancels** — debit `Salary or Wage Expense` and credit `Crypto Treasury Asset` (equal amounts) against the seeded Company, submit, then cancel — proving Slice C will be able to post.

Plus `docs/phase-5-slice-b-smoke-playbook.md` mirroring the existing `phase-*-smoke-playbook.md` convention (manual run steps, expected output, troubleshooting).

The seed module's idempotency is exercised by the bootstrap running seed then smoke re-checking counts; a second `backend-up.sh` run must remain green.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| First base-image build is multi-GB and slow (~15–40 min). | One-time cost; documented in the smoke playbook and script output. Not a blocker. |
| DocType stubs are incomplete and `bench migrate` fails. | Slice B only makes them *migrate*, not *correct*. If a stub needs more than a trivial fix, the spec caps the work: stub it minimally and flag field-correctness as the consuming slice's job. |
| frappe/erpnext version drift. | Pin both to `version-15` explicitly in `apps.json` and `.env`. |
| Installing an editable app into a baked ERPNext image (asset build, app registration). | Use frappe_docker's documented add-an-app path; install at site-setup time inside the running container, not at image-build time. Detailed mechanics are a planning concern. |
| Secrets in compose. | All via gitignored `docker/.env`; `.env.example` documents keys; nothing committed. |

## Acceptance criteria

- [ ] `./scripts/backend-up.sh` from a clean checkout produces a working ERPNext at `localhost:8000` with `erpnext` + `crypto_payroll` installed.
- [ ] The 4 existing DocTypes migrate cleanly.
- [ ] Test Company + 4 GL accounts are seeded and idempotent across re-runs.
- [ ] `./scripts/backend-smoke.sh` passes all 5 assertions, including the post-and-cancel JE.
- [ ] `docs/phase-5-slice-b-smoke-playbook.md` documents the manual run + troubleshooting.
- [ ] Hand-rolled `docker/frappe.Dockerfile` retired; no secrets committed.
