# Phase 2.7c — Mainnet Plumbing + Auto-Broadcast + Lifecycle-Bound Retry — Design

**Status:** Design, awaiting plan. Brainstormed 2026-05-25.
**Owner:** Phill.
**Branches from:** `main` at `6fac93f` (post Phase 2.7 epic). No stacking.
**Relates to:** 2.7a–2.7b-3 (the comm-channel epic this closes out). 2.7c is the final phase of the 2.7 series — it plumbs mainnet selection through every CKB surface, ships auto-broadcast as a per-batch opt-in, and replaces the cap=3 comm-send retry with a lifecycle-bound schedule.

## What 2.7c ships

Three bundled changes that together "close" 2.7:

- **Mainnet network selection (app-wide)**, plumbed but not flipped by default. User can pick `mainnet` or `testnet` from a Settings dropdown. Treasury operations work on either. Comm-channel works on testnet only (CEMP-PQ contract not yet deployed on mainnet) and surfaces a clear soft-fail banner on mainnet with clipboard fallback automatically re-enabled.
- **Per-batch auto-broadcast** with a 5-second countdown-and-cancel banner. Off by default; opt-in per batch via a PayPanel toggle. When the Mth partial sig arrives on an auto-broadcast batch, a banner counts down 5 seconds with a cancel button; on expiry, the assembled tx is sent to the operator's configured `broadcastRpcUrl`. No LC `sendTransaction` fallback (per `lc-broadcast-into-the-void`).
- **Lifecycle-bound comm-send retry.** Today's `useCommSendRetry` caps at 3 attempts over ~35 minutes. 2.7c replaces that with: backoff 5/10/20/30 min then 30 min indefinitely, stopping only on `batch.expiresAt`, terminal batch state, or explicit `dismissRetry`. Adds a per-pill "Retry now" button that resets the attempt counter.

## What 2.7c explicitly does NOT ship

- **Actually using mainnet for any treasury / comm operation.** This phase plumbs the seam; flipping the default is a separate session decision.
- **CEMP-PQ contract on mainnet.** Tracked upstream in `~/ecms/cemp-pq/`. 2.7c surfaces "not deployed" cleanly but does not deploy anything.
- **Live network switch (without restart).** Network change always requires app quit-and-relaunch with light-client IndexedDB wipe.
- **Per-network IndexedDB partitions.** Deferred; one shared DB scope with wipe-on-switch.
- **Auto-broadcast on by default.** Per-batch opt-in only.
- **Settings-configurable retry cap.** The lifecycle-bound schedule is hard-coded; "Retry now" handles operator impatience.
- **Confirmation modal before auto-broadcast.** The 5-second countdown is the only escape hatch.
- **Mainnet bootnode validation / health-check.** Settings just persists the user's choice; bad bootnodes surface as LC start failures via existing `lastError`.
- **Cross-app or cross-machine retry coordination.** Each app instance manages its own retry schedule, persisted to localStorage.
- **MPC-style auto-broadcast across signers.** Auto-broadcast is operator-side only — only the app that owns the batch broadcasts.

## Why this shape

Six decisions locked during brainstorming:

1. **App-wide single network with comm soft-fail** — one selector for the whole app; treasury and comm share the same network. Mainnet is allowed because secp256k1 multisig is a system contract deployed everywhere. Comm gets a banner because the ML-DSA lock isn't on mainnet yet. Alternative considered (decoupled per-subsystem network) creates confusing UX with marginal benefit since users rarely actually want mismatched stacks.
2. **Restart-required for network change** — sidesteps the known WASM IndexedDB collision (`wasm-light-client-network-switch` memory). Hot-swap was considered but introduces three new state machines (LC stop sequencing, comm-transport singleton invalidation, in-flight comm-packet stranding) for what's a once-per-deployment user action.
3. **Per-batch auto-broadcast toggle, default off, with countdown** — opt-in because broadcasting a real tx is the trust-model-relevant step and 2.7c is the slice that finally targets real money. Countdown provides automation while preserving an escape hatch. Silent-fire was considered but unsuitable for the mainnet-readiness posture this phase represents.
4. **Lifecycle-bound retry with 30 min cap** — current 35-min total horizon strands batches when a signer is on PTO or in a different timezone. The batch's own 24h `expiresAt` is the right ceiling. Cap at 30 min after attempt 4 avoids degrading to once-per-many-hours (a "reminder" cadence that misses end-of-day responsiveness).
5. **`network-config` store hosts the network field** — broadcast URL and network conceptually answer the same question ("how do I talk to CKB?"). One store, one persistence key, one migration path. The "broadcast URL changes hot, network requires restart" distinction is conveyed via Settings UI affordance rather than store partition.
6. **Identity stays network-agnostic via shared `addrHash`** — `addrHash = blake160(ML-DSA pubkey)` is network-invariant. Only the human-readable address string differs (`ckt` vs `ckb` prefix). One key material on disk; addresses derived per-network at lookup time. `publishedOn: CkbNetwork[]` tracks which networks have a live Profile Cell. Peers added by `addrHash` on testnet auto-work on mainnet once the contract ships — no peer-book migration.

## Architecture — the network seam

State lives in `network-config` zustand store, extended:

```ts
interface NetworkConfigStore {
  network: CkbNetwork;              // NEW — "testnet" | "mainnet", default "testnet"
  broadcastRpcUrl: string;          // existing
  setNetwork: (n: CkbNetwork) => void;
  setBroadcastRpcUrl: (url: string) => void;
}
```

Two consumers:

- **Renderer side** — `App.tsx` boot effect reads `network` and calls `startCkb(network)` (replacing the hard-coded `"testnet"` at line 156). Settings UI reads/writes both fields.
- **Main process** — `comm-transport-service` gains `getCkbClient(network)` returning `ClientPublicMainnet | ClientPublicTestnet`. Main process learns the network via a new preload IPC method `network:get` called once at boot from a `network-state.json` file in `userData`. Renderer notifies main via `network:set` only when the user has committed to a restart (the file is written immediately, but takes effect on next launch — main-process state is read-once at boot).

Network change is **never** applied live. Settings UI exposes an Apply button gated on selection-differs-from-persisted; the button opens a restart modal; on confirm, both stores write the new value and `app.quit()` fires. A one-shot `chain-pay:wipe-lc-on-next-boot` flag in localStorage triggers `electron.session.clearStorageData({storages: ['indexdb']})` before the next `startCkb()` call.

## Components — files changed

**Frontend (renderer)**

- `apps/desktop/src/stores/network-config.ts` — add `network` field with default `"testnet"`, `setNetwork` setter; bump persistence `version: 1 → 2` with migration that backfills `network: "testnet"` for existing users.
- `apps/desktop/src/App.tsx` — boot effect reads `network` from store and calls `startCkb(network)`; before that, checks `chain-pay:wipe-lc-on-next-boot` flag and invokes IPC wipe if set; subscribes main-process via `electron.network.set(network)` once at boot for cached client consistency.
- `apps/desktop/src/features/settings/NetworkSection.tsx` — **new file.** Radio cards (testnet/mainnet) + broadcast RPC URL field + Apply button. Apply opens the restart-confirmation modal.
- `apps/desktop/src/features/settings/NetworkRestartModal.tsx` — **new file.** Modal copy: "Restart required to apply network change. Your light-client chain data for *previous-network* will be wiped on next launch. Treasuries, payees, and payroll batches are preserved." Buttons: [Cancel] [Quit & Restart Later].
- `apps/desktop/src/features/settings/Settings.tsx` — slot `NetworkSection` above existing sections.

**Comm-channel + auto-broadcast UI (renderer)**

- `apps/desktop/src/features/payments/PayPanel.tsx` — add "Auto-broadcast when M sigs collected" checkbox bound to `batch.autoBroadcast`; renders the existing manual "Broadcast" button when state is `awaiting_signature` with M sigs (unchanged) AND adds a "Retry broadcast" button when state is `broadcast_failed` that calls `retryAutoBroadcast(batchId)`.
- `apps/desktop/src/features/payments/AutoBroadcastCountdown.tsx` — **new file.** Banner rendered when `batch.autoBroadcast && partialSigs.length >= M && batch.state === "awaiting_signature"`. Counts 5→4→3→2→1, then transitions batch state to `broadcast_initiating` and fires broadcast via `broadcastRpcUrl`. Cancel button reverts to `awaiting_signature` (sigs preserved).
- `apps/desktop/src/features/payments/useCommSendRetry.ts` — replace cap=3 with lifecycle-bound schedule (5/10/20/30/30/30 min capped after attempt 4); stop on `batch.state ∈ {broadcasted, broadcast_failed, confirmed, expired}` or `Date.now() > batch.expiresAt`; persist `nextRetryAt` for restart-safe scheduling.
- `apps/desktop/src/features/payments/CommSendSection.tsx` — per-signer pill grows a "Retry now" button that calls `useCommSendRetry.retryNow(batchId, slotIndex)`; pill also grows a dismiss "×" calling `dismissRetry(batchId, slotIndex)`. When `network === "mainnet"`, replaces the comm UI with single-line note: "Comm channel unavailable; use clipboard."
- `apps/desktop/src/features/settings/CommChannelSection.tsx` — when `network === "mainnet"` and identity exists, render soft-fail banner: "Comm-channel awaiting mainnet contract deployment. Use clipboard flow." Ceremony state-machine hidden.
- `apps/desktop/src/components/clipboard/ClipboardBar.tsx` — gating widens to `commAvailable = network === "testnet" && commActive`. On mainnet, clipboard bar shows unconditionally (subject to existing `showClipboard` debug toggle).

**Shared types**

- `packages/shared/src/payroll.ts` — `PayrollBatch.autoBroadcast?: boolean` (default undefined ≡ false).
- `packages/shared/src/payroll.ts` — `PayrollBatch.broadcastError?: string` for `broadcast_failed` state messaging.
- `packages/shared/src/payroll.ts` — `PayrollBatchState` adds `"broadcast_countdown" | "broadcast_initiating" | "broadcast_failed"`.
- `packages/shared/src/payroll.ts` — `CommSendStatusEntry.nextRetryAt?: number` for restart-safe retry scheduling.

**Renderer state**

- `apps/desktop/src/stores/payroll-batches.ts` — transitions for `broadcast_countdown` ↔ `broadcast_initiating` ↔ `broadcasted` / `broadcast_failed`; idempotency guard on `broadcastInFlight`; cancel transition; `retryAutoBroadcast` from `broadcast_failed` back to `awaiting_signature`.
- `apps/desktop/src/stores/comm-send-status.ts` — patch `nextRetryAt`/`retryCount` updates to use merge-pattern (not build-from-zero — same trap caught in 2.7b-3 final review).

**Main process**

- `apps/desktop/electron/main/comm-transport-service.ts` — replace `cachedClient: ClientPublicTestnet | null` with `Map<CkbNetwork, ccc.Client>`; new `getClient(network)` resolves to `ClientPublicMainnet` or `ClientPublicTestnet`; module-level `currentNetwork: CkbNetwork` set by IPC `network:set` and consulted by `generateIdentity`, `publishProfile`, `sendMessage`, `sendAck`, `listIncoming`, `decryptIncoming`. Identity-derivation helper changes from `deriveIdentityLock(seed)` to `deriveAddresses(seed)` returning `{ testnet: string; mainnet: string | null }`.
- `apps/desktop/electron/main/network-state-store.ts` — **new file.** Reads/writes `network-state.json` in `app.getPath('userData')` with `{ network: CkbNetwork }`. Defaults to `"testnet"` on missing file. Synchronous read at main-process boot.
- `apps/desktop/electron/main/index.ts` — registers IPC handlers `network:get` and `network:set`; calls `loadNetworkState()` before any comm-transport initialization; registers IPC handler `lc-storage:clear` invoking `session.defaultSession.clearStorageData({storages: ['indexdb']})`.
- `apps/desktop/electron/preload/index.ts` — expose `electron.network.get()` / `electron.network.set(n)` / `electron.lcStorage.clear()`.

**Vendored CEMP-PQ**

- `packages/cemp-pq/index.js` — add exported `ML_DSA_MAINNET = { CODE_HASH: null, HASH_TYPE: null, TX_HASH: null, INDEX: null }` as a clear "not deployed" marker; export `getMlDsaConstants(network)` that throws `"CEMP-PQ contract not deployed on mainnet"` when `network === "mainnet"` and returns `ML_DSA_TESTNET` for testnet.
- `packages/cemp-pq/index.d.ts` — type declarations for the new exports.
- `packages/cemp-pq/tx-builder.js` — `buildPublishProfileTx` and `buildSendMessageTx` accept `network: CkbNetwork` and use `getMlDsaConstants(network)` instead of hard-coding `ML_DSA_TESTNET`.

**Scripts**

- `scripts/smoke-comm-roundtrip.mts` — `--network` flag (default `testnet`); throws a clean "not supported on mainnet" error if `--network=mainnet` until the contract ships.

Roughly **3 new renderer files, 1 new main-process file, 14 existing-file edits, 3 vendored-package edits.** Largest single edit is `comm-transport-service.ts` (network threading through every exported function).

## Network-agnostic identity

**Stored on disk** (`comm-identity.json`, format unchanged on disk):

```
{
  mlDsaSec: 32-byte seed,
  mlKemSec: ML-KEM-768 secret,
  mlDsaPub, mlKemPub,
  addrHash: 20 bytes (network-invariant),
  createdAt: epoch ms,
  publishedOn: ("testnet" | "mainnet")[]   // NEW — networks where Profile Cell exists
}
```

**`publicInfo()` IPC return shape changes:**

```ts
interface PublicIdentity {
  mlDsaPub: string;
  mlKemPub: string;
  addrHash: string;                            // 0x-prefixed; same across networks
  addresses: {                                 // NEW
    testnet: string;
    mainnet: string | null;                    // null while ML_DSA_MAINNET.CODE_HASH === null
  };
  publishedOn: CkbNetwork[];                   // NEW
  createdAt: number;
}
```

**Derivation logic:** `deriveAddresses(seed)` runs the MLDSASigner twice (once with testnet client, once with mainnet client). Mainnet leg short-circuits to `null` when `ML_DSA_MAINNET.CODE_HASH === null`.

**`publishProfile(network)`** — gains explicit network parameter (rather than reading the module-level current network), to make the operation auditable in IPC logs. Records into identity file: `publishedOn = unique([...prev, network])`. Mainnet path throws "not deployed" until constants land.

**Refusal invariant unchanged** — refusal-invariant.ts compares `addrHash` values; since `addrHash` is network-invariant, a peer added on testnet is recognized on mainnet without re-import.

**Migration** for existing identity files: on first load post-2.7c, `publishedOn` is computed by querying the current network for an existing Profile Cell with this `addrHash`; if found, `["testnet"]` is recorded. (Mainnet not queried while contract is undeployed.)

## Auto-broadcast flow

**State-machine extension** in `payroll-batches` store:

```
awaiting_signature
  ├─ (M sigs arrived, autoBroadcast=true) → broadcast_countdown
  │    ├─ (5s elapsed)                    → broadcast_initiating
  │    │    ├─ (RPC success)              → broadcasted
  │    │    └─ (RPC failure)              → broadcast_failed
  │    └─ (user pressed Cancel)           → awaiting_signature (sigs preserved; toggle stays on)
  └─ (M sigs arrived, autoBroadcast=false)→ awaiting_broadcast  (existing manual path)
```

**Endpoint:** `useNetworkConfigStore.broadcastRpcUrl`. Empty string → skip countdown and transition straight to `broadcast_failed` with message "Configure broadcast RPC URL in Settings". No LC `sendTransaction` fallback.

**Idempotency:** the transition into `broadcast_initiating` sets `batch.broadcastInFlight = true` atomically (zustand `setState` compare-and-swap on prev state). Duplicate Mth-sig events while flag is set are no-ops.

**Cancel:** transitions from `broadcast_countdown` back to `awaiting_signature`. Sigs preserved. Auto-broadcast toggle remains on (user can manually broadcast or wait for any future state change). Cancel does NOT toggle the checkbox off.

**Trigger semantics — important:** the transition to `broadcast_countdown` fires on the *event* of the Mth partial sig arriving (i.e., during `addPartialSig` when the resulting count crosses M), **not** on the state of currently-having-M-sigs. After cancel, the batch sits in `awaiting_signature` with M sigs and the toggle on, but the countdown does NOT immediately re-fire. The auto-broadcast for this batch is then effectively "spent" until either (a) sigs are removed and a new Mth sig arrives, or (b) the user manually re-arms via the "Broadcast" button.

**Retry from `broadcast_failed`:** PayPanel renders a "Retry broadcast" button when `batch.state === "broadcast_failed"`. Clicking calls `retryAutoBroadcast(batchId)`, which transitions back to `awaiting_signature` and re-triggers `broadcast_countdown` if M sigs are still present (this is the one exception to the event-driven rule — explicit user action treats the existing M sigs as a fresh trigger).

## Retry policy

**Schedule by attempt index** (0-indexed, 0 = initial send):

| `i` | Wait before attempt | Cumulative |
|---|---|---|
| 0 | 0 (initial send)  | 0       |
| 1 | 5 min             | 5 min   |
| 2 | 10 min            | 15 min  |
| 3 | 20 min            | 35 min  |
| 4 | 30 min            | 65 min  |
| 5+ | 30 min each      | every 30 min thereafter |

**Stop conditions** (any one halts the retry loop for `(batchId, slotIndex)`):

- `batch.state ∈ {broadcasted, broadcast_failed, confirmed, expired}`
- `Date.now() > batch.expiresAt` (24 h after `batch.createdAt`)
- User invoked `dismissRetry(batchId, slotIndex)` (small "×" on the pill)

**`retryNow(batchId, slotIndex)`:**
1. Cancels any pending `setTimeout` for that key
2. Resets `commSendStatus[key].retryCount = 0` and clears `nextRetryAt`
3. Re-dispatches the send immediately
4. Schedule re-arms from `i=1` (5 min) for any future failures

**Restart-safe persistence:** `commSendStatus.nextRetryAt` (epoch ms) persists across app restart. On `useCommSendRetry` mount, it inspects all stored entries: if `nextRetryAt < Date.now()`, fires immediately; otherwise schedules the residual delay (`nextRetryAt - Date.now()`).

**One-shot semantics across batch-state changes:** once a stop condition fires for `(batchId, slotIndex)`, the retry loop exits and does not auto-resume — even if the batch later transitions out of the terminal state (e.g., `broadcast_failed → awaiting_signature` via `retryAutoBroadcast`). To resume retrying a specific signer, the operator clicks "Retry now" on that signer's pill. This keeps the retry policy tied to operator intent rather than batch-state heuristics.

## Mainnet soft-fail UX

When `network === "mainnet"`:

1. **Settings → Comm Channel section** — renders a single-state banner above any existing UI:
   > Comm-channel unavailable on mainnet. The post-quantum signature contract has not yet been deployed on CKB mainnet. Treasury operations work normally; signature relay falls back to clipboard. *(Status: awaiting upstream deployment of CEMP-PQ.)*

   The ceremony state-machine (NotConfigured/Funding/Publishing/Ready) is hidden entirely — no Generate Identity button, no Publish Profile button. Avoids creating mainnet identity state we can't use.

2. **Clipboard bar** — `commAvailable = network === "testnet" && commActive`. On mainnet, `commAvailable === false` regardless of `commActive`, so the clipboard bar shows unconditionally (subject to existing `showClipboard` debug toggle). Operators get the existing flow back automatically.

3. **PayPanel `CommSendSection`** — when `!commAvailable`, the entire comm-send UI is replaced by a one-line note: "Comm channel unavailable; use clipboard." Auto-broadcast toggle remains functional (manual paste path can still hit M sigs).

4. **Main-process behaviour** — on boot with `network === "mainnet"`, the comm-transport watcher does **not** start the `listCells` poll loop. Saves CKB mainnet RPC calls for an unusable feature.

## Network-change restart flow

Triggered from `NetworkSection.tsx` when user picks a different radio:

1. Immediate optimistic UI update — radio shows the new selection.
2. Apply button reads: **"Apply (restart required)"**. Disabled until selection differs from persisted.
3. On click → restart modal (`NetworkRestartModal.tsx`).
4. Cancel → reverts radio to persisted value, no store write.
5. Confirm:
   - `setNetwork(newNetwork)` writes to zustand (persisted to localStorage).
   - Main-process IPC `network:set(newNetwork)` writes `network-state.json`.
   - Sets one-shot localStorage flag: `chain-pay:wipe-lc-on-next-boot = true`.
   - `electron.app.quit()`.
6. Next launch — `App.tsx` boot effect checks the flag. If set:
   - Calls `electron.lcStorage.clear()` via IPC **before** any `startCkb()` call.
   - Clears the flag.
   - Proceeds with normal boot path using the new `network` value.

The wipe is unconditional on the flag. Users who manually edit localStorage to flip network without using the flow hit the documented WASM panic — that's a sharp edge they had to deliberately take.

## Error handling

| Failure | Surface | Behaviour |
|---|---|---|
| `network:get` IPC returns null (first launch ever) | main process | Defaults to `"testnet"`; writes to file. |
| `broadcastRpcUrl` empty when auto-broadcast fires | renderer | Skip countdown; transition to `broadcast_failed` with message "Configure broadcast RPC URL in Settings". |
| RPC broadcast network failure | renderer | `broadcast_failed`; full RPC error in `batch.broadcastError`; PayPanel renders inline with `retryAutoBroadcast` button. |
| `publishProfile({network: "mainnet"})` while contract undeployed | main process | Throws `"CEMP-PQ contract not deployed on mainnet"`; caller renders error; ceremony does not advance. |
| Network-change wipe flag set but `lc-storage:clear` IPC fails | renderer | Logs to console; does not clear flag; LC start likely panics with known mismatch. Documented worst case for v0; the supported flow always pairs wipe with quit-and-restart. |
| User imports an identity file from a different machine | renderer | `addrHash` is network-invariant, so symmetric. `publishedOn` rebuilt from chain queries on first ceremony entry per network. |
| Persistence migration v1→v2 on a corrupt localStorage entry | renderer | Falls back to defaults (network: `"testnet"`, broadcastRpcUrl: `""`); existing zustand migration error path. |

## Testing strategy

**Vitest unit tests (TDD, RED first):**

- `network-config.test.ts` — `network` field defaults to `"testnet"`; `setNetwork` updates; v1→v2 migration backfills `network: "testnet"`.
- `comm-transport-service.test.ts` — `getClient("mainnet")` returns `ClientPublicMainnet`; `publishProfile({network: "mainnet"})` throws "not deployed"; `publishProfile({network: "testnet"})` still works against mock chain; `currentNetwork` set via IPC affects which client is used.
- `network-state-store.test.ts` — read/write/default behaviour on `network-state.json`.
- `useCommSendRetry.test.ts` — backoff schedule per attempt index (table-driven); `retryNow` resets `retryCount` and `nextRetryAt`; lifecycle stops on each terminal state; `nextRetryAt` persistence/replay across restart; `dismissRetry` halts loop.
- `payroll-batches.test.ts` — auto-broadcast state transitions (countdown→initiating→broadcasted/failed); cancel reverts to `awaiting_signature` and preserves sigs; idempotent on duplicate Mth-sig events; `retryAutoBroadcast` from `broadcast_failed`.
- `AutoBroadcastCountdown.test.tsx` — renders only when `autoBroadcast && M sigs collected && state === awaiting_signature`; cancel halts; 5s elapses → state transition.
- `NetworkSection.test.tsx` — radio change enables Apply; Apply opens modal; Cancel reverts; Confirm fires `network:set` IPC + sets wipe flag + calls `app.quit()` (all mocked).
- `NetworkRestartModal.test.tsx` — renders correct copy ("Restart required" + current and target network names + preservation guarantee); Cancel button; Quit button.
- `CommSendSection.test.tsx` — mainnet renders "comm unavailable" replacement; "Retry now" button calls `retryNow`; dismiss "×" calls `dismissRetry`.
- `CommChannelSection.test.tsx` — mainnet renders soft-fail banner; ceremony state-machine hidden.
- `ClipboardBar.test.tsx` — `commAvailable` gating with mainnet/testnet × `showClipboard`/`commActive` combinations.
- `cemp-pq tx-builder.test.js` — `getMlDsaConstants("testnet")` returns existing constants; `("mainnet")` throws; `buildPublishProfileTx({network: "testnet"})` uses testnet cell_deps.

**Manual smoke (run by Phill, not automated):**

1. Fresh launch on testnet — existing happy path still works (full payroll batch end-to-end).
2. Switch to mainnet via Settings — modal appears, confirm, app quits, relaunch — LC connects to mainnet, mainnet bootnodes resolve, tip block visible.
3. On mainnet — Comm Channel section shows soft-fail banner; clipboard bar visible by default; PayPanel CommSendSection shows fallback note.
4. Switch back to testnet — second IndexedDB wipe works; testnet LC syncs from genesis again (acceptable, no real-funds loss).
5. Testnet auto-broadcast — enable per-batch toggle, collect 2-of-3 sigs, observe 5s countdown banner, verify Cancel reverts and toggle stays on; re-arm and let it fire, verify broadcast via configured RPC URL.
6. Testnet retry — pause one signer's app, watch operator's pill cycle through 5/10/20/30 min retries (fast-forward via dev-tools manipulation of `nextRetryAt`); use "Retry now" to short-circuit and verify counter resets.
7. Testnet `broadcast_failed` recovery — temporarily blank the `broadcastRpcUrl`, trigger auto-broadcast, observe `broadcast_failed` with clear copy; restore URL, click "Retry broadcast" button on the batch, verify success.

**Smoke script update:** `scripts/smoke-comm-roundtrip.mts` `--network` flag added; default `testnet`; throws clean error on `--network=mainnet` while contract is undeployed.

## Open questions

None at design time. Implementation-shape decisions deferred to writing-plans:

- Whether `comm-transport-service.ts` threads `network` per-call or reads from a module-level `currentNetwork` — both work; pick whichever produces less diff in the actual code.
- Whether `NetworkRestartModal` is a portal or inline — pick whatever matches existing modal patterns in Settings.

## References

- `[[wasm-light-client-network-switch]]` — IndexedDB collision on network change, drives the restart-required choice.
- `[[lc-broadcast-into-the-void]]` — LC `sendTransaction` unreliable on public testnet, drives broadcast-RPC-URL-only auto-broadcast endpoint.
- `[[cemp-pq-supersedes-comm-channel]]` — `~/ecms/cemp-pq/` is the upstream where mainnet deployment will eventually land.
- `[[phase-2-7-slicing]]` — places 2.7c in the broader 2.7 epic.
- `[[subagent-driven-cross-task-bugs]]` — final-review catches like `recordCommSendStatus` build-from-zero are why `comm-send-status` patches in 2.7c must use merge-pattern.
