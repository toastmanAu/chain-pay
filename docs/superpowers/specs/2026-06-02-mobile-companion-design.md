# Phase 4 — Mobile Companion (Capture v1)

**Date:** 2026-06-02
**Status:** Design — pre-implementation
**Phase:** 4 (Mobile companion app, v1)
**Predecessors:** Phase 3a/3b/3c (invoice ingest + OCR pipeline + Surya backend)
**Related:** `fiberconnect_protocol.md` (FiberConnect v1.0.0), fiber-wallet `lib/fiberConnect.ts`, nervos-companion `SettingsScreen.kt`

## TL;DR

A companion mobile app (Expo, iOS + Android) that lets the user photograph invoices on their phone and push them into the existing ChainPay desktop invoice queue. Desktop remains the source of truth. Authentication and pairing reuse the **FiberConnect v1.0.0 protocol** as deployed in fiber-wallet, extended with new L1 Biscuit capabilities. Transport is IP-based (Wi-Fi via mDNS + Tailscale via manual host) over HTTPS. Offline-first: captures queue locally and drain when the desktop is reachable.

> **Scoping update 2026-06-02:** CEMP-PQ on-chain cellular fallback deferred to v2. Implementation cost (CCC bundling on phone + remote CKB RPC + ML-KEM encap + tx construction) outweighs v1 value for a fallback that almost never fires. See the v2 deferred list at the bottom of this doc.

## Goals

- Photograph invoices in the field, push to desktop's existing invoice store
- Run OCR on-device using native APIs (iOS Vision, Android ML Kit) — replaces Tesseract on mobile
- Work offline; sync when paired desktop becomes reachable
- Interop with existing CKB-ecosystem companion surfaces (fiber-wallet, nervos-companion) via shared FiberConnect protocol

## Non-goals (v1)

- Payment approval / multisig signing on phone (deferred to v2)
- Treasury dashboard / balance view on phone (v2)
- Multi-desktop pairing — one phone, one desktop in v1
- Edit-after-sync — desktop is the merge target; phone never re-reads its own uploads
- iOS-only or Android-only first cut — Expo gives both
- Surya remote OCR on phone — native is the default; remote-Surya stays a desktop opt-in
- Full standalone mobile app (no embedded light client; that's a Phase 6+ problem)

## Architecture

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│   ChainPay Mobile (Expo)│         │  ChainPay Desktop (Electron) │
│                         │         │                              │
│  ┌──────────────────┐   │  HTTPS  │  ┌────────────────────────┐  │
│  │ Capture screen   │───┼─POST───►│  │ pair-server            │  │
│  │ Review screen    │   │ /invoices  │ (electron/main)        │  │
│  │ Sync queue       │   │         │  └────────┬───────────────┘  │
│  └──────────────────┘   │         │           │ IPC              │
│           │             │         │  ┌────────▼───────────────┐  │
│  ┌────────▼─────────┐   │         │  │ existing invoice store │  │
│  │ Native OCR       │   │         │  │ (renderer/zustand)     │  │
│  │ (Vision / MLKit) │   │         │  └────────────────────────┘  │
│  └──────────────────┘   │         │                              │
│  ┌──────────────────┐   │ CEMP-PQ │  ┌────────────────────────┐  │
│  │ CEMP-PQ client   │◄──┼─on-chain┼─►│ CEMP-PQ comm-transport │  │
│  └──────────────────┘   │ fallback│  │ (existing)             │  │
└─────────────────────────┘         │  └────────────────────────┘  │
                                    └──────────────────────────────┘
```

### Transports

- **IP/HTTPS (primary)** — phone discovers desktop via mDNS on the LAN, or hits a saved Tailscale IP. TLS via self-signed cert pinned at pair time. Wi-Fi and Tailscale collapse into one code path — both terminate at `https://<host>:<port>` with a pinned cert fingerprint.
- **CEMP-PQ on-chain (fallback)** — when IP transport has failed 10× with no reachability flips, escape via the existing on-chain encrypted comm channel from `packages/cemp-pq`. ~30s round-trip, costs CKB per message, works anywhere with internet.

### Repo layout

Monorepo extension. New folder `apps/mobile/` joins existing `apps/desktop/`. No new packages — `packages/shared` and `packages/cemp-pq` are imported as-is.

```
chain-pay/
├── apps/
│   ├── desktop/                 (existing)
│   └── mobile/                  (new — Expo app)
│       ├── app/                 (expo-router routes)
│       ├── lib/                 (ocr, transport, pairing)
│       ├── stores/              (zustand + MMKV)
│       └── __fixtures__/        (test images)
├── packages/
│   ├── shared/                  (existing; gains fiberConnect.ts + mobile-protocol.ts)
│   └── cemp-pq/                 (existing; mobile consumes the same code)
```

## Components

### Mobile (`apps/mobile/`)

| Component | Job | Key dep |
|---|---|---|
| `features/capture/CaptureScreen.tsx` | Camera screen, photo preview, retake | `react-native-vision-camera` |
| `features/review/ReviewScreen.tsx` | Reuses desktop's review-form shape — extracted fields, edit, confirm | shared types from `packages/shared` |
| `features/queue/QueueScreen.tsx` | Sync queue UI: pending / syncing / synced / failed / pending-cellular | own zustand store |
| `features/pairing/PairingScreen.tsx` | QR scanner → parse `fiberconnect://` → save | `expo-camera`, `lib/fiberConnect` |
| `lib/ocr/native-ocr.ts` | Wraps Vision (iOS) + ML Kit (Android) behind one `OcrFn` signature | `@react-native-ml-kit/text-recognition`, `expo-modules` for iOS Vision shim |
| `lib/ocr/mapper.ts` | Reuses `regex-shared.ts` from desktop to turn raw OCR text → `ExtractionResult` | `packages/shared` |
| `lib/transport/ip-client.ts` | HTTPS client with cert-pin, mDNS discovery, retry/backoff, Bearer auth | `react-native-zeroconf` |
| `lib/transport/cemp-client.ts` | Thin wrapper around `packages/cemp-pq` for cellular fallback | `packages/cemp-pq` |
| `lib/transport/index.ts` | Selects active transport based on reachability; falls back IP → CEMP-PQ | — |
| `lib/fiberConnect.ts` | Re-exports the shared FiberConnect URI parser/builder | `packages/shared` |
| `stores/pairing.ts` | Persists `{rpc_url, auth_token, cert_fingerprint}` after QR pair | `expo-secure-store` |
| `stores/sync-queue.ts` | Persists pending captures (image refs + OCR data + status) | `react-native-mmkv` |

### Desktop (`apps/desktop/electron/main/`)

| Component | Job |
|---|---|
| `pair-server.ts` | HTTPS server on configurable port. Routes: `POST /pair`, `POST /invoices`, `GET /health`, `GET /comm-pubkey`. mDNS broadcast via `bonjour-service`. |
| `pair-server-biscuit.ts` | Generates attenuated Biscuit tokens with ChainPay L1 capabilities, verifies inbound bearer tokens, maintains revocation denylist. |
| `pair-store.ts` | Persists paired-device labels + token IDs + expiries in `safe-storage`. |
| `invoice-receiver.ts` | Converts incoming mobile payload → existing invoice store schema, dispatches via IPC to renderer. |

### Renderer (`apps/desktop/src/`)

- `features/settings/PairingSection.tsx` — shows QR code + copy-link, lists paired phones with expiry + capabilities, lets user revoke. Reuses the existing settings-page pattern from 3c's ExtractionSection.

### Shared (`packages/shared/`)

- `fiberConnect.ts` — direct port of fiber-wallet's `lib/fiberConnect.ts`. Used by desktop, mobile, and any future CKB-ecosystem surface.
- `mobile-protocol.ts` — wire format for `POST /invoices`: envelope shape, OCR result, image-base64 chunks, idempotency key contract.
- `biscuit-capabilities.ts` — TypeScript constants for the L1 Biscuit capability vocabulary (single source of truth for both token issuer and verifier).

## Pairing & auth — FiberConnect v1.0.0

### Protocol layer (adopted verbatim)

- **URI scheme:** `fiberconnect://<base64url(json)>`
- **Payload:** `{rpc_url, auth_token, cert_fingerprint?}`
- **Encoding:** minified JSON → base64-URL no padding (same as fiber-wallet `fiberConnect.ts`)
- **Transport:** QR (local `qrcode` package, no third-party service) + copyable link
- **TLS:** `cert_fingerprint` field is the SHA-256 of the desktop's self-signed cert; phone pins on it

### Auth model — Biscuit bearer tokens

- Desktop holds a root Biscuit signing key in `safe-storage` (Electron's OS-keychain wrapper).
- "Pair Mobile Phone" UI generates an **attenuated Biscuit token** with:
  - capability caveats limiting scope to ChainPay L1 actions (see vocabulary below)
  - expiry caveat (default 30 days, matching fiber-wallet default)
  - a `device_label` fact for human-readable listing in the desktop pair manager
- Token is embedded in the FiberConnect URI as `auth_token`.
- Every phone request: `Authorization: Bearer <auth_token>`.
- Desktop verifies the Biscuit against its root pubkey + checks the requested action is covered by the token's caveats.

### Biscuit capability vocabulary — L1 extension

Existing Fiber capabilities (from fiber-wallet's `mobile_pairing` template):

```
read("node"), read("peers"), read("channels"), read("payments"), write("invoices")
```

L1 extensions used by ChainPay (v1 issues only the first):

```
write("invoices")           # ← v1 minimum: phone pushes captured invoices
read("treasury")            # v2: phone shows balance/state
read("payment_batches")     # v2: phone displays pending sig requests
sign("approval_request")    # v2: phone returns signed approval blob
```

`write("invoices")` is already in the FiberConnect vocabulary — v1 reuses as-is. The L1 extensions are additive; no breaking change for nervos-companion or fiber-wallet. The vocabulary is documented in `packages/shared/src/biscuit-capabilities.ts` so any future CKB-ecosystem desktop can issue compatible tokens.

### Pairing flow

```
desktop "Pair Phone" panel:
  1. Generate Biscuit token from root key
     - caveats: capabilities=[write("invoices")], expiry=now+30d, device_label=<user input>
  2. Build payload: {rpc_url: "https://<host>:<port>", auth_token, cert_fingerprint: sha256(cert)}
  3. Encode URI: fiberconnect://<base64url(json)>
  4. Render QR + copy-link, list under "Paired devices"

phone:
  1. Tap "Pair desktop", open camera
  2. Scan QR → parseFiberConnectUri()
  3. Test connection: GET /health with Authorization: Bearer <token>
  4. POST /pair with phone's CEMP-PQ pubkey (registers phone for v2 push)
  5. GET /comm-pubkey → cache desktop's CEMP-PQ pubkey for cellular fallback
  6. Save {rpc_url, auth_token, cert_fingerprint, desktop_comm_pubkey} to expo-secure-store
  7. Pin cert by fingerprint in HTTPS client config
```

### Revocation

Desktop "Paired devices" list shows label + expiry + capabilities per token. Tap "Revoke" → desktop adds the token's Biscuit revocation ID to a denylist in `safe-storage`. All future requests with that token: 401. Same pattern as fiber-wallet.

### Threat coverage

| Threat | Mitigation |
|---|---|
| MITM on Wi-Fi | TLS + pinned `cert_fingerprint` |
| Stolen phone | Biscuit token in Keychain/Keystore, gated by biometric on app open. Revoke from desktop. |
| Replayed request | Bearer token + TLS; sufficient for v1. v2 sign-requests will add nonce-challenge from desktop. |
| Token exfiltration | 30d expiry caps blast radius. Revocation immediate. |
| Compromised desktop root key | Out of scope — desktop is the trust root. |
| QR shoulder-surf | Treat QR like a password. Re-pair invalidates old token via denylist. |
| Hostile mDNS discovery | mDNS is LAN-scoped. Open ports without a valid Biscuit token return 401; enumeration learns nothing useful. |

## Data flow — capture path

```
Phone                                              Desktop
  │                                                  │
[tap shutter]                                        │
  │ vision-camera → JPEG bytes                       │
  │ resize: longest edge 2000px, JPEG q=85           │
  │ native OCR (Vision/MLKit) → raw text + boxes     │
  │ regex mapper (shared) → ExtractionResult         │
  │                                                  │
[review screen]                                      │
  │ user edits fields if needed                      │
  │ taps "Send to desktop"                           │
  │                                                  │
  │ sync-queue: enqueue {id, image, extraction}      │
  │ status="pending"                                 │
  │                                                  │
  │ drain worker (concurrency=1):                    │
  │   IP reachable? → POST /invoices ──────────────► │
  │     Authorization: Bearer <token>                │
  │     body: {id, extraction, image_chunks[]}       │
  │   else queue, retry on reachability change       │
  │                                                  │
  │                                          Biscuit verify (capability=write("invoices"))
  │                                          idempotency check by id
  │                                          assemble image from chunks
  │                                          IPC → renderer invoice store
  │                                          ▼
  │                                          new invoice row (status="ingested")
  │ ◄──────────201 {invoiceId} or 409 {invoiceId}────│
  │                                                  │
  │ mark queue item "synced", show ✓                 │
  │ schedule image purge in 24h                      │
```

## Offline + sync — queue state machine

```
       [user taps Send]
              │
              ▼
       ┌────────────┐
       │  pending   │  ──── (transport unavailable) ──┐
       └─────┬──────┘                                  │
             │ (drain worker runs)                     │
             ▼                                         │
       ┌────────────┐                                  │
       │  syncing   │                                  │
       └─────┬──────┘                                  │
             ├── 201 ok ────► [ synced ] ─► purge image after 24h
             │
             ├── 4xx (validation) ──► [ rejected ] ─► user fixes in review, re-queues
             │
             ├── 409 duplicate ─────► [ synced ]  (treat as success)
             │
             ├── 5xx / timeout ─────► [ pending ] + backoff (1s → 2s → 8s → 32s → 5min cap)
             │
             └── N=10 failures on IP ──► [ pending-cellular ] ──► try CEMP-PQ ──► [ syncing ]
```

### QueueItem shape (persisted in MMKV)

```ts
type QueueItem = {
  id: string;                       // ulid, primary key + idempotency key
  capturedAt: number;               // epoch ms
  imageRef: string;                 // filename in FileSystem.cacheDirectory
  extraction: ExtractionResult;     // packages/shared, same type as desktop
  status: 'pending' | 'syncing' | 'synced' | 'rejected' | 'pending-cellular';
  attempts: number;
  lastError?: string;
  syncedInvoiceId?: string;         // returned by desktop on success
  transport?: 'ip' | 'cemp-pq';
};
```

### Drain loop

- One worker, concurrency=1. Mirrors the desktop `ExtractionService` pattern from Phase 3b.
- Driven by `useEffect` on `[reachabilityState, queue.pending.length, pairing]`.
- On wake: pull oldest `pending` → mark `syncing` → POST → update.

### Reachability

- `@react-native-community/netinfo` for cellular vs Wi-Fi vs none.
- For the paired desktop specifically: `GET /health` with 3s timeout, exponential backoff between probes (10s → 60s).
- Cache the reachability verdict; re-probe on any NetInfo change or pull-to-refresh.

### Idempotency

- `QueueItem.id` (ulid) is the idempotency key sent to desktop.
- Desktop keeps an LRU of last 1000 seen ids. On duplicate: returns 409 + the existing `invoiceId`.
- Phone treats 409 the same as 201 — marks synced, records the returned `invoiceId`.
- Handles: phone retries after a request the desktop already processed (network blip after success).

### Conflict model (v1)

None. Invoices flow phone → desktop only. Desktop wins all edits. The phone never re-reads its own uploads — just shows "synced ✓" with the desktop-returned `invoiceId`. v2 (treasury read view) gets its own ETag story when we get there.

### Image lifecycle

- Captured at full resolution.
- Immediately resized: longest edge 2000px, JPEG q=85 → typically ~400–800KB.
- Stored as a file under `FileSystem.cacheDirectory` (Expo) — **not** in MMKV (binary blobs bloat the database).
- `imageRef` in MMKV is the filename only.
- On `synced`: keep image 24h (lets user re-review locally if curious), then purge.
- On `rejected`: keep until user resolves.
- Hard cap: total cache > 500MB → purge oldest synced first.
- Wire format: base64 in **256KB chunks** (mirrors the chunked-base64 pattern from 3c `ccad957` — avoids RN's JS-thread freezing on large strings).

### CEMP-PQ escape (cellular fallback)

- Triggered after 10 IP-transport failures with no reachability flips.
- **Key discovery:** at pair time, after the Biscuit handshake succeeds, the phone calls `GET /comm-pubkey` on the desktop and caches the desktop's CEMP-PQ pubkey alongside the FiberConnect pairing record. This keeps the FiberConnect URI payload unchanged (v1.0.0 compatibility preserved) — the comm-pubkey lookup happens *after* the URI is consumed.
- **Phone keypair:** at first install, phone generates its own CEMP-PQ keypair and POSTs the pubkey to the desktop in the pair-handshake request. Desktop stores it alongside the issued Biscuit token's revocation ID. v1 doesn't use the phone's pubkey (unidirectional flow), but registering it now makes v2 desktop→phone push straightforward.
- **Submit flow:** phone encrypts `{id, extraction, image_jpeg}` to the desktop's CEMP-PQ pubkey, submits via on-chain comm channel.
- **Image cap on this path:** 200KB (additional compression pass). Lower audit fidelity; v1 tradeoff for "I'm in a basement and need to log this receipt".
- Desktop's `comm-transport-service` polls, decrypts, dispatches into the same `invoice-receiver.ts` path as the HTTP route.

## Error handling

### Mobile

| Layer | Failure | UX | Recovery |
|---|---|---|---|
| Camera | Permission denied | Inline screen with "open settings" CTA | User grants → retry |
| Camera | No camera / hardware fail | Disable capture, show "use file picker" fallback | Pick from gallery |
| OCR | Native API throws | Capture saved as `pending` with `extraction.status="failed"` | User edits in review screen |
| OCR | Empty / low confidence | Same; review screen shows low-confidence chips | Manual edit |
| Mapper | No vendor / no amount | Sync whatever was extracted; desktop review handles missing fields | Desktop-side correction |
| Transport (IP) | Cert fingerprint mismatch | Hard fail. Modal: "Desktop identity changed — re-pair?" | Re-pair only |
| Transport (IP) | 401 / token revoked | Modal: "This device was unpaired — re-pair?" | Re-pair |
| Transport (IP) | 401 / token expired | Modal: "Pairing expired — re-pair?" | Re-pair |
| Transport (IP) | Timeout / 5xx | Stay in queue, backoff, retry | Automatic |
| Transport (CEMP-PQ) | On-chain submit fail | Backoff, retry | Automatic |
| Storage | MMKV write fail | Banner; new captures blocked | User clears space |
| Storage | Image cache > 500MB | Auto-purge oldest synced | Automatic |

### Desktop `pair-server`

| Failure | Response | Log level |
|---|---|---|
| TLS handshake fail | Connection closed | info |
| Biscuit verify fail | 401 + opaque body | warn (don't say WHY — anti-enumeration) |
| Capability not in token | 403 | warn |
| Token in denylist | 401 | warn (possible revoked-credential reuse) |
| Body decode fail / schema invalid | 400 + structured error | warn |
| Duplicate idempotency key | 409 + existing `invoiceId` | info |
| IPC dispatch fail (renderer dead) | 503; client retries | error |

## Testing strategy

Same TDD discipline as Phase 3a/3b/3c. Tests precede implementation. 80%+ coverage target.

### Unit tests

- `packages/shared/src/fiberConnect.ts` — port the existing fiber-wallet test suite verbatim; add L1 capability cases.
- `apps/mobile/lib/ocr/mapper.ts` — reuses `regex-shared.ts`; existing 3b/3c regex tests apply.
- `apps/mobile/lib/transport/ip-client.ts` — mock fetch; exercise auth header, cert-pin failure, 401/403/409/5xx branches.
- `apps/mobile/lib/transport/cemp-client.ts` — mock CEMP-PQ envelope, verify pubkey routing.
- `apps/mobile/stores/sync-queue.ts` — state-machine transitions, retry backoff math, idempotency key reuse.
- `apps/desktop/electron/main/pair-server.ts` — Biscuit verify happy path + each rejection branch, idempotency LRU behavior.

### Component tests (React Native Testing Library)

- Capture screen: permission states, shutter disabled while OCR runs.
- Review screen: extracted-field rendering, low-confidence chip rules, edit propagation to queue item.
- Queue screen: status badges per state, retry-now action, pending-cellular distinguished from pending.
- Pairing screen: QR scan → parsed payload, test-connection success/failure, save to secure store.

### Integration tests

- **CI:** real Expo app talking to a real Electron `pair-server` running in a child process. Round-trip: scan a generated URI, push 3 fixture invoices, verify they appear in the desktop's mocked invoice store. Mirrors the pattern in `apps/desktop/electron/main/*.test.ts`.
- **Manual smoke playbook:** physical device + real desktop on Wi-Fi. Same format as `docs/phase-3c-smoke-playbook.md`.

### Fixtures

- 5–10 real invoice photos (anonymised) committed to `apps/mobile/__fixtures__/invoices/` — used by both OCR mapper tests AND round-trip integration. Same approach as `0defdb0 test(3c): capture real Surya output fixtures`.

### Manual smoke checklist

- [ ] Pair phone via QR on Wi-Fi (mDNS auto-discovery)
- [ ] Pair phone via QR on Tailscale (manual host entry)
- [ ] Capture 3 invoices on Wi-Fi → all 3 land in desktop
- [ ] Toggle airplane mode → capture 3 more → re-enable → all 3 drain and sync
- [ ] Force a token revoke from desktop while phone is mid-queue → phone shows re-pair UX
- [ ] Force a cert change on desktop → phone shows hard-fail re-pair UX
- [ ] Cellular smoke: cellular-only, IP unreachable → captures route via CEMP-PQ
- [ ] Image cache hits 500MB → auto-purge runs, oldest synced removed first
- [ ] Re-install phone app → re-pair flow works, old queue is gone

## CI considerations

- `apps/mobile/` adds its own Vitest config; runs in the same monorepo `npm test` workflow.
- EAS Build for binaries; not part of CI by default — manual trigger.
- Expo dev client in dev — never the managed Go client, because of native modules (vision-camera, ml-kit, secure-store).

## Open questions deferred to v2

- **CEMP-PQ on-chain cellular fallback** (descoped from v1 on 2026-06-02). Requires CCC bundled on phone + remote CKB RPC client + ML-KEM encapsulation against desktop's `mlKemPub` + CKB tx construction (the actual `@chain-pay/cemp-pq` API is `serializeProfile` / `serializeEncryptedMessage` / `CEMPTransactionBuilder` — not a high-level encrypt-and-send). Defer until phone has need to operate fully off-Wi-Fi.
- Approval / signing flow on phone (which signer transport — JoyID passkey, WalletConnect, Ledger BLE — and how the desktop relays pending sig requests).
- Treasury read-side dashboard (balance, recent payments, pending batches).
- Multi-desktop pairing (one phone → multiple ChainPay desktops, or one phone → ChainPay + fiber-wallet + other CKB-ecosystem desktops).
- Edit-after-sync (allow phone to re-open an already-synced invoice for amendment).
- Two-way sync read model (ETag/Last-Modified, conflict resolution).

## File-level inventory (for the implementation plan)

### New files

```
apps/mobile/                                                  (new Expo app — full tree)
apps/desktop/electron/main/pair-server.ts
apps/desktop/electron/main/pair-server-biscuit.ts
apps/desktop/electron/main/pair-store.ts
apps/desktop/electron/main/invoice-receiver.ts
apps/desktop/src/features/settings/PairingSection.tsx
packages/shared/src/fiberConnect.ts                           (port from fiber-wallet)
packages/shared/src/mobile-protocol.ts
packages/shared/src/biscuit-capabilities.ts
docs/phase-4-smoke-playbook.md                                (added during implementation)
```

### Modified files

```
apps/desktop/electron/main/index.ts                           (start pair-server on app boot)
apps/desktop/src/features/settings/SettingsPage.tsx           (mount PairingSection)
packages/shared/src/index.ts                                  (re-export new modules)
package.json (root)                                           (workspace entry for apps/mobile)
```

## Spec self-review notes

- **Placeholder scan:** clean. No TBDs or vague requirements remain.
- **Internal consistency:** transport story (IP + CEMP-PQ fallback) consistent across architecture, data flow, queue state machine, and error handling sections.
- **Scope check:** v1 is photograph → desktop queue, nothing else. Approval, treasury view, multi-desktop explicitly deferred. Single implementation plan can cover it.
- **Ambiguity check:** Biscuit capability vocabulary pinned to a single source-of-truth file (`packages/shared/src/biscuit-capabilities.ts`); image lifecycle thresholds (2000px, q=85, 500MB, 24h, 200KB on CEMP-PQ) all explicit; idempotency contract explicit (ulid + 1000-entry LRU on desktop).
