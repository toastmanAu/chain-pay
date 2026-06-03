# Phase 4 Smoke Playbook — Mobile Companion v1

Run after every Phase 4 task that touches end-to-end flow. Same shape as `docs/phase-3c-smoke-playbook.md`.

## Resolved in v1.1 (2026-06-03)

- TLS cert pinning on mobile: wired via the `expo-tls-pin` local Expo module (SHA-256 verifier in `URLSession`/`OkHttp`). Mobile `pinned-fetch` rejects connections whose cert fingerprint doesn't match the value stored in the pairing record.
- Comm-pubkey TOFU: closed as a side effect of pinning — `/comm-pubkey` now travels through the pinned channel.
- Fail-open empty `cert_fingerprint`: closed at the scanner — `pair.tsx` rejects any QR missing a non-empty fingerprint.
- Image cache purge: wired in `useDrainQueue` (`removeSynced(24h)` on mount + every hour, plus a 500MB hard cap that evicts everything synced when exceeded).

## Pre-flight

- [ ] Desktop builds: `cd apps/desktop && npm run dev` boots without errors
- [ ] Mobile builds: `cd apps/mobile && npx expo start --tunnel` shows QR
- [ ] Physical device on same Wi-Fi as desktop, or both on Tailscale
- [ ] Camera permission granted on device

## 1. Pairing — Wi-Fi mDNS

- [ ] Settings → Pair mobile → enter label "smoke-phone" → Generate QR
- [ ] Mobile → tap "Pair desktop" → scan QR
- [ ] Mobile lands on home screen showing empty queue
- [ ] Desktop Paired devices list shows "smoke-phone" with 30d expiry

## 2. Capture happy path

- [ ] Mobile → "Capture invoice" → camera opens
- [ ] Shoot a real invoice — capture completes within ~3s including OCR
- [ ] Review screen shows invoice_number, total, currency populated (some may be empty)
- [ ] "Queue for sync" → home shows item with status="pending"
- [ ] Within 30s: status flips to "synced"
- [ ] Desktop invoices list shows the new entry with sourceLabel="smoke-phone"

## 3. Offline → online

- [ ] Mobile: enable airplane mode
- [ ] Capture 3 invoices → all 3 land in queue as "pending"
- [ ] Disable airplane mode
- [ ] Within 60s: all 3 transition to "synced"
- [ ] Desktop shows all 3 invoices

## 4. Revocation

- [ ] Desktop Settings → Paired devices → "Revoke" on smoke-phone
- [ ] Mobile: tap Capture → enqueue one capture
- [ ] Within ~10s: queue item moves to "rejected" with reason mentioning "unauthorized" / "re-pair required"
- [ ] Re-pair → new captures work

## 5a. Cert rotation triggered by user

- [ ] Settings → Pair mobile → Rotate TLS cert → confirm modal shows paired-device count
- [ ] Within ~1s of confirming: QR display refreshes with a visibly different code
- [ ] Paired mobile: next sync attempt within 30s triggers TLS-mismatch → pairing auto-clears
- [ ] Home shows "Desktop identity changed — re-pair to reconnect" + the button text changes to "Re-pair desktop"
- [ ] Re-scan new QR → pairing restored → captures sync against the new cert

## 5b. Cert rotation triggered by desktop quit/restart

- [ ] Stop desktop. Inspect that `~/.config/chain-pay/tls-cert.enc` exists (on Linux; the macOS/Windows equivalents are under `~/Library/Application Support/chain-pay/` and `%APPDATA%\chain-pay\` respectively).
- [ ] Restart desktop. Mobile: capture an invoice → expect successful sync (cert persisted, same fingerprint)
- [ ] Delete `~/.config/chain-pay/tls-cert.enc` (or equivalent) AND restart → cert regenerated → mobile sees TLS-mismatch → auto-re-pair flow as above
- [ ] **Recovery from rotation failure:** Simulate `restartWithCert` failure (e.g. briefly bind port 8233 from another process) right before clicking Rotate → expect an error message in PairingSection. Quit + restart the desktop → server should come back on port 8233 with the new fingerprint (the cert was already persisted; the restart picks it up cleanly).

## 5c. TLS pin enforcement (negative test)

- [ ] On the desktop, temporarily edit `tls-cert-store.ts` to return a freshly-generated cert each call (or rotate without phone re-pairing)
- [ ] Mobile: trigger sync → expect TLS-mismatch outcome → queue items go to `rejected` with reason "tls-mismatch — re-pair required"
- [ ] Restore the cert (or re-pair) → drain resumes normally

## 6. Image cache cap

> **Wired in v1.1** — `useDrainQueue` now calls `removeSynced(24h)` on mount + every hour, plus a 500MB hard cap that evicts all synced items when exceeded.

- [ ] Capture 50+ images
- [ ] Verify `apps/mobile` cache dir purges oldest synced after total exceeds 500MB

## 7. CEMP-PQ cellular fallback — DEFERRED to v2

This step removed from v1 smoke per the scoping update at the top of `docs/superpowers/specs/2026-06-02-mobile-companion-design.md`. CEMP-PQ on phone deferred until v2 (requires CCC bundled + remote CKB RPC + ML-KEM encap + tx construction).

## Sign-off

- Tester: __________
- Date: __________
- Build SHA: __________
