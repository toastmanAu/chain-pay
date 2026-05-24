# Phase 2.7b-2 — Comm Operator UI Design

**Status:** Design, awaiting plan. Brainstormed 2026-05-24.
**Owner:** Phill.
**Stacked on:** Phase 2.7b-1 (PR #2, branch `feat/phase-2-7b-1-comm-ceremony`). 2.7b-2's branch `feat/phase-2-7b-2-comm-operator-ui` starts from 2.7b-1's tip (which now sits on top of the merged Phase 2.5/2.6 work).
**Relates to:** `docs/superpowers/specs/2026-05-23-phase-2-7a-comm-transport-design.md` (transport), `docs/superpowers/specs/2026-05-23-phase-2-7b-1-comm-ceremony-design.md` (ceremony). 2.7b is split into 2.7b-1 (Settings ceremony + transport fixes — landed), 2.7b-2 (this spec — operator-side comm flow), and 2.7b-3 (signer-side inbox + ack/retry + clipboard demotion — future).

## What 2.7b-2 ships

The operator-side comm flow on top of 2.7b-1's transport. After 2.7b-2 lands:

- An operator can pair peers in Settings, mapping each peer to a specific multisig signer pubkey hash
- PayPanel surfaces a "Send packet to mapped signers via comm" section between "ready-to-sign" and "broadcast", with per-signer status pills
- Signatures that arrive via the comm channel auto-match to the in-flight PayrollBatch by `sighashDigest` and append to `partialSigs[]`
- When the Mth valid signature arrives, the batch state auto-transitions through the existing state machine to `approved` (ready to broadcast)
- The receive path survives the race where signatures arrive before/after the batch is observable in store (incoming-sigs buffer)

The full operator-driven payroll-by-comm flow is end-to-end usable. Signers still use the existing paste-only SignPanel; the comm channel runs in their background but no UI surfaces it yet. That's 2.7b-3.

## What 2.7b-2 explicitly does NOT ship

- SignPanel inbox UI (incoming packets list, claim/dismiss)
- `ack` emission from receivers (signer-side)
- `ack` receiver behavior on operator side beyond a stub (no `acked` status flip)
- Sender retry/backoff (operator clicks Retry manually per slot)
- Clipboard demotion to debug fallback
- Receiver-side `expiresAt` enforcement
- Mainnet support (main-process client stays testnet-only)
- PayrollBatch state machine transition additions (uses existing `draft → calculated → approved → broadcasted`)

Deferred to 2.7b-3 and beyond — see Section 7.

## Why this shape

Three decisions locked during brainstorming:

1. **Scope:** operator-side only. Splits the 6-item 2.7b backlog into 2.7b-2 (operator) and 2.7b-3 (signer + polish). Each independently testable; each ~15-20 tasks like 2.7b-1.
2. **Peer↔signer mapping:** `Peer.associatedSignerHash?: Hex20` field. 1-to-1 (one identity → one signer hash). Each peer in Settings can optionally be tagged with the signer hash they relay for. Add form's signer-hash field is a dropdown of known signers from the live treasury store.
3. **Auto-match architecture:** dedicated `incoming-sigs` store buffers by `sighashDigest`. Boot effect (already in App.tsx from 2.7b-1) subscribes to `transport.onIncomingSignature` and enqueues. PayrollBatch store drains matching entries on every relevant change (and on PayPanel mount for the race recovery).

Auto-state-transition fires silently when M sigs collected; `sourceCommTx` field on `PartialSigEntry` captures audit trail.

## Architecture & file layout

```
chain-pay/
├── apps/desktop/
│   ├── src/
│   │   ├── stores/
│   │   │   ├── peer-book.ts                    # MODIFIED: Peer.associatedSignerHash + actions
│   │   │   ├── peer-book.test.ts               # MODIFIED: +5 tests
│   │   │   ├── incoming-sigs.ts                # NEW. Buffers incoming sigs by sighashDigest.
│   │   │   ├── incoming-sigs.test.ts           # NEW. ~8 tests.
│   │   │   └── payroll-batches.ts              # MODIFIED: drainIncomingSigsInto, recordCommSendStatus
│   │   │
│   │   ├── App.tsx                             # MODIFIED: boot effect adds onIncomingSignature handler
│   │   │
│   │   └── features/
│   │       ├── settings/
│   │       │   ├── Settings.tsx                # MODIFIED: mount <PeerBookSection />
│   │       │   ├── PeerBookSection.tsx         # NEW. CRUD container.
│   │       │   ├── PeerBookSection.test.tsx    # NEW.
│   │       │   └── peer-book-rows/
│   │       │       ├── PeerRow.tsx             # NEW. Single peer display + edit.
│   │       │       └── AddPeerForm.tsx         # NEW. Address + nickname + signer dropdown.
│   │       │
│   │       └── payments/
│   │           ├── PayPanel.tsx                # MODIFIED: mount <CommSendSection /> + drain-on-mount
│   │           ├── CommSendSection.tsx         # NEW. Per-signer send-status pills + send/retry.
│   │           ├── CommSendSection.test.tsx    # NEW.
│   │           └── useCommSendDispatch.ts      # NEW. Hook: sends per signer, tracks state.
│   │
│   └── (unchanged: comm transport, ceremony, identity from 2.7a/2.7b-1)
│
└── packages/shared/src/
    └── payroll.ts                              # MODIFIED: PartialSigEntry.sourceCommTx?: string
```

**~7 new files + ~6 modified.** Each new file <300 lines, container components <200 lines.

## Components & interfaces

### `packages/shared/src/payroll.ts` change

```ts
export interface PartialSigEntry {
  slotIndex: number;
  signature: string;
  signerPubkeyHash: Hex20;
  // ... existing fields ...
  /** If this sig was received via comm channel, the tx hash of the signer's
   *  message-cell broadcast. Empty/undefined for pasted sigs. Audit-only. */
  sourceCommTx?: string;
}
```

Additive only. Pasted-paste flow unchanged.

### `apps/desktop/src/stores/peer-book.ts` change

```ts
export interface Peer {
  nickname: string;
  address: string;
  cachedProfile?: PeerProfile;
  pairedAt: number;
  /** Optional: the multisig signer pubkey hash this peer is the comm-relay for.
   *  When set, PayPanel will route packets to this peer for sigs at that slot. */
  associatedSignerHash?: `0x${string}`;
}

interface PeerBookStore {
  // ... existing actions ...
  setAssociatedSignerHash: (address: string, hash: `0x${string}` | undefined) => void;
  findByAssociatedSignerHash: (hash: `0x${string}`) => Peer | undefined;
}
```

`addPeer` (existing) extended to reject duplicate `associatedSignerHash`. `setAssociatedSignerHash` likewise rejects collisions; pass `undefined` to clear.

### `apps/desktop/src/stores/incoming-sigs.ts` (NEW)

```ts
export interface IncomingSigEntry {
  sighashDigest: string;        // matches PayrollBatch.sighashDigest
  slotIndex: number;
  signature: string;             // 0x-prefixed secp65
  senderAddrHash: string;        // 0x-prefixed 20-byte hex of envelope sender
  receivedAt: number;            // epoch ms
  sourceCommTx?: string;
}

interface IncomingSigsStore {
  bySighash: Record<string, IncomingSigEntry[]>;
  enqueue: (entry: IncomingSigEntry) => void;
  drain: (sighashDigest: string) => IncomingSigEntry[];
  peek: (sighashDigest: string) => IncomingSigEntry[];
  prune: (maxAgeMs: number) => void;
}
```

Persisted via Zustand (`chain-pay:incoming-sigs`), pruned on app boot (>30 days).

### `apps/desktop/src/stores/payroll-batches.ts` additions

```ts
// New optional field on PayrollBatch:
commSendStatus?: Record<number, {
  status: "idle" | "sending" | "sent" | "acked" | "error";
  txHash?: string;
  error?: string;
  updatedAt: number;
}>;

// New methods on the store:
drainIncomingSigsInto: (batchId: string) => { merged: number; rejected: number };
recordCommSendStatus: (
  batchId: string,
  slotIndex: number,
  status: "idle" | "sending" | "sent" | "acked" | "error",
  detail?: { txHash?: string; error?: string },
) => void;
```

`drainIncomingSigsInto` validates each pulled entry with `verifyDigestSignature(batch.sighashDigest, entry.signature, expectedHashForSlot)`. Valid → append to `partialSigs`. Invalid → drop + log. Dedup by slotIndex.

State auto-transitions: when `partialSigs.length === multisig.m`, calls `assertCanTransition` and advances state through `calculated → approved` (existing transitions).

### `apps/desktop/src/App.tsx` change

Extend the existing `useCommTransportBoot` (from 2.7b-1) with one subscription:

```ts
// Inside the existing useEffect after maybeStart():
const transport = createCommTransport();
const offSig = transport?.onIncomingSignature((from, body) => {
  useIncomingSigsStore.getState().enqueue({
    sighashDigest: body.txHash,
    slotIndex: body.slotIndex,
    signature: body.signature,
    senderAddrHash: from,
    receivedAt: Date.now(),
  });
  const batch = usePayrollBatchesStore
    .getState()
    .batches.find((b) => b.sighashDigest === body.txHash);
  if (batch) {
    usePayrollBatchesStore.getState().drainIncomingSigsInto(batch.id);
  }
});

return () => {
  // existing cleanup
  offSig?.();
};
```

### `useCommSendDispatch` hook

```ts
interface CommSendDispatchApi {
  sendAll: (batch: PayrollBatch) => Promise<void>;
  retry: (batch: PayrollBatch, slotIndex: number) => Promise<void>;
  statusFor: (batchId: string, slotIndex: number) => CommSendStatus;
}
```

Internally iterates `pubkeyHashes`; for each, looks up the peer via `findByAssociatedSignerHash`; constructs `OutgoingPacket` with `txHash = batch.sighashDigest`; calls `transport.sendPacket(peerProfile, packet)`; updates per-slot status throughout.

### `<CommSendSection />` UI

```
┌─ Send to signers via comm ─────────────────────┐
│ Batch sighash: 0x4ab2…f3c1                     │
│                                                │
│ Signer 0  [Alice] 0xaaaa…aaaa     ● sent       │
│ Signer 1  [Bob]   0xbbbb…bbbb     ○ idle       │
│ Signer 2  ⚠ no peer mapped — open Settings     │
│                                                │
│ [Send packet to mapped signers]   [Retry all]  │
└────────────────────────────────────────────────┘
```

Row per multisig slot. Status pill: `idle` / `sending` (spinner) / `sent` (✓) / `acked` (✓✓ — 2.7b-3) / `error` (⚠). Send button enabled when ≥1 slot is mappable. Retry button per-error-row.

### `<PeerBookSection />` UI

```
┌─ Peer book ─────────────────────────────────────┐
│ [+ Add peer]                                    │
│                                                 │
│ ┌───────────────────────────────────────────┐  │
│ │ Alice         ckt1qalice…       0xaaaa…  │  │
│ │ associated signer: 0xaaaa…aaaa   [edit]   │  │
│ └───────────────────────────────────────────┘  │
│ ┌───────────────────────────────────────────┐  │
│ │ Bob           ckt1qbob…         (none)   │  │
│ │ no associated signer    [associate]       │  │
│ └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

Add form: nickname, ckb address, optional `associatedSignerHash` (dropdown of known signer hashes across all treasuries + "(none)"). Validates refusal-invariant + duplicate-mapping.

## Data flow

### Send (operator → all signers)

```
PayPanel: batch reaches state="approved" (or "calculated" with sighashDigest set)
   ↓
User clicks "Send packet to mapped signers"
   ↓
useCommSendDispatch.sendAll(batch):
  for each pubkeyHash in batch.multisig.pubkeyHashes:
    1. peer = peerBook.findByAssociatedSignerHash(pubkeyHash)
    2. if !peer: recordCommSendStatus(slot, "error", "no peer mapped"); continue
    3. recordCommSendStatus(slot, "sending")
    4. packet: { txHash: batch.sighashDigest, treasuryAddress, expiresAt, packet: encoded }
    5. peerProfile = await transport.resolveProfile(peer.address)
    6. txHash = await transport.sendPacket(peerProfile, packet)
    7. recordCommSendStatus(slot, "sent", { txHash })
   ↓
UI updates per-slot status pills live (Zustand subscription)
```

### Receive (signature arrives)

```
Watcher (from 2.7b-1) sees notification cell → decryptIncoming → envelope
   ↓
envelope.kind === "signature" → onIncomingSignature handler in App.tsx
   ↓
incoming-sigs.enqueue({ sighashDigest, slotIndex, signature, senderAddrHash, receivedAt })
   ↓
findBySighashDigest(body.txHash) → matching batch?
   ↓ yes
payroll-batches.drainIncomingSigsInto(batch.id):
  entries = incoming-sigs.drain(batch.sighashDigest)
  for each entry:
    1. expectedHash = batch.multisig.pubkeyHashes[entry.slotIndex]
    2. verifyDigestSignature(batch.sighashDigest, entry.signature, expectedHash)
       invalid → drop + log; do NOT re-buffer
    3. dedup by slotIndex (first valid wins)
    4. append PartialSigEntry { slotIndex, signature, signerPubkeyHash: expectedHash, sourceCommTx }
   ↓
if partialSigs.length === multisig.m:
  assertCanTransition(state, "approved") → transition  // silent
   ↓
PayPanel re-renders: shows updated state, M collected sigs
```

### Race recovery (batch arrives after sig)

If a signature arrives before its batch is in the store (e.g. operator closed PayPanel mid-flow), the entry stays in `incoming-sigs.bySighash`. When PayPanel mounts and the batch is rehydrated:

```ts
useEffect(() => {
  if (batch?.sighashDigest && incomingSigsStore.peek(batch.sighashDigest).length > 0) {
    payrollBatchesStore.drainIncomingSigsInto(batch.id);
  }
}, [batch?.sighashDigest]);
```

Drain-on-mount catches any buffered entries that arrived while the batch wasn't observable. Same idempotent semantics.

### Ack-receiver stub

2.7b-2 doesn't wire ack handling. `transport.onIncomingAck` doesn't exist yet on the CommTransport interface (silently-dropped per 2.7a Task 14). 2.7b-3 adds it. For 2.7b-2: a comment marker in the boot effect noting the placeholder. Status pills can stop at `sent` indefinitely; no `acked` transition fires.

## Error handling & failure modes

### New typed errors

```ts
export class PeerMappingMissingError extends CommError {
  constructor(public readonly pubkeyHash: string) {
    super(`No peer mapped to signer pubkey hash ${pubkeyHash}`);
  }
}

export class IncomingSignatureValidationError extends CommError {
  constructor(
    public readonly sighashDigest: string,
    public readonly slotIndex: number,
    reason: string,
  ) {
    super(`Incoming signature for ${sighashDigest}:${slotIndex} invalid: ${reason}`);
  }
}
```

### Failure matrix

| Scenario | Detection | Behavior |
|---|---|---|
| Add peer with comm address that collides with a treasury signer | `assertNotMultisigSigner` (2.7a invariant, on addPeer) | throw `RefusalInvariantError`; form banner |
| Add peer with `associatedSignerHash` that doesn't appear in any treasury | passive check at add | accept; subtle hint "no current treasury uses this hash" |
| Add peer with duplicate `associatedSignerHash` | check in `addPeer` / `setAssociatedSignerHash` | throw with explicit error "already mapped to peer <nickname>"; user must unmap first |
| `sendAll` with no peers mapped | pre-flight check | UI banner; send button disabled |
| `sendAll` with some peers mapped | per-slot try | mapped slots send; unmapped slots stay `error`; partial-send allowed |
| `transport.sendPacket` IPC fails | per-slot try/catch | slot → `error` with message; loop continues |
| `transport.resolveProfile` fails | wraps `ProfileNotFoundError` | slot → `error: peer hasn't published a profile yet` |
| `sendPacket` succeeds but no ack within 5min | timeout watcher (2.7b-3) | slot stays `sent`; subtle "no ack yet" indicator; 2.7b-3 wires real ack tracking |
| Incoming sig has wrong slot (sig doesn't verify against expected hash) | `drainIncomingSigsInto` validation | drop + log; NOT re-buffered |
| Incoming sig for unknown sighashDigest | enqueue succeeds; drain never triggers | entry sits in buffer; pruned at 30d |
| Two valid sigs for same slot | dedup by slotIndex | first wins; second logged + dropped |
| Comm transport not running | `useCommSendDispatch` pre-flight | banner "comm channel not started"; button disabled |
| Operator deletes identity mid-flow | identity store change → factory rebuild → transport.stop() | previously-sent packets stay on-chain; can't receive replies until new identity published; warning at delete-confirm |

### Policy decisions

- **Partial-send is allowed.** Some signers via comm, others via clipboard fallback — mixed mode is fine.
- **Invalid signatures are dropped, not buffered.** A bad sig won't become good later.
- **Auto-state-transition is silent.** No notification when batch hits M sigs.
- **`expiresAt` is advisory in 2.7b-2.** 24h default; receiver doesn't enforce yet (2.7b-3).
- **No retry/backoff** — manual Retry button per slot only.

### Logging

Pubkey hashes, addresses, tx hashes, sighash digests. Never sig values in normal logs (public on-chain anyway, but no value spamming them). `sourceCommTx` field on persisted batch captures audit trail.

## Testing strategy

### Unit tests

| File | New | Focus |
|---|---|---|
| `stores/peer-book.test.ts` (MODIFIED) | +5 | `associatedSignerHash` roundtrip; duplicate rejection; setAssociated; clear; findBy |
| `stores/incoming-sigs.test.ts` (NEW) | ~8 | enqueue + dedup; drain returns+removes; peek; prune by age; persistence; concurrent enqueues |
| `stores/payroll-batches.test.ts` (MODIFIED) | +6 | drainIncomingSigsInto happy path; dedup; invalid sig rejected; missing batch no-op; auto-transition at M; recordCommSendStatus |
| `features/payments/useCommSendDispatch.test.ts` (NEW) | ~7 | sendAll happy; no peer → error; partial-send; retry single; IPC fail; resolveProfile fail; concurrent sends |
| `features/payments/CommSendSection.test.tsx` (NEW) | ~6 | status pills per slot; send disabled when no peers; click triggers sendAll; retry visible per error; banner; offline state |
| `features/settings/PeerBookSection.test.tsx` (NEW) | ~8 | empty + populated; add happy; refusal-invariant collision; duplicate-mapping rejection; remove; rename; edit association; signer dropdown |

**Target:** ~40 new + ~11 modifications. Project total ~273.

### Tests we don't write

- App.tsx boot-effect subscription — covered by useCommSendDispatch tests + smoke
- End-to-end PayPanel→signer→PayPanel — smoke gate

### Smoke roundtrip — 2.7b-2 additions

Extend `scripts/smoke-comm-roundtrip.mts`:
- Role A: in addition to existing flow, exercise `useCommSendDispatch.sendAll` shape using a synthetic batch with known sighashDigest. Listen for incoming signature; expect auto-match to drain into incoming-sigs store.
- Role B: unchanged — paste-receive in GUI continues; smoke sends fixture signature with the synthetic sighashDigest as txHash.

### Manual verification checkpoints

- [ ] Add peer → appears in list with no association
- [ ] Set `associatedSignerHash` via edit → persists across restart
- [ ] Refusal invariant fires when adding peer that collides with treasury signer
- [ ] Duplicate `associatedSignerHash` add → rejected with explicit error
- [ ] PayPanel: build batch → CommSendSection shows pills per signer
- [ ] Click Send → pills transition idle → sending → sent
- [ ] No peer mapped slot → ⚠ "no peer mapped" with Settings link
- [ ] Inject synthetic signature via smoke → auto-match fires, `sourceCommTx` set
- [ ] When Mth valid sig arrives → batch auto-transitions to `approved`
- [ ] Restart app between send and receive → incoming-sigs persisted; drain-on-mount recovers
- [ ] Invalid signature → rejected + logged; partialSigs unchanged
- [ ] PR #1 + #2 + this PR all build + test cleanly

## Out of scope (deferred to 2.7b-3 and beyond)

### Deferred to 2.7b-3 (signer side + polish)

- SignPanel inbox surface
- `ack` emission on receive (signer-side)
- `ack` receiver wiring on operator (status pill → `acked`)
- Sender retry/backoff (auto-retry with exponential backoff)
- Clipboard demotion to debug fallback
- Receiver-side `expiresAt` enforcement
- `onIncomingAck` on CommTransport interface + watcher dispatch

### Deferred to 2.7c+ / future

- Group ack consensus (collect M acks before broadcast)
- Per-peer rate limiting on incoming
- Cell consumption (upstream CEMP-PQ Receipts dependency)
- Address rotation per session (HKDF chain)
- Forward secrecy / double ratchet
- Mainnet readiness (main-process testnet-only via env var)

### Explicit non-goals for 2.7b-2

- No SignPanel changes
- No ack emission
- No retry/backoff
- No clipboard demotion
- No PayrollBatch state machine additions
- No mainnet

### Adjacent — Invoice ingestion

Vault-only at `~/Documents/loacal-vault/Projects/ChainPay/Invoice Ingest — Manual Upload Plan.md`. Triggers Phase 3-ish.

### Carry-forward concerns

- `onIncomingAck` interface gap — 2.7b-3 adds + dispatches `kind=ack`
- Auto-state-transition is silent — revisit with notification system (2.7c?)

## References

- 2.7a spec: `docs/superpowers/specs/2026-05-23-phase-2-7a-comm-transport-design.md`
- 2.7a plan: `docs/superpowers/plans/2026-05-23-phase-2-7a-comm-transport.md`
- 2.7b-1 spec: `docs/superpowers/specs/2026-05-23-phase-2-7b-1-comm-ceremony-design.md`
- 2.7b-1 plan: `docs/superpowers/plans/2026-05-23-phase-2-7b-1-comm-ceremony.md`
- CEMP-PQ upstream: `~/ecms/cemp-pq/`
- ChainPay hard rules: `~/chain-pay/CLAUDE.md`
- CKB transaction traps: `~/.claude/rules/ckb-transactions.md`
- Invoice ingestion (adjacent): `~/Documents/loacal-vault/Projects/ChainPay/Invoice Ingest — Manual Upload Plan.md`
