# Phase 2.7b-3 — Signer Side + Polish Design

**Status:** Design, awaiting plan. Brainstormed 2026-05-24.
**Owner:** Phill.
**Stacked on:** Phase 2.7b-2 (PR #3, branch `feat/phase-2-7b-2-comm-operator-ui`). Starts from 2.7b-2's tip, which sits on top of merged 2.7a + 2.7b-1.
**Relates to:** 2.7a (transport), 2.7b-1 (ceremony), 2.7b-2 (operator UI + auto-match). 2.7b-3 closes the comm-channel epic: signer-side inbox, ack feedback loop, sender retry/backoff, `expiresAt` enforcement, and clipboard demotion. After this PR the comm channel is the default; clipboard is a debug fallback.

## What 2.7b-3 ships

The other half of the comm-channel — what the signer sees, the feedback loop that tells the operator their packet landed, and the polish needed to make comm feel like the default rather than an alternative to clipboard.

- An operator can build a payroll batch, click Send, walk away. The signer's app **receives, auto-acks** (operator's pill flips `sent → acked`), the signer **claims in the inbox**, reviews, signs, broadcasts. Operator's `partialSigs` auto-populate (already 2.7b-2). The batch transitions to `approved`. Clipboard never gets touched.
- If the signer is offline when the operator sends, the operator's app **rebroadcasts at 5min / 10min / 20min** intervals before giving up (manual Retry button still works at any time).
- Packets with expired `expiresAt` are **dropped silently at watcher level** — they never reach the inbox and no ack is emitted, so the operator's pill stays at `sent` (the right signal that the deadline lapsed).
- Once a comm identity + published profile exist, the **clipboard bottom-bar is hidden**. Re-enable via Settings → Debug → "Show clipboard bar".

## What 2.7b-3 explicitly does NOT ship

- Auto-broadcast at M sigs (operator still clicks Broadcast manually — deferred to 2.7c+)
- Group ack consensus (collect M acks before broadcast)
- Per-peer rate limiting on incoming
- Cell consumption / reclaim of stale notification cells
- Address rotation per session (HKDF chain)
- Forward secrecy / double ratchet
- Mainnet readiness (main-process testnet-only via env var stays)
- Notification-system integration for auto-state-transition (silent transition stays silent for now)

## Why this shape

Five decisions locked during brainstorming:

1. **Single PR** — all 7 backlog items ship together. The items are interdependent enough (e.g., ack-receiver without ack-emitter is dead code) that splitting creates awkward stub states.
2. **Claim auto-loads the existing paste flow** — clicking Sign in the inbox populates the same SignPanel state vars (treasury, packetJson, skeleton, sigs[]) the paste textarea does. Minimal UI churn; reuses the validated 2.5 sign flow; dismiss is local-only.
3. **Auto-ack on receive, no UI gate** — watcher decrypts → enqueue → `transport.sendAck` immediately. Operator's pill flips to `acked` as soon as the signer's machine has the packet, distinguishing "delivery failed" from "signer hasn't responded yet". Side-effect: leaks signer-online presence to the operator (acceptable for 2-of-2 payroll; can be gated later if privacy becomes a concern).
4. **Retry on missing ack, exponential backoff** — operator's app re-broadcasts the same packet at `5m → 10m → 20m`, then stops. Each retry costs ~77 CKB of cell capacity but solves the "signer was offline" case automatically. Receiver dedups (incoming-packets keyed by sighashDigest).
5. **Expired packets dropped silently** — operator's deadline is operator's intent. Surfacing expired packets to the signer would expand the security surface (signer could ratify a stale operator decision).

Plus one polish decision:

6. **Clipboard demotes when comm identity + published profile exist** — symmetric for operator + signer. The moment you've completed the comm ceremony you've signalled intent. Re-enable via debug toggle.

## Architecture & file layout

```
chain-pay/
├── apps/desktop/
│   ├── src/
│   │   ├── stores/
│   │   │   ├── incoming-packets.ts          # NEW. Buffers decrypted packets by sighashDigest.
│   │   │   ├── incoming-packets.test.ts     # NEW. ~7 tests.
│   │   │   ├── debug-settings.ts            # NEW. { showClipboard: boolean } toggle, persisted.
│   │   │   ├── debug-settings.test.ts       # NEW. ~3 tests.
│   │   │   └── peer-book.ts                 # MODIFIED. Add addrHash field + findByAddrHash selector + v1→v2 migration.
│   │   │
│   │   ├── lib/comm/
│   │   │   ├── types.ts                     # MODIFIED. OutgoingAck + IncomingAckHandler + CommTransport.{onIncomingAck, sendAck}.
│   │   │   ├── expires-at.ts                # NEW. isExpired(expiresAt: number, now?: number).
│   │   │   ├── expires-at.test.ts           # NEW. ~3 tests.
│   │   │   ├── errors.ts                    # MODIFIED. + AckEmissionError + RetryScheduleError.
│   │   │   └── cemp-pq/
│   │   │       ├── watcher.ts               # MODIFIED. Dispatch kind=ack; drop expired packets; auto-ack on packet receive.
│   │   │       ├── watcher.test.ts          # MODIFIED. +4 tests.
│   │   │       └── transport.ts             # MODIFIED. Implement onIncomingAck + sendAck (mirror sendSignature).
│   │   │
│   │   ├── App.tsx                          # MODIFIED. Wire onIncomingAck → recordCommSendStatus("acked"); mount useCommSendRetry boot effect.
│   │   │
│   │   ├── features/
│   │   │   ├── sign/
│   │   │   │   ├── SignPanel.tsx            # MODIFIED. Mount <SignInbox /> above paste textarea; accept claimedPacket → state.
│   │   │   │   ├── SignInbox.tsx            # NEW. Inbox list container.
│   │   │   │   ├── SignInbox.test.tsx       # NEW. ~6 tests.
│   │   │   │   └── sign-inbox-rows/
│   │   │   │       └── InboxRow.tsx         # NEW. Single packet row (nickname, label, expiry, Sign / Dismiss).
│   │   │   │
│   │   │   ├── payments/
│   │   │   │   ├── useCommSendRetry.ts      # NEW. App-level scheduler. Persisted retryCount; rehydrates on boot.
│   │   │   │   └── useCommSendRetry.test.ts # NEW. ~6 tests (fake timers).
│   │   │   │
│   │   │   └── settings/
│   │   │       └── Settings.tsx             # MODIFIED. Add Debug section with "Show clipboard bar" toggle.
│   │   │
│   │   └── components/clipboard/
│   │       └── ClipboardBar.tsx             # MODIFIED. Render gate: commActive && !debugSettings.showClipboard → null.
│   │
│   └── electron/main/
│       └── comm-transport-service.ts        # MODIFIED. Add sendAck (mirror sendSignature); watcher dispatches kind=ack.
│
└── packages/shared/src/payroll.ts           # MODIFIED. CommSendSlotStatus.retryCount?: number.
```

**~10 new + ~7 modified files.** Each new file <300 lines.

## Components & interfaces

### `packages/shared/src/payroll.ts` change

```ts
export interface CommSendSlotStatus {
  status: "idle" | "sending" | "sent" | "acked" | "error";
  txHash?: string;
  error?: string;
  updatedAt: number;
  /** Number of retry attempts completed (0..3). Reset on manual Retry. */
  retryCount?: number;
}
```

Additive; existing readers unaffected.

### `apps/desktop/src/lib/comm/types.ts` change

```ts
export interface OutgoingAck {
  /** Matches OutgoingPacket.txHash / batch.sighashDigest. */
  txHash: string;
}

export interface IncomingAckHandler {
  (from: string, body: OutgoingAck): void;
}

export interface CommTransport {
  // ... existing ...
  sendAck(peer: PeerProfile, body: OutgoingAck): Promise<string>;
  onIncomingAck(handler: IncomingAckHandler): Unsubscribe;
}
```

Slot is intentionally absent from `OutgoingAck` — the operator resolves it via `peer-book.findByAddrHash(senderAddrHash)` → `peer.associatedSignerHash` → `multisig.pubkeyHashes.indexOf`. Inversion of responsibility that falls out of the peer-book mapping.

### `apps/desktop/src/stores/peer-book.ts` change

```ts
export interface Peer {
  // ... existing ...
  /** 0x-prefixed 20-byte blake160 hash of the peer's address, cached at add time
   *  so onIncomingAck can resolve sender → peer without recomputing. Required
   *  in v2+; v1 records are backfilled on rehydrate via peerHashFromAddress. */
  addrHash: `0x${string}`;
}

interface PeerBookStore {
  // ... existing ...
  findByAddrHash: (addrHash: `0x${string}`) => Peer | undefined;
}
```

Bump persist version to 2. Migration: for each v1 peer, compute `peerHashFromAddress(peer.address)` and stamp `addrHash`. If parse fails, drop the peer (no production users).

### `apps/desktop/src/stores/incoming-packets.ts` (NEW)

```ts
export interface IncomingPacketEntry {
  sighashDigest: string;       // matches OutgoingPacket.txHash
  packet: OutgoingPacket;      // full decrypted body for replay into SignPanel
  senderAddrHash: string;      // for peer lookup + display
  receivedAt: number;          // epoch ms — for sort order
}

interface IncomingPacketsStore {
  bySighash: Record<string, IncomingPacketEntry>;
  enqueue: (entry: IncomingPacketEntry) => void;
  dismiss: (sighashDigest: string) => void;
  /** Drop entries whose packet.expiresAt has passed (called at boot + on demand). */
  pruneExpired: (now?: number) => void;
}
```

Dedup is by `sighashDigest` only — operator can only have one in-flight packet per batch, and re-receives are idempotent. Persisted as `chain-pay:incoming-packets` (Zustand persist).

### `apps/desktop/src/stores/debug-settings.ts` (NEW)

```ts
interface DebugSettingsStore {
  showClipboard: boolean;
  setShowClipboard: (v: boolean) => void;
}
```

Default `showClipboard=false`. Persisted as `chain-pay:debug-settings`.

### `apps/desktop/src/lib/comm/expires-at.ts` (NEW)

```ts
/** True if expiresAt is set and has passed. expiresAt is in epoch seconds. */
export function isExpired(expiresAt: number | undefined, now: number = Date.now()): boolean {
  if (!expiresAt || expiresAt <= 0) return false;
  return now / 1000 > expiresAt;
}
```

`now` is injectable for deterministic tests. Missing or zero `expiresAt` treated as never-expires (defensive — old packets pre-expiresAt field).

### `apps/desktop/src/features/payments/useCommSendRetry.ts` (NEW)

```ts
export interface CommSendRetryApi {
  // Hook returns nothing; all side-effects (timer scheduling) happen via subscriptions.
}

/**
 * App-level retry scheduler. Subscribes to payroll-batches.commSendStatus
 * changes; for each (batchId, slotIndex) entry whose status === "sent" and
 * retryCount < 3, schedules a re-send at the appropriate exponential delay
 * (5min / 10min / 20min from updatedAt). Cancels timers when status leaves
 * "sent". On mount, rehydrates schedules from persisted updatedAt.
 *
 * Mounted ONCE in App.tsx — not per-batch — so retries survive PayPanel unmount.
 */
export function useCommSendRetry(packetForBatch: (batchId: string) => OutgoingPacket | null, multisigForBatch: (batchId: string) => MultisigRouting | null): void;
```

`packetForBatch` + `multisigForBatch` are resolver callbacks the App provides — the hook needs to know the OutgoingPacket and multisig config to retry, and those live across stores (`payroll-batches.txBytes` → re-encode + treasury config). Decoupling via callbacks keeps the hook pure.

Retry algorithm:

```
on commSendStatus change for (batchId, slotIndex):
  cancel any existing timer for this key
  if status !== "sent" → return
  if retryCount >= 3 → return
  nextDelay = RETRY_SCHEDULE[retryCount]   // [5m, 10m, 20m]
  elapsed = Date.now() - updatedAt
  remaining = max(0, nextDelay - elapsed)
  setTimeout(() => fireRetry(batchId, slotIndex, retryCount + 1), remaining)

fireRetry:
  packet = packetForBatch(batchId); multisig = multisigForBatch(batchId)
  if !packet || !multisig → log + return
  // bump retryCount BEFORE the send so a successful send doesn't lose it
  recordCommSendStatus(batchId, slotIndex, "sent", { retryCount: nextCount })
  sendOne(...)  // re-uses useCommSendDispatch's existing single-slot path
```

### `apps/desktop/src/features/sign/SignInbox.tsx` (NEW)

```tsx
interface SignInboxProps {
  onClaim: (entry: IncomingPacketEntry) => void;
}
```

Renders a list of `IncomingPacketEntry`, sorted newest-first. Each row delegates to `<InboxRow />`. Empty state: "No comm packets pending. Operators will appear here once they send."

```
┌─ Inbox ─────────────────────────────────────────┐
│ Alice — May 2026 payroll                        │
│ expires in 23h · received 12m ago               │
│ [Sign]  [Dismiss]                               │
├─────────────────────────────────────────────────┤
│ (older entries…)                                │
└─────────────────────────────────────────────────┘
```

`onClaim(entry)` is the parent's responsibility — SignPanel populates its state from `entry.packet.packet` (the TransferPacket string) and routes through the existing sign flow.

### `apps/desktop/src/features/sign/SignPanel.tsx` modifications

- Mount `<SignInbox />` above the existing paste textarea.
- `handleClaim(entry)`: set the same state vars `handlePaste` sets (treasury, packetJson, decoded packet, sigs[] empty), then remove the entry from incoming-packets.

No new state machine — the existing SignPanel flow handles validation, sig collection, broadcast.

### `apps/desktop/src/components/clipboard/ClipboardBar.tsx` modifications

One render-gate at the top:

```tsx
const identity = useCommIdentityStore((s) => s.identity);
const showClipboard = useDebugSettingsStore((s) => s.showClipboard);
const commActive = identity?.profileTxHash != null;
if (commActive && !showClipboard) return null;
```

## Data flow

### Operator send → ack → retry

```
Operator clicks Send (existing 2.7b-2 path)
   ↓
sendOne writes commSendStatus → "sending" → "sent" (retryCount = 0)
   ↓
useCommSendRetry schedules a 5-min timer keyed (batchId, slotIndex)
   ↓ 5 min later, status still === "sent"?
re-call sendOne; retryCount = 1; reschedule for 10 min
   ↓ still "sent"?
sendOne; retryCount = 2; reschedule for 20 min
   ↓ still "sent"?
sendOne; retryCount = 3; STOP scheduling.
```

Meanwhile, on the signer:

```
watcher.dispatch (kind=packet, body, senderAddrHash)
   ↓
isExpired(body.expiresAt)?  → drop silently, no ack, no inbox entry, return
   ↓ not expired
incoming-packets.enqueue({ sighashDigest: body.txHash, packet: body, senderAddrHash, receivedAt: Date.now() })
   ↓
transport.sendAck(senderProfile, { txHash: body.txHash })  ← auto, no UI gate
   ↓ on sendAck failure: log AckEmissionError; do NOT block the inbox enqueue
```

And the ack landing back on the operator:

```
operator's watcher.dispatch (kind=ack, body, senderAddrHash)
   ↓
App.tsx onIncomingAck handler:
   peer = peer-book.findByAddrHash(senderAddrHash)
   if !peer: log + drop (unexpected sender)
   batch = payroll-batches.findBySighashDigest(body.txHash)
   if !batch: log + drop (late ack for already-broadcast batch)
   treasury = treasury-store.findById(batch.treasuryId)
   slotIndex = treasury.multisig.pubkeyHashes.indexOf(peer.associatedSignerHash)
   if slotIndex < 0: log + drop (peer not in this multisig)
   payroll-batches.recordCommSendStatus(batch.id, slotIndex, "acked")
   ↓
useCommSendRetry sees status leave "sent" → cancels pending timer for this key
```

### Signer claim → sign → broadcast

```
Inbox renders incoming-packets entries (filter: !isExpired)
   ↓
User clicks Sign on a row
   ↓
SignInbox.onClaim(entry) fires
   ↓
SignPanel.handleClaim(entry):
   set treasury from packet.treasuryAddress
   set packetJson from packet.packet (already a TransferPacket string)
   trigger decode + skeleton hydration (same as paste flow)
   incoming-packets.dismiss(entry.sighashDigest)
   ↓
[existing 2.5 / 2.7b-1 sign flow takes over]
   ↓
On successful signature → existing transport.sendSignature path (unchanged)
   ↓
[operator's 2.7b-2 onIncomingSignature → drainIncomingSigsInto completes the loop]
```

### Clipboard demotion

Pure render gate. No state machine, no flow. ClipboardBar reads `useCommIdentityStore.identity` + `useDebugSettingsStore.showClipboard` and short-circuits when comm is active and debug is off.

## Error handling & failure modes

### Failure matrix

| Scenario | Detection | Behavior |
|---|---|---|
| Auto-ack `sendAck` throws | try/catch in watcher dispatch | log `AckEmissionError`; continue; operator's retry covers eventual delivery |
| Retry timer fires while operator app was closed | App.tsx boot effect schedules from persisted `updatedAt` + `retryCount` | resume; if next-delay window already passed, fire immediately |
| Retry exhausts 3 attempts | `retryCount === 3` | stop scheduling; pill stays at "sent" with tooltip "no ack after 3 retries"; manual Retry button resets retryCount to 0 |
| Retry's `sendOne` throws | existing `recordCommSendStatus → "error"` (2.7b-2) | status leaves "sent" → scheduler cancels its timer |
| Ack for unknown sighash | `findBySighashDigest` returns undefined | drop + debug log; common case: late ack for broadcast batch |
| Ack from unknown sender | `findByAddrHash` returns undefined | drop + debug log; harmless (unmappable to slot) |
| Packet with expired `expiresAt` | `isExpired` check in watcher | drop silently; no inbox; no ack |
| Inbox claim on already-complete batch | `onClaim` checks `batch.partialSigs.length >= m` | inbox row removed; toast "already signed by quorum" |
| User dismisses needed packet | local-only | operator's manual retry surfaces a new inbox entry |
| Clipboard demoted but user has paste task | render gate condition | toggle `showClipboard` in Settings → Debug |
| Clock skew between operator and signer | `isExpired` uses wall clock | accept skew up to a few minutes against the 24h default expiry; document |

### New typed errors

```ts
export class AckEmissionError extends CommError {
  constructor(public readonly sighashDigest: string, cause: unknown) {
    super(`failed to emit ack for ${sighashDigest}`, { cause });
  }
}

export class RetryScheduleError extends CommError {
  constructor(
    public readonly batchId: string,
    public readonly slotIndex: number,
    msg: string,
  ) {
    super(`retry scheduler for ${batchId}:${slotIndex}: ${msg}`);
  }
}
```

### Policy decisions

- **Ack failures are not retried.** Operator's packet-retry covers eventual delivery.
- **Retry cap is 3** (≈35 min total window). Beyond that, manual Retry is the right tool; auto-spamming wastes cell capacity (~77 CKB per attempt).
- **No retry on `error` status.** If `sendOne` errored, the user needs to see it — auto-retry might mask a configuration problem (rotated profile, etc.).
- **Operator's clock for `expiresAt`-setting, signer's clock for filtering** — minor skew tolerated against 24h default.
- **No notification on auto-state-transition to `approved`** — silent; revisit when there's a notification system.

### Logging

- `AckEmissionError`: tx hash, sighash, sender addrHash, cause.message
- `RetryScheduleError`: batch id, slot, retry count, reason
- Ack dropped (unknown sighash / sender / slot): debug log with the dropped id; never sig values

## Testing strategy

### Unit tests

| File | New | Focus |
|---|---|---|
| `stores/incoming-packets.test.ts` (NEW) | ~7 | enqueue + dedup by sighashDigest; drain returns + clears; peek non-destructive; dismiss; pruneExpired; persistence; multi-sender |
| `stores/debug-settings.test.ts` (NEW) | ~3 | default `showClipboard=false`; toggle round-trip; persistence |
| `lib/comm/expires-at.test.ts` (NEW) | ~3 | future → not expired; past → expired; missing/0 → never expired |
| `lib/comm/cemp-pq/watcher.test.ts` (MODIFIED) | +4 | dispatches kind=ack via onIncomingAck; drops expired packets silently; emits auto-ack on packet receive; auto-ack failure doesn't block dispatch |
| `lib/comm/cemp-pq/transport.test.ts` (MODIFIED if exists, NEW if not) | ~3 | onIncomingAck wires through; sendAck round-trip; senderAddrHash propagates |
| `features/payments/useCommSendRetry.test.ts` (NEW) | ~6 | fake-timer schedules at 5/10/20min; cancels on status flip out of "sent"; cap at 3; rehydrate from persisted updatedAt + retryCount; manual Retry resets retryCount; no schedule when status === "acked" |
| `features/sign/SignInbox.test.tsx` (NEW) | ~6 | empty state; renders one row per entry; Sign click fires onClaim with the entry; Dismiss removes from store; expired entries filtered out at render; sort newest-first |
| `stores/peer-book.test.ts` (MODIFIED) | +2 | `addrHash` populated on add; v1→v2 migration backfills; findByAddrHash selector |
| `stores/payroll-batches.test.ts` (MODIFIED) | +1 | `recordCommSendStatus(..., "acked", { retryCount })` persists retryCount |

**Target:** ~32 new + ~3 modified. Project total ~305 (from 270).

### Tests deliberately not written

- **End-to-end ack roundtrip across two real apps** — covered by smoke playbook + manual UI verification.
- **ClipboardBar render-gate combinatorics** — one boolean expression; reading the code is the test. One sanity test inside Settings.test (existing) covers toggling Debug → bar reappears.

### Smoke roundtrip — 2.7b-3 additions

Extend `scripts/smoke-comm-roundtrip.mts`:

- Role B (signer-side) — after receiving the packet, the smoke now waits for the auto-ack envelope to land on Role A's lock before sending the signature reply. Confirms `sendAck` wires through end-to-end.
- New env var `SMOKE_SKIP_ACK=1` to skip the ack check for backward compatibility with the 2.7b-2 fixture flow.

### Manual verification checkpoints

- [ ] Operator sends packet → signer's app receives → operator's pill flips to `acked` within ~10s
- [ ] Operator sends → signer offline → 5 min later, operator's app rebroadcasts (visible in transport logs)
- [ ] Operator sends with `expiresAt=now` → signer receives nothing in inbox, no ack
- [ ] Signer claims packet → SignPanel pre-populates with packetJson + treasury → signer signs → operator's `partialSigs` auto-update
- [ ] Signer dismisses packet → operator's pill stays at `acked` (no regression to `sent`)
- [ ] Operator opens Settings → Debug → enables "Show clipboard bar" → bar reappears
- [ ] App restart with a pending `sent` status → retry schedule resumes correctly
- [ ] All three PRs (#1 #2 #3) plus this PR build + test cleanly on a fresh `git clone`

## Out of scope (deferred to 2.7c+ / future)

- Auto-broadcast at M sigs (operator still clicks Broadcast)
- Group ack consensus (collect M acks before broadcast)
- Per-peer rate limiting on incoming
- Cell consumption / reclaim of stale notification cells (upstream CEMP-PQ Receipts dep)
- Address rotation per session (HKDF chain)
- Forward secrecy / double ratchet
- Mainnet readiness (testnet-only via env var stays)
- Notification system for auto-state-transition
- Inbox filtering / search / multi-treasury grouping

### Adjacent — invoice ingestion

Vault-only at `~/Documents/loacal-vault/Projects/ChainPay/Invoice Ingest — Manual Upload Plan.md`. Triggers Phase 3-ish.

### Explicit non-goals for 2.7b-3

- No auto-broadcast at M sigs
- No mainnet
- No notification UI for state transitions
- No new envelope kinds beyond `ack` (already in `CommEnvelopeKind`)

## References

- 2.7a spec: `docs/superpowers/specs/2026-05-23-phase-2-7a-comm-transport-design.md`
- 2.7b-1 spec: `docs/superpowers/specs/2026-05-23-phase-2-7b-1-comm-ceremony-design.md`
- 2.7b-2 spec: `docs/superpowers/specs/2026-05-24-phase-2-7b-2-comm-operator-ui-design.md`
- CEMP-PQ upstream: `~/ecms/cemp-pq/`
- ChainPay hard rules: `~/chain-pay/CLAUDE.md`
- CKB transaction traps: `~/.claude/rules/ckb-transactions.md`
- Phase 2.7 slicing memory: `~/.claude/projects/-home-phill-chain-pay/memory/phase-2-7-slicing.md`
