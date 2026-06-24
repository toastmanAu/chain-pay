# Phase 5 / Slice B — backend env smoke playbook

Stands up a local ERPNext + crypto_payroll environment for the accounting bridge.

## One-command standup

```bash
cp .env.example docker/.env   # first time only; edit as needed (see below)
./scripts/backend-up.sh       # first run pulls a multi-GB image (~10–20 min)
```

Success ends with `ALL SMOKE CHECKS PASSED`.

### URL and credentials

ERPNext is served by Frappe's Host-header routing. The site name is
`chainpay.localhost` (set via `SITE_NAME` in `docker/.env`). Resolve it at:

```
http://chainpay.localhost:${BACKEND_PORT}
```

The default `BACKEND_PORT` in `.env.example` is **8000**. If host port 8000 is
already occupied on your machine, open `docker/.env` and change it:

```
BACKEND_PORT=8001
```

`*.localhost` resolves to 127.0.0.1 automatically on systems with
systemd-resolved. If your setup does not resolve it, add this line to
`/etc/hosts`:

```
127.0.0.1 chainpay.localhost
```

Or test the API directly without DNS:

```bash
curl --resolve chainpay.localhost:8001:127.0.0.1 \
     http://chainpay.localhost:8001/api/method/ping
```

**Login:** Administrator / the `ADMIN_PASSWORD` set in `docker/.env`
(default: `admin`).

## What the smoke checks assert

1. Site answers on `http://chainpay.localhost:${BACKEND_PORT}` (`/api/method/ping` → 200)
2. `erpnext` and `crypto_payroll` are installed
3. The 4 Crypto Payroll DocTypes exist
4. Seeded Company `ChainPay Test` + 4 GL accounts exist
5. A balanced Journal Entry posts and cancels cleanly

## Running the app's tests

Frappe unit tests require test mode to be enabled once per site (safe to
re-run; the flag is idempotent):

```bash
docker compose -f docker/docker-compose.yml exec backend \
  bench --site chainpay.localhost set-config allow_tests true
```

Then run the crypto_payroll test suite:

```bash
docker compose -f docker/docker-compose.yml exec backend \
  bench --site chainpay.localhost run-tests --app crypto_payroll
```

This exercises the seed tests (`test_seed.py`) and any other Frappe unit tests
defined under `apps/crypto_payroll`.

## Re-running / resetting

- `./scripts/backend-up.sh` — idempotent; safe to re-run at any time.
- `./scripts/backend-smoke.sh` — re-run smoke checks against a running stack.
- `./scripts/backend-down.sh` — stop the stack (volumes preserved; data intact).
- `./scripts/backend-down.sh -v` — stop **and wipe volumes** for a clean rebuild.

## Reproducibility

Record the resolved image digest after the first pull and pin it in
`docker/.env` to prevent silent image drift:

```bash
docker image inspect frappe/erpnext:version-15 \
  --format '{{index .RepoDigests 0}}'
# then set in docker/.env:
# ERPNEXT_IMAGE=frappe/erpnext@sha256:<digest>
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Host port occupied | `BACKEND_PORT=8000` clashes with another local service | Set `BACKEND_PORT=8001` (or any free port) in `docker/.env` |
| Ping returns 404 or wrong response | Host-header routing: Frappe serves by `chainpay.localhost`, not `localhost` | Use `http://chainpay.localhost:${BACKEND_PORT}` — never plain `localhost` |
| DB never becomes healthy | Port 3306 taken by a host MariaDB, or container not starting | `docker logs chainpay-db`; free the port or change the host mapping |
| `new-site` fails on DB root auth | `MARIADB_ROOT_PASSWORD` changed after first boot (volume has old password) | Wipe with `./scripts/backend-down.sh -v` and re-run |
| Migrate role error | A DocType `.json` references `HR Manager` | Remove the reference — HRMS is deferred; no DocType may use that role |
| App not found on install | `apps/crypto_payroll` bind mount not populated, or missing from `sites/apps.txt` | Confirm the bind mount is present and re-run `backend-up.sh` |
