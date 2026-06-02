# Phase 4 Smoke Playbook — Mobile Companion v1

Run after every Phase 4 task that touches end-to-end flow. Same shape as `docs/phase-3c-smoke-playbook.md`.

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

## 5. Cert change

- [ ] Stop desktop, delete `~/.config/chain-pay/biscuit-root.enc` AND restart (forces new cert)
- [ ] Mobile: try to capture → expect hard-fail modal "Desktop identity changed — re-pair?"
- [ ] Re-pair → recovery

## 6. Image cache cap

- [ ] Capture 50+ images
- [ ] Verify `apps/mobile` cache dir purges oldest synced after total exceeds 500MB

## 7. CEMP-PQ cellular fallback — DEFERRED to v2

This step removed from v1 smoke per the scoping update at the top of `docs/superpowers/specs/2026-06-02-mobile-companion-design.md`. CEMP-PQ on phone deferred until v2 (requires CCC bundled + remote CKB RPC + ML-KEM encap + tx construction).

## Known v1.1 Deferrals

The following items in this playbook **will not pass cleanly on v1** and are tracked for v1.1:

### TLS cert pinning on mobile

Section 1 (pairing) and any subsequent HTTPS call from the mobile app uses platform-default certificate validation. The desktop's self-signed cert will be rejected by iOS and may be inconsistent on Android, even though the `cert_fingerprint` is stored in the pairing record. **v1.1 must wire a React Native TLS verifier** (e.g., `react-native-ssl-pinning` or a custom native module) before this passes on a physical device. Workaround for v1 smoke: manually import the desktop cert into the device trust store, or skip TLS by running an HTTP-only dev mode (not for production).

### Image cache purge (`removeSynced`)

Section 6 (500 MB cap) will not trigger in v1. The `removeSynced` method exists in `useSyncQueue` but is never called from any drain path or screen. **v1.1 must wire a periodic `removeSynced(24 * 3600 * 1000)` call** from the Home screen mount or the drain hook, plus a hard cap check against `Paths.cache` size before each capture.

## Sign-off

- Tester: __________
- Date: __________
- Build SHA: __________
