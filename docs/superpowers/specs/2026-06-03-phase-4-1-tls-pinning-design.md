# Phase 4.1 — Mobile TLS Pinning + Cert Persistence

**Date:** 2026-06-03
**Status:** Design — pre-implementation
**Phase:** 4.1 (v1.1 follow-up to Phase 4 mobile companion)
**Predecessors:** Phase 4 (mobile companion v1, shipped 2026-06-03 as `325b35f`)
**Related:** `docs/superpowers/specs/2026-06-02-mobile-companion-design.md` (Phase 4 spec); `docs/phase-4-smoke-playbook.md` (Known v1.1 Deferrals section)

## TL;DR

Phase 4 shipped with a TLS gap: the mobile app stores `cert_fingerprint` from the FiberConnect QR but uses React Native's platform-default `fetch`, which will reject the desktop's self-signed cert on iOS and accept it inconsistently on Android. Phase 4.1 wires actual pinning via a **custom Expo native module** (`expo-tls-pin`) that verifies SHA-256 of the presented cert DER against the runtime-passed fingerprint, persists the desktop cert across boots, and adds a user-triggered rotation path. Two smaller v1.1 punch-list items ride along: scanner-side mandatory `cert_fingerprint`, and image-cache purge (`removeSynced(24h)` + 500MB cap). FiberConnect protocol shape is unchanged — interop with fiber-wallet / nervos-companion preserved.

> **Library choice rationale (2026-06-03):** Initially planned to use `react-native-ssl-pinning@1.6.0`. Verification at writing-plans time revealed that lib pins to **cert files bundled in the app at build time**, not to runtime-passed SHA-256 fingerprints. Our model needs runtime fingerprint pinning (desktop cert is generated at user runtime, fingerprint travels in QR). Custom native module is ~150 LOC Swift + ~150 LOC Kotlin, scoped to a single TLS-verifier delegate per platform, no full fetch reimplementation. Worth the cost given the impedance mismatch with available libraries.

## Goals

- Make HTTPS calls from mobile actually pin to the cert fingerprint stored in the pairing record
- Persist the desktop's self-signed cert so reboots don't silently invalidate every paired phone
- Give the user a "Rotate TLS cert" affordance (with explicit re-pair warning) when they want it
- Detect TLS-pin mismatch on mobile and auto-clear the pairing with clear re-pair UX
- Close the three security-review findings from the Phase 4 post-merge review:
  - HIGH #1: missing certificate pinning (MITM)
  - HIGH #2: comm-pubkey trust-on-first-use (downstream of #1; auto-resolves)
  - MED #3: fail-open empty `cert_fingerprint` in `pair.tsx`
- Wire `removeSynced` so the image cache actually purges (smoke playbook step 6 starts passing)

## Non-goals (v1.1)

- New pairing protocol or bumping FiberConnect to v1.1 — protocol shape stays the same; we add scanner-side strictness
- Auto-rotation of cert near expiry — selfsigned defaults to 365 days; v1.2 problem
- Public-key (SPKI) pinning that survives cert renewal without re-pair — fingerprint pinning is enough for v1.1; SPKI is a future improvement when auto-renewal lands
- Push notification to paired phones telling them "desktop just rotated, please re-pair" — out of scope; phones discover at next sync attempt
- Cert chain pinning / certificate transparency / OCSP — self-signed; not applicable
- Approval flow on phone (Phase 4 spec already deferred to v2)
- CEMP-PQ cellular fallback (Phase 4 spec already deferred to v2)

## Architecture

```
┌─────────────────────────────┐         ┌────────────────────────────────┐
│   Mobile (Expo)             │         │  Desktop (Electron)            │
│                             │         │                                │
│  ┌──────────────────────┐   │ HTTPS   │  ┌──────────────────────────┐  │
│  │ ip-client.ts         │   │ ┌──────►│  │ pair-server.ts           │  │
│  │  ─ pinned fetch ◄────┼───┘ │       │  │  ─ loads cert from store │  │
│  │    via               │     │       │  └─────────▲────────────────┘  │
│  │ react-native-ssl-    │     │       │            │                   │
│  │ pinning              │     │       │  ┌─────────┴────────────────┐  │
│  └──────────────────────┘     │       │  │ tls-cert-store.ts  (new) │  │
│                               │       │  │  ─ persist {key, cert}   │  │
│  ┌──────────────────────┐     │       │  │    in safe-storage       │  │
│  │ pair.tsx             │     │       │  │  ─ load|create|rotate    │  │
│  │  ─ rejects empty     │     │       │  │  ─ fingerprint helper    │  │
│  │    cert_fingerprint  │     │       │  └──────────────────────────┘  │
│  │  ─ TLS-mismatch ─────┼─UX─┐│       │            ▲                   │
│  │    → re-pair modal   │    ││       │            │ IPC                │
│  └──────────────────────┘    ││       │  ┌─────────┴────────────────┐  │
│                              ││       │  │ PairingSection.tsx       │  │
│  ┌──────────────────────┐    ││       │  │  ─ "Rotate TLS cert"     │  │
│  │ useDrainQueue.ts     │    ││       │  │    button (modal +       │  │
│  │  ─ wires removeSynced│    ││       │  │    "all phones must      │  │
│  │  ─ cache size cap    │    ││       │  │    re-pair" warning)     │  │
│  └──────────────────────┘    ││       │  └──────────────────────────┘  │
└──────────────────────────────┘│       └────────────────────────────────┘
                                │
   ┌────────────────────────────┴───┐
   │ TLS pin matches stored         │
   │ cert_fingerprint?              │
   │   ✓ → continue                 │
   │   ✗ → throw "TLS_PIN_MISMATCH" │
   │       → mobile shows re-pair   │
   │         modal + clears pairing │
   └────────────────────────────────┘
```

### Three boundaries change

1. **Desktop cert lifecycle** — new `tls-cert-store.ts` electron-main module. `loadOrCreateTlsCert()` mirrors the existing `loadOrCreateRootKeypair()` pattern from Phase 4 (T8): encrypted file via `safe-storage`, atomic tmp+rename+fsync write, ENOENT-as-create, in-flight Promise cache so concurrent boot+rotate calls share one cert. `rotateTlsCert()` regenerates and overwrites. `pair-server.ts` consumes the store instead of generating in-place on each boot.
2. **Mobile TLS layer** — replace plain `fetch(url, init)` in `ip-client.ts` with a thin `pinned-fetch.ts` adapter that delegates to a new **custom Expo native module** `expo-tls-pin`. The module wraps `URLSession` (iOS) and `OkHttpClient` (Android) with a TLS-verifier delegate that compares SHA-256 of the presented cert DER against the runtime-passed fingerprint. The adapter isolates the module so the TLS implementation can evolve independently of caller code.
3. **Renderer UI** — `PairingSection` gains a "Rotate TLS cert" button under "Paired devices" with a confirmation modal warning "all currently paired phones will need to re-scan a new QR after rotation". No new pages; reuses the existing error-state surface.

### What does NOT change

- FiberConnect URI shape (`fiberconnect://<base64url(json)>` with `{rpc_url, auth_token, cert_fingerprint?}`) — `cert_fingerprint` stays optional at the protocol level; we just enforce non-empty in our scanner. Interop with fiber-wallet + nervos-companion preserved.
- Biscuit capability vocabulary
- mobile-protocol Zod schemas
- Existing IPC handlers (we add one new `pair:rotateCert` alongside the existing `pair:list/issue/revoke/setCommPubkey/info`)
- Existing renderer settings page layout

## Components

### Desktop side

| Component | Job | Notes |
|---|---|---|
| `apps/desktop/electron/main/tls-cert-store.ts` | **New.** Loads or creates a persisted self-signed cert + key. Exports `loadOrCreateTlsCert(): Promise<{key, cert, fingerprint}>`, `rotateTlsCert(): Promise<{key, cert, fingerprint}>`, `_setTlsCertFileForTests(path)`. | Mirrors `pair-store.ts` exactly: atomic write via tmp+rename+fsync, `safe-storage` encrypt/decrypt, ENOENT-as-create, in-flight Promise cache. Fingerprint format: uppercase hex with `:` separators, matching the existing `sha256Fingerprint` helper in `pair-server.ts`. |
| `apps/desktop/electron/main/pair-server.ts` | **Modified.** `startPairServer` accepts `tlsCert: {key: string, cert: string}` instead of generating internally. Internal cert-gen helper removed (moves to tls-cert-store). Adds `restartWithCert({key, cert}): Promise<{port: number, certFingerprint: string, certPem: string}>` that stops the existing listener then re-listens with new TLS options. | Cert generation logic moves out; pair-server becomes pure server. `certPem` + `certFingerprint` still returned in `StartResult` for the test dispatcher pattern. |
| `apps/desktop/electron/main/index.ts` | **Modified.** Boot path calls `loadOrCreateTlsCert()` → passes into `startPairServer`. New IPC handler `pair:rotateCert` calls `rotateTlsCert()` then triggers `restartWithCert()` then updates `serverInfoCache`. | One-line change to the boot wiring plus the new IPC handler near existing `pair:list/issue/revoke`. |
| `apps/desktop/electron/preload/index.ts` | **Modified.** Adds `pair.rotateCert(): Promise<{fingerprint: string, port: number}>` to the `chainpay.pair` namespace. | One method addition. Returns new fingerprint + port so renderer can update cached `pairInfo`. |
| `apps/desktop/src/features/settings/PairingSection.tsx` | **Modified.** Adds "Rotate TLS cert" button below the paired-device list. Click → confirmation modal showing count of currently paired devices → `window.chainpay.pair.rotateCert()` → refresh `pairInfo` via existing `info()` call. Failures route through existing `errorMsg` state. | UI matches the existing Revoke pattern. The modal warning is the key UX call-out. |
| `apps/desktop/src/features/settings/Settings.tsx` | **Modified.** Refresh `pairInfo` after rotate (call `info()` again) so the QR display picks up the new fingerprint without a screen reload. | One state-update call in the new rotate handler. |

### Mobile side

| Component | Job | Notes |
|---|---|---|
| `apps/mobile/lib/transport/pinned-fetch.ts` | **New.** Thin adapter calling into the `expo-tls-pin` native module with our `cert_fingerprint` shape. Exports `pinnedFetch(url, init, fingerprint): Promise<PinnedFetchResult>` where the result is a tagged union: `{ok: true, response: Response}` or `{ok: false, kind: "tls-mismatch" \| "network", detail?: string}`. | ~40 lines TS. The native module returns either a `Response`-compatible object or a tagged error code that the adapter maps. |
| `apps/mobile/modules/expo-tls-pin/` | **New.** Local Expo module (created via `npx create-expo-module --local`). iOS Swift implementation: `URLSessionDelegate.urlSession(_:didReceive:completionHandler:)` computes SHA-256 of `serverTrust`'s leaf cert DER, compares to expected fingerprint, calls `.useCredential` or `.cancelAuthenticationChallenge`. Android Kotlin: `OkHttpClient.Builder.sslSocketFactory(...)` with a custom `X509TrustManager` that does the same SHA-256 + compare. Exposes a single async method `request(url, method, headers, body, fingerprint): {status, headers, body}` to JS. | ~150 LOC Swift + ~150 LOC Kotlin + minimal Podfile/Gradle plumbing auto-generated by the Expo template. No third-party deps. |
| `apps/mobile/lib/transport/ip-client.ts` | **Modified.** `sendInvoiceViaIp`, `healthCheck`, `fetchCommPubkey` all switch from `fetch(...)` to `pinnedFetch(..., pairing.cert_fingerprint)`. Adds `kind: "tls-mismatch"` to `IpSendResult`'s failure variant. | Replace 3 call sites. `IpSendResult` failure union grows by one variant. |
| `apps/mobile/lib/transport/index.ts` | **Modified.** `runDrainOnce` maps `tls-mismatch` to a new `DrainOutcome.kind: "tls-mismatch"`. | Mirrors the existing `unauthorized` handling. |
| `apps/mobile/app/pair.tsx` | **Modified.** Reject scans where `parsed.cert_fingerprint` is empty/undefined with `Alert.alert("Invalid QR", "Pairing QR is missing the TLS certificate fingerprint.")`. The `?? ""` fail-open is removed. Pre-flight `healthCheck` now uses pinned fetch, so a cert mismatch during pair-attempt also surfaces here as "Cannot reach desktop — the certificate doesn't match this pairing code." | The fail-open line goes away. |
| `apps/mobile/lib/useDrainQueue.ts` | **Modified.** New outcome handler for `tls-mismatch` → `usePairingStore.getState().clearPairing()` + `useSyncQueue.getState().markRejected(item.id, "tls-mismatch — re-pair required")` → drain stops cleanly. Also wires `useEffect` calling `useSyncQueue.getState().removeSynced(24 * 3600 * 1000)` on mount + every hour, plus a `Paths.cache` size check before each capture. | Two concerns sit naturally together here. The `Paths.cache` size measurement uses the existing expo-file-system `Directory.size()` accessor. |
| `apps/mobile/app/index.tsx` (Home) | **Modified.** Adjusts the not-paired-branch copy when pairing was auto-cleared: "Desktop identity changed — re-pair to reconnect" rather than the cold-start "No desktop paired." Uses a `wasAutoCleared` flag in pairing store (set when `clearPairing` was called by drain, cleared on next save). | One conditional line + a tiny state field. |

### Shared package

**Unchanged.** FiberConnect URI shape, Biscuit capabilities, mobile-protocol Zod schemas all stay as-is.

### Native deps / Expo config

- **No third-party TLS library.** We own the TLS layer via the new local Expo module `apps/mobile/modules/expo-tls-pin`.
- Module created via `npx create-expo-module --local expo-tls-pin` which auto-generates: iOS Podspec, Android build.gradle, TypeScript stubs, and the platform-specific Swift + Kotlin starter files. Native code is authored by us but bounded (~300 LOC across both platforms).
- The module **requires the Expo dev client** (cannot run in Expo Go since custom native code is involved). This was already true for Phase 4 thanks to `react-native-vision-camera` + `@react-native-ml-kit/text-recognition`, so no new constraint.
- No changes to `apps/mobile/package.json` dependencies — the local module is referenced by path.

## Pairing flow (with pinning)

```
desktop                                              phone
   │                                                    │
   │ (boot)                                             │
   ├── loadOrCreateTlsCert() — first run generates,     │
   │   subsequent runs read from safe-storage           │
   │                                                    │
   │ Settings → Pair mobile → enter label → Generate QR │
   ├── issue Biscuit token (existing flow)              │
   ├── build FiberConnect URI with cert_fingerprint =   │
   │   sha256(persistedCertDer)                         │
   └── render QR + copy-link                            │
                                                        │
                                            [user taps "Pair desktop"]
                                                        │
                                            scan QR ──► parseFiberConnectUri()
                                                        │
                                            cert_fingerprint present + non-empty?
                                              ✗ → Alert("Invalid QR — missing cert fingerprint")
                                              ✓ → pinnedFetch(/health, fingerprint)
                                                  ├── pin matches ──► pinnedFetch(/comm-pubkey, fingerprint)
                                                  │                  ├── ✓ → savePairing(all 4 fields)
                                                  │                  └── ✗ → Alert("Cannot reach desktop")
                                                  └── pin mismatch ──► Alert("Cannot reach desktop —
                                                                              cert doesn't match")
```

### What this changes vs v1.0

- **Mandatory fingerprint at scan time** — `pair.tsx` rejects QRs without `cert_fingerprint`. Replaces the silent fail-open. FiberConnect protocol unchanged; we just enforce stricter on our side.
- **`healthCheck` is now a TLS probe AND a health probe** — pinning layer rejects the handshake before `/health` ever responds if cert doesn't match.
- **`/comm-pubkey` fetch is now trustable** — pinned channel means the comm pubkey response can't be substituted by a MITM. Closes security review HIGH #2 as a side effect of fixing HIGH #1.
- **Initial `desktop_comm_pubkey: "0x" + "00".repeat(32)` placeholder goes away** — `savePairing` writes the real value in one step since pinned fetch either returns it or the whole pair attempt fails earlier.

### Edge case: QR with empty fingerprint

Can't happen with our own desktop (`tls-cert-store.ts` always returns a fingerprint). A malformed/legacy QR from a different surface would hard-fail at our scanner. Correct behavior — we have no way to verify TLS without a fingerprint.

## Rotation flow

```
desktop                                              phone(s)
   │ Settings → Pair mobile → [Rotate TLS cert]        │
   │ ┌───────────────────────────────────────────┐    │
   │ │ Modal: "Rotate TLS cert? All currently    │    │
   │ │  paired phones (N) will stop working      │    │
   │ │  until they re-scan a new QR."            │    │
   │ │  [Cancel]  [Rotate]                        │    │
   │ └───────────────────────────────────────────┘    │
   │                                                    │
   │ user taps [Rotate]                                 │
   ├── window.chainpay.pair.rotateCert() [IPC]          │
   ├── rotateTlsCert() — gen + safe-storage write       │
   ├── restartWithCert({key, cert})                     │
   │   - stopPairServer() (graceful close, drains       │
   │     in-flight, unpublishes mDNS)                   │
   │   - startPairServer(same args + new tlsCert)       │
   │   - update serverInfoCache{certFingerprint, port}  │
   ├── return new {fingerprint, port} to renderer       │
   ├── PairingSection refreshes pairInfo                │
   │   QR display now shows new fingerprint             │
   │                                                    │
   │ paired phones still try to connect ────────────────┘
                                                        │
                                            pinnedFetch /health
                                            ├── TLS pin mismatch
                                            └── pinnedFetch throws TlsPinMismatchError
                                                        │
                                                        ▼
                                            useDrainQueue catches
                                            outcome.kind === "tls-mismatch"
                                                        │
                                                        ▼
                                            queue.markRejected(item,
                                              "tls-mismatch — re-pair required")
                                            usePairingStore.clearPairing()
                                                        │
                                                        ▼
                                            Home screen shows
                                            "Desktop identity changed —
                                             re-pair to reconnect"
```

### Key behaviors

- **One IPC round-trip per rotation** — `pair:rotateCert` does cert-gen + safe-storage write + server hot-swap + cache refresh.
- **Paired-devices list NOT cleared** — Biscuit tokens are still cryptographically valid; only the TLS connection is broken. If user wants a clean slate they Revoke + Rotate separately.
- **Server downtime during rotation** ≈ 200–500ms (one `server.close()` + `listen()` cycle). In-flight requests get a graceful close; phone's drain loop retries per existing backoff.
- **Port stability** — `startPairServer` called with same `port` arg (default 8233). If OS holds port in TIME_WAIT, `listen()` will retry; if it can't bind, rotation rolls back (cert IS on disk but server is dead — user can quit + restart desktop to recover).
- **Settings refresh** — `pairInfo` cache re-fetched via `window.chainpay.pair.info()` after rotate so QR re-renders with new fingerprint without screen reload.
- **No notification to paired phones** — they discover at next sync attempt. The re-pair banner is the discovery mechanism.

### Edge: rotation fails mid-flight

- `rotateTlsCert()` fails (disk error): nothing changes, error surfaced to renderer, button re-enables.
- `restartWithCert()` succeeds on close but fails on listen: cert IS rotated on disk, server is down. Renderer shows error toast; next desktop restart picks up new cert. Acceptable failure mode for v1.1.

## Error handling

### Mobile error states

| Layer | Failure | UX | Recovery |
|---|---|---|---|
| Scan | QR missing/empty `cert_fingerprint` | Alert: "Invalid QR — pairing code missing TLS certificate fingerprint." Stay on scan. | Re-scan valid QR |
| Scan | Malformed FiberConnect URI | Alert: "Invalid QR — could not parse." | Re-scan |
| TLS handshake | Pin mismatch during pair (rare — old QR after rotation) | Alert: "Cannot reach desktop — certificate doesn't match this pairing code. Generate a new QR on desktop." Stay on scan. | Generate fresh QR + re-scan |
| TLS handshake | Pin mismatch during drain (common after rotation) | Pairing auto-cleared, queue items marked `rejected` with reason `"tls-mismatch — re-pair required"`. Home shows persistent banner: "Desktop identity changed — re-pair to reconnect." | Tap banner → pair screen |
| TLS handshake | Network error (unreachable, Wi-Fi off) | Existing `network` outcome — items stay `pending`, backoff retry | Automatic |
| HTTP | 401 / token revoked / expired | Existing `unauthorized` outcome — items marked `rejected` with `"unauthorized - re-pair required"`. Same banner UX as TLS mismatch. | Re-pair |
| HTTP | 4xx malformed | Existing `client` outcome — `rejected` with detail | User-initiated retry or re-capture |
| HTTP | 5xx / timeout | Existing `server`/`network` outcome — backoff retry | Automatic |

### Distinguishing TLS mismatch from network error

The pinning library throws different error shapes for "cert doesn't match" vs "can't connect at all". `pinned-fetch.ts` catches both and returns:

```ts
type PinnedFetchResult =
  | { ok: true; response: Response }
  | { ok: false; kind: "tls-mismatch" }
  | { ok: false; kind: "network"; detail: string };
```

`ip-client.ts` maps these into `IpSendResult`. `runDrainOnce` maps further into `DrainOutcome`. The chain stays uniform.

### Auto-clear-on-mismatch rationale

Two alternatives considered:

1. **Keep pairing, mark queue items as failed, show persistent banner** — user retains visibility of the old paired-state but it's dead. Confusing.
2. **Clear pairing immediately on first mismatch** — pragmatic. The pairing record IS now stale; pretending it isn't helps no one. Re-pair is the only valid action.

We picked (2). The drain loop's first TLS-mismatch on any item triggers `clearPairing()`; Home re-renders the not-paired branch with the adjusted copy.

### Queue items after auto-clear

- **Only the item currently being drained** (status `syncing`) when the mismatch fires gets `markRejected(id, "tls-mismatch — re-pair required")` — the one that hit it.
- All other `pending` items stay `pending`. The drain loop's next `tick()` checks `pairing` first and returns early because `clearPairing()` already nulled it. Pending items wait.
- After re-pair: the drain loop resumes naturally. Pending items get drained against the new pairing record. The one rejected item stays rejected for idempotency clarity (user already saw it fail); they can manually re-queue from review (existing affordance).
- Matches the existing `unauthorized` handling — same code path.

### Desktop error states

| Failure | Response | Log level |
|---|---|---|
| `tls-cert-store` read fails (corrupt file) | Throw at boot; main process logs error and falls back to in-memory cert (app stays usable) + surfaces toast via existing `pair-server` boot-error catch | error |
| `rotateTlsCert` write fails (disk full) | IPC handler rejects; renderer shows error in existing `errorMsg` state | warn |
| `restartWithCert` fails to re-bind port | Cert IS rotated on disk; server dead. IPC handler returns `{ok: false, reason: "server unavailable — restart desktop"}`. Renderer surfaces this. | error |
| Selfsigned package throws during gen | Boot fails loudly; same surface as existing safe-storage errors | error |

### Existing protections kept

- Cert fingerprint stored in `safe-storage` (encrypted at rest, OS-keychain via Electron's `safeStorage`)
- Mobile-side `cert_fingerprint` in `expo-secure-store` (Keychain on iOS, EncryptedSharedPreferences on Android)
- Biscuit revocation still authoritative for "this device's token is dead" — orthogonal to TLS lifecycle

### Threat coverage delta

| Threat | v1.0 status | v1.1 status |
|---|---|---|
| MITM on Wi-Fi during routine sync | Open (security review #1) | **Closed by pinning** |
| MITM substituting `/comm-pubkey` response | Open (security review #2) | **Closed by pinning** |
| Stolen QR with empty `cert_fingerprint` | Open (security review #3) | **Closed by scanner enforcement** |
| Desktop cert rotation breaks all pairings silently | Open (UX bug) | **Visible: auto-clear + banner** |
| Stolen phone | Mitigated by biometric + revoke | Unchanged |
| Compromised desktop | Out of scope | Unchanged |

## Testing strategy

Same TDD discipline as Phase 4. Tests precede implementation. 80%+ coverage target on new files.

### Unit tests

**Desktop**

| File | New tests |
|---|---|
| `apps/desktop/electron/main/tls-cert-store.test.ts` (new) | First-call generates + persists; second-call reads from store; rotate replaces; `_setTlsCertFileForTests` + `safe-storage` reset patterns; atomic write survives crash mid-rotate (tmp file invariant); in-flight Promise cache so two concurrent `loadOrCreate` calls share one cert |
| `apps/desktop/electron/main/pair-server.test.ts` (modified) | Existing 8 tests stay; add: `restartWithCert` hot-swaps key+cert with the new fingerprint surfacing in next `/health` response; previous cert PEM cleanup verified |
| `apps/desktop/electron/main/pair-server-rotate.test.ts` (new) | End-to-end-ish in-process: boot → cache TLS dispatcher with cert A → rotate → dispatcher with cert A is rejected → new dispatcher with cert B accepted. Uses two `undici.Agent` instances with different `ca` to prove the swap actually changed the cert on the wire |

**Mobile**

| File | New tests |
|---|---|
| `apps/mobile/lib/transport/pinned-fetch.test.ts` (new) | Local `expo-tls-pin` module mocked at module level (mirrors existing vitest.setup.ts pattern). Tests: happy path returns `{ok: true, response}`; pin-mismatch error code → `{ok: false, kind: "tls-mismatch"}`; network error code → `{ok: false, kind: "network", detail}`; passes fingerprint through to the module's `request` method correctly |
| `apps/mobile/lib/transport/ip-client.test.ts` (modified) | Existing 9 tests stay (adjust mocks from `globalThis.fetch` to the new `pinnedFetch`); add: TLS mismatch propagates as `IpSendResult.kind = "tls-mismatch"` from `sendInvoiceViaIp` + `healthCheck` + `fetchCommPubkey` |
| `apps/mobile/lib/transport/index.test.ts` (modified) | Existing 4 tests stay; add: `tls-mismatch` outcome path in `runDrainOnce` returns `DrainOutcome.kind = "tls-mismatch"` |
| `apps/mobile/stores/pairing.test.ts` (modified) | Existing 6 tests stay; add: `wasAutoCleared` flag set when `clearPairing` is called with reason `"tls-mismatch"`, cleared on next `savePairing` |
| `apps/mobile/stores/sync-queue.test.ts` (modified) | Existing 7 tests stay; add: `removeSynced` returns image refs for cleanup, tested under 24h window |
| `apps/mobile/app/pair.tsx` | Deferred — no unit test per existing pattern; covered by integration + manual smoke |

**Shared**

| File | New tests |
|---|---|
| `packages/shared/src/fiberConnect.test.ts` | No changes — protocol shape unchanged |

### Integration test

`apps/desktop/electron/main/pair-server.e2e.test.ts` (modified) — existing 3-invoice round-trip preserved verbatim; add a second test:

```ts
it("rotates cert + verifies old dispatcher rejected + new dispatcher works", async () => {
  // boot already done in beforeAll
  const oldDispatcher = dispatcher; // ca = certA
  const { fingerprint: newFp, port: newPort } = await rotateTlsCert();
  await restartWithCert(/* internally */);

  // old CA-trusting dispatcher gets rejected
  await expect(
    fetch(`https://127.0.0.1:${newPort}/health`, { /* @ts-expect-error */ dispatcher: oldDispatcher }),
  ).rejects.toThrow(/certificate|tls|self-signed/i);

  // new dispatcher with new CA works
  const newCertPem = await getCurrentCertPemForTests();
  const newDispatcher = new Agent({ connect: { ca: newCertPem } });
  const res = await fetch(`https://127.0.0.1:${newPort}/health`, {
    /* @ts-expect-error */ dispatcher: newDispatcher,
  });
  expect(res.status).toBe(200);
  await newDispatcher.close();
});
```

This is the canonical proof that rotation actually rotates — same value the original e2e provided for the auth flow.

### What's NOT automated

- The actual `expo-tls-pin` native TLS verification on device — vitest runs in jsdom with the module mocked at module level. We're testing the JS wiring, not the native delegate. Native correctness is verified manually via the smoke playbook + a single dedicated "TLS pin enforcement" smoke step (deliberately attempt to connect with a different cert and confirm rejection).
- Physical device pair-then-rotate-then-re-pair flow — added as new section in `docs/phase-4-smoke-playbook.md`.

### Smoke playbook updates

The existing "Known v1.1 Deferrals" section moves to "Resolved in v1.1" with dates; these new sections replace the deferral placeholders.

**Section 5 (revised) — Cert rotation triggered by user**
- [ ] Settings → Pair mobile → Rotate TLS cert → confirm modal
- [ ] Within ~1s: QR display refreshes with a visibly different code; old QR copy-link is invalidated
- [ ] Paired mobile: next sync attempt within 30s triggers TLS-mismatch → auto-clears pairing → Home shows "Desktop identity changed — re-pair to reconnect"
- [ ] Re-scan new QR → pairing restored → captures sync

**Section 5b — Cert rotation triggered by desktop quit/restart**
- [ ] Stop desktop. Inspect that `~/.config/chain-pay/tls-cert.enc` exists.
- [ ] Restart desktop. Mobile: capture an invoice → expect successful sync (cert persisted, same)
- [ ] Delete `~/.config/chain-pay/tls-cert.enc` AND restart → cert regenerated → mobile sees TLS-mismatch → auto-re-pair flow as above

### CI

No CI changes. Mobile e2e on device is not run automatically (Expo dev client launch is too heavy for CI). The undici-dispatcher e2e on desktop continues to be the wire-format authoritative check.

### Coverage target

- 80%+ on new files (`tls-cert-store.ts`, `pinned-fetch.ts`) matches Phase 4 baseline
- Modified files keep their existing coverage; new branches in `ip-client.ts` covered by the new tests above

## File-level inventory

### New files

```
apps/desktop/electron/main/tls-cert-store.ts
apps/desktop/electron/main/tls-cert-store.test.ts
apps/desktop/electron/main/pair-server-rotate.test.ts
apps/mobile/lib/transport/pinned-fetch.ts
apps/mobile/lib/transport/pinned-fetch.test.ts
apps/mobile/modules/expo-tls-pin/                            (whole local Expo module — scaffolded via create-expo-module)
apps/mobile/modules/expo-tls-pin/ios/                        (Swift: URLSessionDelegate-based TLS verifier)
apps/mobile/modules/expo-tls-pin/android/                    (Kotlin: OkHttpClient + X509TrustManager)
apps/mobile/modules/expo-tls-pin/src/                        (TS: request() async export)
apps/mobile/modules/expo-tls-pin/expo-module.config.json
```

### Modified files

```
apps/desktop/electron/main/pair-server.ts                       (consume injected cert, add restartWithCert)
apps/desktop/electron/main/pair-server.test.ts                  (modified to assert hot-swap)
apps/desktop/electron/main/pair-server.e2e.test.ts              (add rotation test)
apps/desktop/electron/main/index.ts                             (load TLS cert at boot, new IPC handler)
apps/desktop/electron/preload/index.ts                          (add pair.rotateCert)
apps/desktop/src/features/settings/PairingSection.tsx           (Rotate button + confirmation modal)
apps/desktop/src/features/settings/PairingSection.test.tsx      (test rotate button behavior)
apps/desktop/src/features/settings/Settings.tsx                 (refresh pairInfo after rotate)
apps/mobile/lib/transport/ip-client.ts                          (switch to pinnedFetch)
apps/mobile/lib/transport/ip-client.test.ts                     (adjust mocks + add tls-mismatch tests)
apps/mobile/lib/transport/index.ts                              (tls-mismatch DrainOutcome)
apps/mobile/lib/transport/index.test.ts                         (add tls-mismatch test)
apps/mobile/app/pair.tsx                                        (reject empty fingerprint)
apps/mobile/lib/useDrainQueue.ts                                (tls-mismatch handler + removeSynced wiring)
apps/mobile/app/index.tsx                                       (adjusted not-paired copy)
apps/mobile/stores/pairing.ts                                   (wasAutoCleared flag)
apps/mobile/stores/pairing.test.ts                              (test the new flag)
apps/mobile/stores/sync-queue.test.ts                           (test removeSynced)
docs/phase-4-smoke-playbook.md                                  (resolve deferrals, add rotation sections + TLS-pin-enforcement section)
```

## Open questions deferred to v1.2

- **Auto-rotation near expiry** — selfsigned defaults to 365 days. v1.2 should detect and auto-renew with the same SPKI so phones don't need to re-pair annually.
- **SPKI / public-key pinning** instead of cert fingerprint — survives cert renewal without re-pair (paired naturally with auto-rotation above).
- **Push channel to paired phones** notifying them of rotation before they discover it via failed sync.
- **Cert chain support** — if ChainPay ever runs behind a CA-issued cert (Let's Encrypt via Tailscale Funnel, etc.), pinning shape needs adjustment.

## Spec self-review notes

- **Placeholder scan:** clean. The `expo-tls-pin` module's exact JS-to-native bridge signature (e.g., promise-returning `request(...)` shape, error-code enum names) will be refined at writing-plans time once the `create-expo-module` template scaffold is in place; current spec describes intent, not the literal API.
- **Internal consistency:** rotation flow + error handling + testing all reference the same `DrainOutcome.kind = "tls-mismatch"` token and `clearPairing` behavior; `tls-cert-store` API surface (`loadOrCreateTlsCert` / `rotateTlsCert`) referenced consistently across desktop sections.
- **Scope check:** four concerns in one v1.1: pinning + cert persistence + rotation UI + the two punch-list rides (mandatory fingerprint, cache purge). Bounded enough for a single implementation plan; each concern touches independent modules.
- **Ambiguity check:** "in-flight Promise cache" pattern referenced in `tls-cert-store` with explicit pointer to the existing T8 pattern; fingerprint format pinned to existing `sha256Fingerprint` helper output; `Paths.cache` size check uses the SDK 56 file-system API (exact accessor name — `Directory.size()` vs a sibling — verified at writing-plans time against the installed package types). Auto-clear behavior tightened: only the currently-draining item is rejected, pending items stay queued for retry after re-pair.
