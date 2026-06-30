# Send-source rescan + dedup — design

**Date:** 2026-06-30
**Branch:** `feat/send-source-rescan-dedup`
**Status:** approved (brainstorming → spec)

## Problem

Two related defects in the send-source surface, both surfaced during the 2026-06-29 JoyID
relay-signer smoke session:

1. **Deep-history wallets show a wrong (often zero) balance.** When a JoyID wallet is
   connected (`SourceList.handleConnect`) or a keystore lock is added as a source
   (`KeyvaultSetupPanel.handleUseAsSource`), the light client is told to watch the lock from
   `tip − 10_000` blocks (`watchLockScriptFromRecent`). That is correct for a *freshly created*
   wallet, but a wallet with pre-existing coins older than the margin never gets those cells
   synced. Concrete case this session: a connected JoyID source held **134 txs / 31 live cells
   / 218,786 CKB**, almost all older than the margin, and the app showed ~0. There is currently
   **no way to re-scan a lock from an earlier block** — `TreasuryDetail.tsx:62` and
   `SourceList.tsx:44` both leave a "rescan control (backlog)" comment.

2. **Duplicate sources accumulate.** `useSourcesStore.addSource` (`stores/sources.ts`) appends
   unconditionally with no dedup. Repeated Connect clicks (e.g. during the black-screen
   debugging) created ~3 JoyID sources for the same wallet. There is no migration to collapse
   existing duplicates.

A third, separate item — proving the JoyID relay **sign** round-trip on-chain — is *not* part
of this spec. It is a manual verification activity (see "Out of scope").

## Goals

- A per-source **Rescan** control that re-syncs a lock from **genesis** or a **custom block**.
- `addSource` **deduped by address**, plus a one-time migration that collapses existing dupes.
- The rescan host method is **generic** (script + block) so the Phase 2.5 import-treasuries
  rescan card can reuse it later.

## Non-goals (YAGNI)

- Wiring rescan into `TreasuryDetail` (treasuries) now — host method is reusable; UI deferred.
- Preset windows (30d / 90d). The chosen UX is genesis + custom-block only.
- Surfacing live sync *progress* (block height). We show a transient "rescanning" state and let
  the existing balance refresh pick up cells as they sync.

## Architecture

### 1. Light-client host — `lib/light-client/host.ts`

The light client runs in the **renderer** (WASM, behind COOP/COEP); `SourceList` already calls
`lightClient().watchLockScriptFromRecent(...)` directly, so the new method needs **no IPC**.

```ts
/**
 * Force a fresh filter-sync of an already-watched lock from `fromBlock`.
 * Delete + re-add because setScripts(Partial) will NOT lower an existing
 * cursor — re-watching is a documented no-op upstream. Delete clears the
 * persisted IndexedDB cursor; the Partial re-add registers it at `fromBlock`.
 */
async rescanLockFromBlock(script: ScriptLike, fromBlock: bigint): Promise<void> {
  await this.requireClient().setScripts(
    [{ script, scriptType: "lock", blockNumber: 0n }],
    LightClientSetScriptsCommand.Delete,
  );
  await this.watchLockScript(script, fromBlock);
}
```

`LightClientSetScriptsCommand.Delete === 2` is confirmed present in
`@nervosnetwork/ckb-light-client-js`. `fromBlock = 0n` ⇒ genesis (complete, slower); the
custom path passes the user-entered block.

### 2. UI — `features/send/SourceList.tsx`

A new `RescanControl` (own file `features/send/RescanControl.tsx`) renders on each source row,
beside Remove:

```
┌─ Source: ckt1qxy…  (Local: ckt1qxy…)    ┐
│ [Rescan ▾]  [Remove]                    │
│  ├ From genesis  (complete, slower)     │
│  └ From block: [_________]  [Go]        │
│  ⟳ Rescanning from 0 — balance updates  │
│    as the light client syncs.           │
└─────────────────────────────────────────┘
```
(`SourceList` rows show label + address + actions today, **not** a live balance — balance is
read in `SendPanel` on selection. The rescan control adds the disclosure + a transient status
line; it does not add a row balance.)

Behaviour:
- Resolves the lock `Script` by parsing the source's stored `address`
  (`Address.fromString(source.address, client).script`) — the same call `handleConnect` already
  uses. This is kind-agnostic: a CKB address encodes the full lock script, so it works uniformly
  for JoyID and secp256k1 sources with no per-`lockKind` branching.
- **From genesis** → `rescanLockFromBlock(lock, 0n)`. **From block** → validate input, then
  `rescanLockFromBlock(lock, BigInt(input))`.
- On success: show a **persistent status line** — *"Rescanning from block N — balance updates
  as the light client syncs (can take minutes from genesis)."* No immediate balance read: a
  fresh filter-sync is not complete on return, so reading balance now would still show ~0 and
  mislead. The corrected balance surfaces in `SendPanel` when the source is next selected, exactly
  as it does today. The genesis/Go buttons disable while the `rescanLockFromBlock` call is
  in flight (sub-second) and re-enable on settle.
- Non-destructive (re-registers a watch only) → no confirmation modal; the status line itself
  conveys that genesis is complete-but-slower on a busy lock.

### 3. Dedup — `stores/sources.ts`

- **Guard:** `addSource(src)` returns early (no append, no state change) when
  `sources.some(s => s.address === src.address)`. Address is the dedup key: CKB addresses are
  network-prefixed (`ckb1…` / `ckt1…`), so an address fully and uniquely identifies a lock on a
  network. Connect/keystore handlers still call `watchLockScriptFromRecent` after `addSource`,
  so a repeat Connect harmlessly re-syncs the existing source.
- **Migration `version: 1 → 2`:** in the persist `migrate`, dedupe `sources` by `address`
  keeping the entry with the **oldest** `createdAt`; if `activeSourceId` referenced a dropped
  duplicate, repoint it to the surviving entry for that address. Pure, total, no throw on
  empty/legacy state. Written in the **same commit** as the `version` bump.

## Data flow

```
Connect / Use-as-source ──> addSource (guarded by address) ──> watchLockScriptFromRecent
                                                                       │
User clicks Rescan (genesis | block N) ─> rescanLockFromBlock ─> setScripts(Delete)
                                                                 + watchLockScript(N)
                                                                       │
                LC filter-syncs cells from block N (background, minutes from genesis)
                                                                       │
   corrected balance shown in SendPanel on next source selection (getLockBalance), as today
```

## Error handling

- Invalid custom block (empty / NaN / negative / `> tip`) → inline field error; **no** host
  call. Tip is read via `getTipHeader()` for the upper bound.
- `rescanLockFromBlock` throws (LC not ready, setScripts error) → transient error shown on the
  row, control re-enabled, error logged with context. Never silently swallowed.
- Migration handles missing/empty `sources` and a null `activeSourceId` without throwing.

## Testing (TDD, write tests first)

| File | Cases |
|------|-------|
| `lib/light-client/host.test.ts` | `rescanLockFromBlock` calls `setScripts([..], Delete)` then `watchLockScript(script, N)` — assert call order + args via a mock client; genesis passes `0n`. |
| `stores/sources.test.ts` | addSource appends a new address; **addSource ignores a duplicate address (existing kept, active unchanged)**; v1→v2 migration collapses dupes keeping oldest `createdAt`; migration repoints `activeSourceId` off a dropped dupe. |
| `features/send/SourceList.test.tsx` (or `RescanControl.test.tsx`) | genesis click → `rescanLockFromBlock(lock, 0n)`; valid custom block → parsed `bigint` passed; invalid block → no host call + field error; control disabled while in flight. |

Target ≥ 80% on touched units; matches the repo's existing `host` / `sources` / `SourceList`
test files (the explorer confirmed `sources.test.ts` currently has **no** dedup test — this
closes that gap).

## Out of scope — relay-sign on-chain smoke (Thread 2)

After this feature merges, manually verify the JoyID relay **sign** path end-to-end: build a
real testnet payment through `lib/send/build-and-send.ts` (`buildAndSend`) with a
`JoyIdRelaySigner`, approve on the phone via the relay QR, and confirm the resulting tx hash on
a testnet explorer. Only relay *connect* and *keystore send* have on-chain proof today. This is
verification, not implementation; if it surfaces a bug, that becomes its own fix.

## Rollout

Single feature branch `feat/send-source-rescan-dedup`, one PR onto `main`. No stacking this
time — independent of the now-merged #15/#16/#17.
