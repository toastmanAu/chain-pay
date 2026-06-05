# Phase 4.1 iOS prep — expo-tls-pin parity audit + Swift review

**Status:** static analysis only (no Mac / no Apple Dev account on this machine).
**Date:** 2026-06-05
**Scope:** `apps/mobile/modules/expo-tls-pin` — Swift iOS half vs Kotlin Android half.
**Goal:** find iOS-only bugs before a borrowed-iPhone smoke, not during it.

## Module shape recap

JS contract (`src/ExpoTlsPinModule.ts`):

```ts
ExpoTlsPin.request({ url, method, headers, body, fingerprint })
  → { ok: true, status, headers, body }
  | { ok: false, kind: "tls-mismatch" | "network", detail }
```

- iOS: `URLSession(configuration: .ephemeral, delegate: PinningDelegate, ...)`,
  cert pinning in `urlSession(_:didReceive:completionHandler:)` via SHA-256
  of `SecCertificateCopyData(leaf)`.
- Android: `OkHttpClient` with custom `X509TrustManager` whose
  `checkServerTrusted` SHA-256s `leaf.encoded` and throws
  `CertificateException` on mismatch; hostname verifier always returns `true`.

Both intentionally bypass the system trust store + CA chain validation —
desktop cert is self-signed, fingerprint is the identity.

## Findings

### CRITICAL — none

### HIGH

#### H1. iOS URLSession is never invalidated → delegate + session leak per request

`ios/ExpoTlsPinModule.swift:29`

```swift
let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
```

URLSession **retains the delegate strongly** until you call
`invalidateAndCancel()` or `finishTasksAndInvalidate()`. The current code
creates a fresh session per call and never tears it down. Every
`pinnedFetch` leaks one session + one delegate.

Apple's docs are explicit:
> The session object keeps a strong reference to the delegate until your
> app exits or explicitly invalidates the session.

For ChainPay this matters during invoice sync where the desktop pulls in
a burst of pinned requests, and across a long-lived mobile session.

**Fix** — capture the session in the completion handler closure and
invalidate after responding:

```swift
let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
let task = session.dataTask(with: request) { data, response, error in
  defer { session.finishTasksAndInvalidate() }   // <-- add this
  // ... existing body
}
task.resume()
```

`finishTasksAndInvalidate()` lets the current task complete then drops
the delegate; `invalidateAndCancel()` would cancel mid-flight.

#### H2. Android default timeouts are 10 s, iOS defaults are 60 s → iOS will silently succeed where Android fails

OkHttp default: 10 s connect / 10 s read / 10 s write.
URLSession `.ephemeral` default: 60 s request, 60 s resource.

A slow LAN, a large image upload, or a sleeping desktop will fail with
`kind: "network"` on Android but succeed on iOS. That means **the iOS
smoke could pass on a request the real Android user can't complete**,
and the iOS smoke will fail to surface the same class of bug the
Android smoke caught.

**Fix** — explicit matching timeouts on both:

```swift
// iOS
let config = URLSessionConfiguration.ephemeral
config.timeoutIntervalForRequest = 30   // pick a value, document it
config.timeoutIntervalForResource = 30
let session = URLSession(configuration: config, ...)
```

```kotlin
// Android
val client = OkHttpClient.Builder()
  .connectTimeout(Duration.ofSeconds(30))
  .readTimeout(Duration.ofSeconds(30))
  .writeTimeout(Duration.ofSeconds(30))
  ...
```

30 s is a reasonable starting point for LAN; pair-server isn't doing
anything expensive. Whatever value, **make it the same on both
platforms** so smoke results are comparable.

### MEDIUM

#### M1. Android force-overrides body Content-Type to `application/json`

`android/.../ExpoTlsPinModule.kt:44`

```kotlin
val requestBody = body?.toRequestBody("application/json".toMediaTypeOrNull())
```

If the caller passes `headers: { "Content-Type": "text/plain" }`, OkHttp
will append a *second* Content-Type header from the body MediaType. The
server picks one — likely the first, but undefined behaviour. iOS
respects whatever Content-Type the caller set.

For Phase 4 today this is fine — every pair-server endpoint takes JSON.
The trap surfaces when Phase 5 adds multipart image uploads or
form-encoded auth.

**Fix** — derive MediaType from headers, fall back to JSON:

```kotlin
val mediaType = headers["Content-Type"]?.toMediaTypeOrNull()
  ?: "application/json".toMediaTypeOrNull()
val requestBody = body?.toRequestBody(mediaType)
```

Mirror the iOS behaviour — caller is the source of truth.

#### M2. Android POST/PUT crashes when `body == null` instead of sending empty body

`android/.../ExpoTlsPinModule.kt:47-48`

```kotlin
"POST" -> reqBuilder.post(requestBody!!)
"PUT"  -> reqBuilder.put(requestBody!!)
```

`requestBody` is computed from `body?.toRequestBody(...)`; if `body` is
null, `requestBody` is null and `!!` throws NPE → caught → returned as
`kind: "network"`. iOS sends a body-less POST without complaint.

Asymmetric: a JS bug that omits `body` on a POST surfaces clean on iOS,
crashes on Android.

**Fix** — explicit empty-body fallback:

```kotlin
val effectiveBody = requestBody ?: ByteArray(0).toRequestBody(null, 0, 0)
"POST" -> reqBuilder.post(effectiveBody)
"PUT"  -> reqBuilder.put(effectiveBody)
```

#### M3. Android map-based response headers lose duplicates (Set-Cookie, Link, etc.)

`android/.../ExpoTlsPinModule.kt:56-57`

```kotlin
response.headers.forEach { respHeaders[it.first] = it.second }
```

`respHeaders` is `Map<String, String>`. Two `Set-Cookie` headers
collapse to last-write-wins. iOS' `http.allHeaderFields` does the
RFC-7230 comma-join.

Pair-server isn't setting cookies today, but the JS contract types
headers as `Record<string, string>` for both platforms — so even iOS
loses the multi-value semantic at the JS boundary. The bug is real but
the fix needs to be in the JS contract, not just the natives.

**Defer** — change `PinnedRequestResult.headers` to
`Record<string, string | string[]>` if/when we need it. For Phase 4, no
action.

#### M4. iOS doesn't document the deliberate hostname-bypass

Android has the explicit comment:

```kotlin
.hostnameVerifier { _, _ -> true } // We pin by cert hash; CN/SAN check is separate.
```

iOS achieves the same effect implicitly by supplying
`URLCredential(trust: serverTrust)` — but a reviewer reading the Swift
won't know that's intentional vs an oversight.

**Fix** — comment the Swift to match:

```swift
// We pin by cert hash. SAN/CN check is bypassed because the desktop
// cert is generated per-user with arbitrary CN; the SHA-256 fingerprint
// in the pair QR is the identity.
completionHandler(.useCredential, URLCredential(trust: serverTrust))
```

### LOW

#### L1. `PinningDelegate.didMismatch` is `var`, mutated on delegate queue, read on task queue

Swift's strict-concurrency mode (Swift 6) will warn. In practice the
write happens-before the read in URLSession's contract, so it's not a
real race today. If `swift-concurrency` strict mode is ever enabled in
the build, this becomes a compile error.

**Defer** — re-evaluate if the build adopts Swift 6 strict concurrency.

#### L2. Fingerprint compare is variable-time

Both platforms use `String ==`. SHA-256 fingerprints aren't secret
(they ship in the pair QR and persist on both sides), so timing attacks
reveal nothing.

**No action.**

#### L3. iOS body assumes UTF-8 text; binary responses become empty string

`ios/.../ExpoTlsPinModule.swift:52`

```swift
String(data: data, encoding: .utf8) ?? ""
```

Android's `response.body?.string()` does the same but with charset
detection. Pair-server is JSON-only — fine for now.

**No action.**

## Swift URLSessionDelegate contract — separate review

Checked against Apple's `URLSession` auth-challenge protocol:

| Check                                                | Status |
|------------------------------------------------------|--------|
| `completionHandler` is *always* called               | ✅ both branches call it |
| `completionHandler` is called *exactly once*         | ✅ no path can double-call |
| Correct `AuthChallengeDisposition` on match          | ✅ `.useCredential` + `URLCredential(trust:)` |
| Correct disposition on mismatch                      | ✅ `.cancelAuthenticationChallenge` |
| Correct disposition on irrelevant challenge          | ✅ `.cancelAuthenticationChallenge` for non-server-trust |
| `SecTrustCopyCertificateChain` available on min iOS  | ✅ podspec sets `ios: '16.4'`, API is iOS 15+ |
| `SecTrustEvaluateWithError` intentionally skipped    | ✅ desired — system shouldn't reject expired self-signed |
| Session retains delegate → must invalidate           | ❌ see H1 |
| Per-task vs session-level delegate method            | ✅ session-level is correct for server trust |
| Empty cert chain handled                             | ✅ guard let falls through to cancel |
| Thread-safety of mismatch flag                       | ⚠ L1 — fine in practice, flagged for Swift 6 |

No CRITICAL contract violations. H1 (session not invalidated) is the
one structural Apple-docs warning.

## Cross-platform parity matrix

| Property                          | iOS                    | Android                | Verdict     |
|-----------------------------------|------------------------|------------------------|-------------|
| Fingerprint hash algorithm        | SHA-256                | SHA-256                | ✅ match    |
| Fingerprint format normalisation  | strip `:`, uppercase   | strip `:`, uppercase   | ✅ match    |
| Hostname verification             | bypassed (implicit)    | bypassed (explicit)    | ✅ match    |
| CA chain validation               | bypassed               | bypassed               | ✅ match    |
| Mismatch error kind to JS         | `tls-mismatch`         | `tls-mismatch`         | ✅ match    |
| Default request timeout           | **60 s**               | **10 s**               | ❌ H2       |
| Body content-type override        | caller-set             | hardcoded JSON         | ❌ M1       |
| Body-less POST/PUT                | succeeds               | NPE → `network`        | ❌ M2       |
| Response duplicate headers        | comma-joined           | last-wins              | ❌ M3       |
| Session lifecycle                 | **leaks**              | OkHttp pools           | ❌ H1       |

## iOS smoke playbook deltas vs Android

Things the Android smoke (commit `86091fb`) caught that the iOS smoke
should *retest* because the fix landed on the JS layer and applies
identically:

1. **ULID PRNG fallback** — Hermes has no global
   `crypto.getRandomValues` on iOS either. Confirm queue-ID generation
   works on cold start.
2. **`Buffer.subarray(...).toString("base64")` corruption** — same
   polyfill on iOS, same trap. Capture → review → sync round-trip
   should produce non-CSV-decimal payloads; pair-server should accept
   the upload without zod errors.
3. **SDK 56 edge-to-edge SafeArea** — iOS analog is the home-indicator
   inset rather than the gesture-nav bar, but the same pattern (root
   `<SafeAreaProvider>`, per-screen
   `<SafeAreaView edges={['top','bottom']}>`) applies. Visually verify
   Home, Settings, Pair, Capture, Review on a notched iPhone.

Things the iOS smoke is *likely* to surface fresh:

- **H1 session leak** — won't manifest as a user-visible bug in a
  short smoke; only an `Instruments` profile or sustained sync would
  show the leak. Document as a fix-before-v1.0 punch list item.
- **H2 timeout divergence** — iOS will pass a 15-second request that
  Android fails. If smoke includes "kill desktop mid-sync" or similar
  network-stress steps, iOS error UX may differ.
- **iOS Hermes quirks** — RN 0.85 + Hermes on iOS occasionally diverges
  from Android on `Promise.allSettled`, `Intl.NumberFormat`, regex
  unicode flags. Worth a spot-check on FX formatting if it lives in
  mobile (it doesn't today).
- **iOS keyboard avoidance** — manual capture form uses
  `<TextInput>` heavily; iOS' keyboard behaviour differs from Android's
  IME (`KeyboardAvoidingView` `behavior="padding"` on iOS,
  `behavior="height"` on Android).

## Recommended order of fixes

1. **H2 timeouts** — single PR, both files, 4 lines each, prevents the
   "iOS smoke green / Android smoke red" trap.
2. **H1 iOS session invalidation** — single Swift line, prevents the
   leak class.
3. **M2 Android body-less POST** — fix-forward before any new endpoint
   relies on it.
4. **M1 Android Content-Type** — defer until Phase 5 or a non-JSON
   endpoint shows up.
5. **M4 Swift hostname-bypass comment** — drive-by during H1/H2 PR.

H1, H2, M2, M4 are all ~5-line changes. One PR titled
`fix(mobile): expo-tls-pin parity + iOS session lifecycle` covers them
cleanly.

## Caveats

This is static analysis only. No iOS simulator, no real device, no
build verification. The fixes above should pass code review and ship,
but the actual smoke (when a Mac/iPhone are available) is still the
final gate. None of these findings invalidate the Android smoke result
on `86091fb`.
