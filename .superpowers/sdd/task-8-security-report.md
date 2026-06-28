# Task 8 Security Hardening Report

## Fixes Applied

### H1 (HIGH) — launchUrl origin guard
- `apps/desktop/src/lib/signers/joyid-relay/relay-client.ts`: added `get relayOrigin(): string` public getter (line 28–30)
- `apps/desktop/src/lib/signers/joyid-relay-ckb-tx-signer.ts`: moved `createTxSession` inside the `try/finally` block; added guard `if (!launchUrl.startsWith(this.client.relayOrigin + "/"))` (lines 62–64). `finally { dismiss() }` now always runs, including on origin mismatch.

### M2 (MEDIUM) — DER s-tag validation
- `apps/desktop/src/lib/signers/joyid-relay/witness.ts`: added `if (bytes[rEnd] !== 0x02)` check after the `rEnd` bounds check, before reading `sLen` (lines 36–38).

### M3 (MEDIUM) — HTTPS enforcement on relay URL
- `apps/desktop/src/lib/signers/joyid-relay/config.ts`: added `if (!url.startsWith("https://"))` guard in `relayBaseUrl()` after the unset check (lines 17–19).

### M4 (MEDIUM) — Zod string field bounds
- `apps/desktop/src/lib/signers/joyid-relay/types.ts`:
  - `AuthResultSchema`: `address .max(256)`, `pubkey .max(256)`, `keyType .max(64)`
  - `SignResultSchema`: `signature .max(8192)`, `message .max(16384)`, `pubkey .max(256)`, `keyType .max(64)`

### L5 (LOW) — session id format validation
- `apps/desktop/src/lib/signers/joyid-relay/relay-client.ts`: added `if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.id))` guard in `createSession()` after parsing response body (lines 34–36).

## New Tests Added (4 tests)

| File | Test | Guards |
|------|------|--------|
| `relay-client.test.ts` | `createSession rejects when relay returns an id with illegal chars` | L5 |
| `witness.test.ts` | `throws when the s component tag byte is not 0x02` | M2 |
| `joyid-relay-ckb-tx-signer.test.ts` | `signTransaction rejects and calls dismiss when launchUrl is outside relay origin` | H1 |
| `joyid-relay-ckb-tx-signer.test.ts` | `fakeClient` updated: `relayOrigin: "https://relay.test"`, launchUrl uses same origin for happy paths | H1 (guard compat) |

## Full Suite Result

```
Test Files  94 passed (94)
      Tests  688 passed | 4 skipped (692)
```

Typecheck: clean (`tsc --noEmit` exits 0).

## Deferred (not implemented)

**M1 (challenge verification):** Verifying that the phone's returned `clientDataJSON.challenge` matches the locally-computed challenge requires a live relay + passkey round-trip to observe the exact base64url encoding JoyID uses. Implementing a strict check without this data risks rejecting every valid real signature. Deferred to the manual testnet smoke task.

**L2 (preview threading):** Populating the `SignPreview` passed to `createTxSession` with real amounts/fee requires threading the built unsigned tx's output values through to the signer. Deferred — the relay still shows the JoyID sign URL itself; the amount preview on the phone is a UX improvement, not a security gate.
