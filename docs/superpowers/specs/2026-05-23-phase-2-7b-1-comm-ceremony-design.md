# Phase 2.7b-1 — Comm Channel Ceremony & Transport Fixes Design

**Status:** Design, awaiting plan. Brainstormed 2026-05-23.
**Owner:** Phill.
**Stacked on:** Phase 2.7a (PR #1, branch `feat/phase-2-7a-comm-transport`). 2.7b-1's branch `feat/phase-2-7b-1-comm-ceremony` starts from 2.7a's tip.
**Supersedes/relates to:** `docs/superpowers/specs/2026-05-23-phase-2-7a-comm-transport-design.md` (2.7a, transport-only). 2.7b is split into 2.7b-1 (this spec — transport fixes + Settings ceremony) and 2.7b-2 (PayPanel/SignPanel/PayrollBatch integration + clipboard demotion).

## What 2.7b-1 ships

The transport plumbing from 2.7a + the Settings ceremony surface that makes it actually usable. After 2.7b-1 lands:

- The smoke roundtrip script completes end-to-end on testnet (CEMP-PQ MessagePointer gap closed)
- A user can set up their comm-channel identity from Settings, fund it, and publish a Profile Cell via GUI
- The CommTransport singleton runs on app boot when an identity exists
- The refusal invariant works in production at all three sites (peer-book, treasury, identity keygen)

After 2.7b-1, the **transport is real** and the **identity setup ceremony is real**. UI for sending/receiving comm messages is deliberately **NOT** in scope — that's 2.7b-2's job.

## What 2.7b-1 explicitly does NOT ship

- PayPanel "Send to signers" button
- SignPanel inbox surface
- Peer book CRUD UI (you can't *send to* anyone yet)
- PayrollBatch auto-merge wire-up
- ack emission + retry
- Clipboard packet/signature flow demotion
- Mainnet readiness (main-process client stays testnet-only via env var)

Deferred to 2.7b-2 and beyond — see Section 7.

## Why this shape

Five decisions locked during brainstorming:

1. **Decomposition:** 2.7b splits into 2.7b-1 (smoke-ready) and 2.7b-2 (full UX). Each is independently testable and produces a working artefact.
2. **MessagePointer fix:** patch vendored `packages/cemp-pq/tx-builder.js::buildSendMessageTx` to write a real MessagePointer into the notification cell's `outputData[1]`. Preserves CEMP-PQ's two-cell design. Also enriches `fetchRecipientProfile` to return the full `{ mlDsaPubKey, mlKemPubKey, metadata }` shape that 2.7a's `.d.ts` declared as the target.
3. **Boot wiring:** auto-start the transport when an identity with a published profile exists. App.tsx `useEffect` reads `useCommIdentityStore`, calls `createCommTransport()`, and starts the watcher. Subscribes to identity changes for rebuild-on-change.
4. **Setup ceremony flow:** keygen → poll balance → auto-publish on `≥70 CKB` → ready. Minimum clicks, explicit about the on-chain action via a progress indicator.
5. **Build order:** transport fixes first (validated by smoke), then Settings ceremony. Single PR stacked on 2.7a.

## Architecture & file layout

```
chain-pay/
├── packages/cemp-pq/
│   ├── tx-builder.js                    # MODIFIED: buildSendMessageTx writes MessagePointer
│   │                                    #           into outputs[1].outputsData[1].
│   │                                    #           fetchRecipientProfile returns the richer
│   │                                    #           { mlDsaPubKey, mlKemPubKey, metadata } shape.
│   ├── tx-builder.test.js               # NEW. First test in vendored package.
│   └── index.d.ts                       # MODIFIED: reverts fetchRecipientProfile to
│                                        #           Promise<ProfileFetchResult | null>.
│
├── apps/desktop/
│   ├── electron/main/
│   │   ├── comm-transport-service.ts    # MODIFIED: generateIdentity returns addrHash;
│   │   │                                #           resolveProfile returns full hex tuple.
│   │   └── comm-transport-service.test.ts   # NEW. Tests for new shape.
│   │
│   ├── src/
│   │   ├── App.tsx                      # MODIFIED: useCommTransportBoot() effect added.
│   │   │
│   │   ├── lib/comm/
│   │   │   ├── index.ts                 # MODIFIED: cache keyed by identity.address;
│   │   │   │                            #           resetCommTransport() (drop _ForTests).
│   │   │   ├── index.test.ts            # NEW. Singleton invalidation tests.
│   │   │   ├── own-identity-hash.ts     # MODIFIED: reads cached addrHash from store.
│   │   │   └── own-identity-hash.test.ts # MODIFIED: production path now meaningful.
│   │   │
│   │   ├── stores/
│   │   │   ├── comm-identity.ts         # MODIFIED: CommIdentityState gains addrHash;
│   │   │   │                            #           persist version → 2 with v1 drop.
│   │   │   └── comm-identity.test.ts    # MODIFIED: addrHash roundtrip + migration tests.
│   │   │
│   │   └── features/settings/
│   │       ├── Settings.tsx             # MODIFIED: add <CommChannelSection /> tab/panel.
│   │       ├── CommChannelSection.tsx   # NEW. State-machine container.
│   │       ├── CommChannelSection.test.tsx  # NEW.
│   │       ├── useCommChannelSetup.ts   # NEW. Hook deriving state from store + actions.
│   │       ├── useCommChannelSetup.test.ts  # NEW.
│   │       └── steps/
│   │           ├── NotConfiguredStep.tsx
│   │           ├── FundingStep.tsx
│   │           ├── PublishingStep.tsx
│   │           └── ReadyStep.tsx
│
└── scripts/
    └── smoke-comm-roundtrip.mts         # UNCHANGED — verified to now actually complete.
```

**~8 modified files + ~10 new files.** Each step component <100 lines, the container is the state machine, the hook is the orchestrator. Steps are testable in isolation via React Testing Library.

## Components & interfaces

### `packages/cemp-pq/tx-builder.js` — MessagePointer write

Inside `buildSendMessageTx`, after the tx is structured but before signing:

```js
// outputs[0] = message cell (sender-locked, ciphertext)
// outputs[1] = notification cell (recipient-locked)
const messageTxHash = tx.hash();  // CCC hash excludes witness; stable pre-sign
const messagePointer = serializeMessagePointer(messageTxHash, 0);
tx.outputsData[1] = "0x" + Buffer.from(messagePointer).toString("hex");
```

`fetchRecipientProfile` rewritten:

```js
async fetchRecipientProfile(recipientLock) {
  // ... existing find-cell logic ...
  const profile = Profile.unpack(cell.outputData);
  return {
    mlDsaPubKey: profile.ml_dsa_public_key,
    mlKemPubKey: profile.ml_kem_public_key,
    metadata: profile.metadata,
  };
}
```

### `apps/desktop/electron/main/comm-transport-service.ts`

`generateIdentity` adds `addrHash`:

```ts
return {
  mlDsaPub: "0x" + ...,
  mlKemPub: "0x" + ...,
  address,
  addrHash: "0x" + Buffer.from(addressArgs.slice(0, 20)).toString("hex"),
  createdAt: plain.createdAt,
};
```

`resolveProfile` returns the now-real richer shape (hex-encoded ML-DSA + ML-KEM pubkeys + utf8 metadata).

### `apps/desktop/src/stores/comm-identity.ts`

```ts
export interface CommIdentityState {
  mlDsaPub: string;
  mlKemPub: string;
  address: string;
  addrHash: string;        // NEW. 0x-prefixed 20-byte hex.
  createdAt: number;
  fundedAt: number | null;
  profileTxHash: string | null;
  profilePublishedAt: number | null;
}
```

Bump persist `version: 2`. Migration drops any v1 record (no real users yet — clean wipe acceptable).

### `apps/desktop/src/lib/comm/own-identity-hash.ts`

```ts
export function getOwnIdentityHash(): Uint8Array | null {
  if (getterOverride) return getterOverride();
  const id = useCommIdentityStore.getState().identity;
  if (!id?.addrHash) return null;
  return hexToBytes(id.addrHash);
}
```

Production path now reads from the cached field. No more 2.7a "test-only enforcement" caveat.

### `apps/desktop/src/lib/comm/index.ts`

```ts
let cached: { transport: CempPqCommTransport; identityAddress: string } | null = null;

export function createCommTransport(): CommTransport | null {
  const identity = useCommIdentityStore.getState().identity;
  if (!identity) {
    if (cached) { void cached.transport.stop(); cached = null; }
    return null;
  }
  if (cached && cached.identityAddress === identity.address) return cached.transport;
  if (cached) void cached.transport.stop();
  cached = {
    transport: new CempPqCommTransport({ /* wiring */ }),
    identityAddress: identity.address,
  };
  return cached.transport;
}

export function resetCommTransport(): void {
  if (cached) { void cached.transport.stop(); cached = null; }
}
```

The cache is keyed by `identity.address`. Identity changes (delete + regenerate) cause auto-rebuild on next call. `_resetCommTransportForTests` renamed to `resetCommTransport` (production-used now).

### `apps/desktop/src/App.tsx` — boot effect

```tsx
function useCommTransportBoot(): void {
  useEffect(() => {
    // Wire peer-book's knownSignersGetter to live treasury state.
    usePeerBookStore.setState({
      knownSignersGetter: () => {
        const treasuries = useTreasuryStore.getState().treasuries;
        return treasuries.flatMap((t) =>
          "pubkeyHashes" in t.multisig
            ? t.multisig.pubkeyHashes.map((h) => ({
                treasuryId: t.id,
                pubkeyHash: hexToBytes(h),
              }))
            : []
        );
      },
    });

    function maybeStart(): void {
      const transport = createCommTransport();
      const id = useCommIdentityStore.getState().identity;
      if (transport && id?.profileTxHash) {
        void transport.start();
      }
    }

    maybeStart();
    const unsub = useCommIdentityStore.subscribe(maybeStart);
    return () => {
      unsub();
      void createCommTransport()?.stop();
    };
  }, []);
}
```

The boot effect is the **sole caller** of `transport.start()`. UI never starts/stops the transport directly — it only triggers store mutations that the effect reacts to.

### Settings ceremony state machine

```ts
type CommSetupState =
  | { kind: "not-configured" }
  | { kind: "funding"; address: string; addrHash: string; currentBalance: bigint; required: bigint }
  | { kind: "publishing"; address: string }
  | { kind: "ready"; address: string; publishedAt: number };

function useCommChannelSetup(): {
  state: CommSetupState;
  generate: () => Promise<void>;
  deleteIdentity: () => Promise<void>;
};
```

Container picks the step component based on `state.kind`. Each step is purely presentational + invokes hook actions. Balance polling lives inside `FundingStep` via `setInterval(5_000)` calling `lightClient().getLockBalance(commLock)`.

## Data flow

### Boot

```
App.tsx mount
  ↓
useCommTransportBoot():
  1. wire peer-book.knownSignersGetter → treasury store
  2. if identity exists AND profileTxHash set:
       createCommTransport() → singleton
       transport.start() → resolves profilePublishBlock, watchLockScript, watcher starts
  3. subscribe to useCommIdentityStore:
       on change: createCommTransport() rebuilds if address differs; start() idempotent
  4. unmount cleanup: stop transport, unsub
```

### Setup ceremony — happy path

```
[NotConfiguredStep] user clicks "Set up comm channel"
  ↓
generate():
  - window.chainpay.commIdentity.generate() (main: ml_dsa65 + ml_kem768 keygen,
    derive lock + address, save encrypted, return + addrHash)
  - useCommIdentityStore.setIdentity(returned)
  - store change → boot effect → createCommTransport() builds singleton
    (but transport.start() does NOT fire — profileTxHash still null)
  ↓
[FundingStep] state.kind="funding"
  - displays address + copy button + amount required
  - setInterval(5_000) polls lightClient().getLockBalance(commLock)
  ↓
balance ≥ 70 CKB observed
  ↓
useCommChannelSetup transitions to "publishing":
  - recordFunded(Date.now())
  - transport.publishProfile({ displayName? })
    - main: withSecrets → CEMPTransactionBuilder.buildCreateProfileTx
    - returns { txHash, txBytes }; renderer broadcasts via lightClient
  - useCommIdentityStore.recordProfilePublished(txHash, Date.now())
  - store change → boot effect → transport.start() fires (profileTxHash now set)
  ↓
[ReadyStep] state.kind="ready"
```

### Setup ceremony — error paths

- `generate()` throws → error banner inside NotConfiguredStep with retry button
- Profile publish broadcast fails → state stays "publishing" with 30s timeout, then back to "funding" with error message
- Balance poll fails → silent retry with "Connecting..." indicator; surfaces "LC offline >60s" after 12 consecutive failures

### Identity deletion

```
[ReadyStep] user clicks "Delete identity"
  ↓
Confirmation modal: "Permanently delete... messages already sent stay on-chain forever. Continue?"
  ↓ confirm
deleteIdentity():
  - transport.stop()
  - window.chainpay.commIdentity.delete()
  - useCommIdentityStore.clear()
  - store change → boot effect → createCommTransport() returns null (no identity)
  ↓
[NotConfiguredStep] state.kind="not-configured"
```

### Smoke roundtrip after fixes

With the CEMP-PQ patch:

```
Role A sendMessage(B, envelope):
  1. main: buildSendMessageTx
       outputs[0] = { lock: A_lock, data: encryptedEnvelope }
       outputs[1] = { lock: B_lock, data: serializeMessagePointer(txHash, 0) }
  2. signOnlyTransaction; renderer broadcasts
Role B watcher:
  3. listCellsForLock(B_lock) → finds notification cell with 36-byte pointer data
  4. parseMessagePointer reads TLV header offsets → { txHash, index }
  5. decryptIncoming({ txHash, index: 0 }) → main: getCellLive → decapsulate + decrypt
  6. decodeEnvelope → dispatch
```

## Error handling & failure modes

### New typed errors

```ts
export class IdentityGenerationError extends CommError {}
export class ProfilePublishError extends CommError {
  constructor(public readonly txHash: string | null, message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
```

### Failure matrix

| Scenario | Detection | Behavior |
|---|---|---|
| safeStorage unavailable at keygen | main checks before keygen | `IdentityGenerationError` with platform guidance |
| Refusal-invariant collision at keygen | `assertNotMultisigSigner` on derived hash | `IdentityGenerationError`; retry button |
| Disk full / IO error on save | `fs.writeFile` throws | atomic write means no partial state; error surfaced |
| Address already exists in main | `saveCommIdentity` refuses overwrite | `IdentityGenerationError` |
| Balance poll: LC disconnected | `getLockBalance` throws/returns 0 | "Connecting..." indicator; retry; warn after 60s |
| Balance flicker / misread | n/a | publish fires on first ≥70 read; if read was wrong, broadcast fails → rollback |
| `publishProfile` IPC fails | renderer's `await` rejects | rollback to "funding" with error banner |
| `publishProfile` broadcast fails | `lightClient().broadcastTransaction` rejects | `ProfilePublishError(null, ...)`; rollback to "funding"; "Retry publish" button |
| Profile cell not confirmed within 5min | poll `getTransaction(profileTxHash)` | state stays "publishing"; eventually error banner suggesting slow testnet |
| `delete` IPC fails | main bubbles error | UI shows error; store unchanged; user retries |
| Transport `start()` rejects | most often: `getProfilePublishBlock` returns null | boot effect catches + logs; next store change retries |
| Identity deleted while start() in-flight | next store-change tick rebuilds | old start()'s resolution discarded; no harm |

### Policy decisions

- **Keygen-collision retry is automatic-but-confirmed.** Astronomically rare. Show error, one-click retry deletes + regenerates.
- **No fallback if safeStorage unavailable on Linux.** Show platform guidance, refuse to generate. `SMOKE_PASSPHRASE` fallback is smoke-script-only.

### Logging

Pubkey hashes + addresses + tx hashes + block heights. NEVER secret bytes, plaintext payloads, or PII.

## Testing strategy

### Unit tests

| File | New tests | Focus |
|---|---|---|
| `packages/cemp-pq/tx-builder.test.js` (NEW) | ~3 | buildSendMessageTx writes parseable MessagePointer; fetchRecipientProfile returns richer shape |
| `electron/main/comm-transport-service.test.ts` (NEW) | ~4 | generateIdentity returns addrHash; resolveProfile returns hex tuple; refusal at keygen; deleteIdentity removes file |
| `lib/comm/own-identity-hash.test.ts` (MODIFIED) | +3 | Cached addrHash bytes returned; override hook works; rehydration |
| `lib/comm/index.test.ts` (NEW) | ~6 | Returns null no-id; same instance same-id; rebuild on address change; reset stops + clears; subsequent return-null after clear |
| `stores/comm-identity.test.ts` (MODIFIED) | +3 | addrHash roundtrip; v1→v2 migration; rejects records without addrHash |
| `features/settings/CommChannelSection.test.tsx` (NEW) | ~10 | Step routing per state.kind; generate button → IPC; funding poll + auto-publish transition; delete confirmation; error banners |
| `features/settings/useCommChannelSetup.test.ts` (NEW) | ~6 | State machine derivation; transitions only on store changes; auto-publish fires once per crossing |

**Target:** ~35 new tests + ~6 modifications. Project total ~177.

### Tests we deliberately don't write

- **App.tsx boot effect** — high-friction to test (React effects + Zustand + IPC + timers); smoke exercises it. Cover the contract via factory tests.
- **End-to-end Settings click-through** — exercised by smoke + manual checkpoints. Playwright e2e against mocked chain wouldn't catch real failure modes.

### Smoke roundtrip — re-run

`scripts/smoke-comm-roundtrip.mts` unchanged but **becomes meaningful** once the CEMP-PQ patch lands. End-to-end on testnet is the canonical "2.7b-1 done" gate.

### Manual verification checkpoints

- [ ] Generate identity from Settings → persists across app restart
- [ ] Address copies cleanly to clipboard
- [ ] Balance display updates within 10s of external transfer
- [ ] Auto-publish fires within one poll tick of crossing 70 CKB
- [ ] Profile cell visible on testnet explorer at the comm address
- [ ] Delete identity → confirmation → state returns to NotConfigured
- [ ] After delete + regenerate, transport singleton rebuilt (watcher only sees the new address's cells)
- [ ] Refusal-invariant collision path tested via unit test only (astronomically rare to reproduce manually)
- [ ] Smoke script ends with "roundtrip OK" on both roles using funded testnet wallets

## Out of scope (deferred to 2.7b-2 and beyond)

### Deferred to 2.7b-2

- PayPanel "Send to signers via comm" button + per-signer send status
- SignPanel inbox surface
- Peer book CRUD UI
- PayrollBatch auto-merge wire-up
- `ack` emission + sender retry/backoff
- Clipboard packet/signature flow demoted to "debug fallback"

### Deferred to 2.7c+ / future

- Notification Cell consumption (capacity recovery)
- Address rotation (HKDF chain per session)
- Forward secrecy / double ratchet
- Multi-device sync
- Mainnet readiness — `getClient()` reads network from shared config

### Explicit non-goals for 2.7b-1

- No UI for adding peers (no send-to surface in this slice)
- No UI for incoming packets (watcher runs but dispatches go nowhere visible until 2.7b-2)
- No PayPanel/SignPanel/PayrollBatch changes

### Adjacent upstream — Invoice ingestion

Stays parked in vault (`~/Documents/loacal-vault/Projects/ChainPay/Invoice Ingest — Manual Upload Plan.md`). Triggers at ChainPay Phase 3-ish. Forward-compat unchanged.

## References

- 2.7a spec: `docs/superpowers/specs/2026-05-23-phase-2-7a-comm-transport-design.md`
- 2.7a plan: `docs/superpowers/plans/2026-05-23-phase-2-7a-comm-transport.md`
- CEMP-PQ upstream: `~/ecms/cemp-pq/`
- 2.7a PR: https://github.com/toastmanAu/chain-pay/pull/1
- ChainPay hard rules: `~/chain-pay/CLAUDE.md`
- CKB transaction traps: `~/.claude/rules/ckb-transactions.md`
