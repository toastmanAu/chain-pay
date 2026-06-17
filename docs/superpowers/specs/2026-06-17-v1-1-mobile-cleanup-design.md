# v1.1 mobile cleanup — design

**Date:** 2026-06-17
**Status:** approved (brainstorming) → spec
**Scope:** `apps/mobile` only. No native (iOS/Android) code. One polish PR.
**Origin:** four findings from the 2026-06-17 Galaxy A53 device smoke (recorded on PR #12 comment + memory `mobile-drain-debugging-traps`).

## Background

The A53 smoke that verified PR #12 (`83067d0`) surfaced four non-blocking issues. None affect correctness of the merged features; all are polish. This spec covers fixing them as a single focused PR before Phase 5 (Frappe accounting bridge) work begins.

The key realization during smoke: the mobile sync transport already has a fully-built, tested `healthCheck(pairing): Promise<boolean>` (`lib/transport/ip-client.ts:46`) that performs a pinned GET to the desktop's health route — it simply is not wired into the UI. So the most user-visible finding is mostly a wiring + polling-strategy task, not new transport code.

## Findings → fixes

### 1. "Connected" banner reflects stored pairing, not live reachability

**Problem.** `app/index.tsx` drives the status banner purely off `pairing !== null` (+ `wasAutoCleared`). It shows green "Connected" whenever a pairing record exists — even when the desktop sync server is down. During smoke, the phone showed "Connected" while `:8233` was dead and a capture silently retried into a closed socket.

**Fix — active poll.**
- New hook `lib/useDesktopReachability.ts`:
  - Signature: `useDesktopReachability(pairing: PairingPayload | null): boolean | null`
  - Returns `reachable`: `true` (last check ok), `false` (last check failed), `null` (no check yet / unpaired).
  - While `pairing != null` and the Home screen is focused (expo-router `useFocusEffect`), calls `healthCheck(pairing)`:
    - immediately on focus, then
    - every `REACHABILITY_POLL_MS = 10_000`.
  - Clears the interval on blur, on unpair, and on unmount.
  - A `healthCheck` that throws is treated as `false` (offline), never an unhandled rejection.
- `app/index.tsx` banner state derived from `paired` + `reachable`:
  - `paired && reachable === true` → "Connected" (green `statusOk`) — unchanged.
  - `paired && reachable === false` → **"Desktop offline"** (amber `statusWarn`); detail still shows `desktopHost` so the user knows which desktop is unreachable.
  - `paired && reachable === null` → render as "Connected" (avoid a startup flash before the first probe resolves).
  - `!paired` → existing "Not paired" / "Re-pair required" (`wasAutoCleared`) behavior, unchanged.

**Tests** (`lib/useDesktopReachability.test.ts`, mocking `healthCheck`):
- resolves `true` → hook reports online.
- resolves `false` or rejects → hook reports offline (no unhandled rejection).
- `pairing === null` → never calls `healthCheck`, returns `null`.

### 2. `markSynced` leaves a stale `lastError`

**Problem.** `stores/sync-queue.ts:69` `markSynced` sets only `status` + `syncedInvoiceId`. An item that failed N times before succeeding keeps its old `lastError` (e.g. "Failed to connect…"), so a synced item looks like it errored.

**Fix.** In `markSynced`, also set `lastError: undefined`. Keep `attempts` (see finding 3).

**Test** (`stores/sync-queue.test.ts`): an item with a prior `lastError`, after `markSynced`, has `status === "synced"`, the `syncedInvoiceId` set, and `lastError === undefined`.

### 3. `attempts` never resets on success — no change

**Decision.** Leave `attempts` as-is. A synced item is terminal (never re-drained), so a non-zero count is harmless and serves as useful "this was flaky" history. Recorded here as a deliberate decision so it is not re-flagged as a bug later. No code change, no test change.

### 4. Orphaned cache images accrue with no reconciler

**Problem.** `clearRejected` / `removeSynced` only delete images for items being removed *at that moment*. Capture images that lose their queue item by any other path (historical, pre-feature, or a future imageRef↔filename mismatch swallowed by `deleteImagesFromCache`'s empty catch) are never reclaimed. Smoke found two orphaned `cache/capture-*.jpg` predating the feature.

**Fix — conservative sweep.** New module `lib/reconcile-orphans.ts`:
- `reconcileOrphanImages(): void`
  - List `Paths.cache` for entries whose name matches `capture-*.jpg`.
  - Build `referenced = new Set(queue.items.map(i => i.imageRef))`.
  - For each `capture-*.jpg` file: if `!referenced.has(name)` **and** `Date.now() - file.modificationTime > ORPHAN_MIN_AGE_MS` (`ORPHAN_MIN_AGE_MS = 5 * 60_000`), delete it via the existing `deleteImagesFromCache([name])`.
  - The age guard protects the capture→enqueue window: a just-written file not yet in the queue is younger than 5 min and is never deleted.
  - Best-effort: any per-file error (stat/list) is swallowed; a missing/locked file must not block the sweep.
  - Expo scratch dirs (`cache/Camera/`, `cache/ImageManipulator/`) are **out of scope** — framework-owned, not our naming.
- Wiring: call `reconcileOrphanImages()` from `useDrainQueue`'s existing purge effect (alongside the `removeSynced` purge) — once on mount and on the existing hourly `PURGE_INTERVAL_MS` timer. No new timer.

**Tests** (`lib/reconcile-orphans.test.ts`, mocking expo-file-system `Directory.list` / `File.info` / `File.delete` and the queue store):
- unreferenced `capture-*.jpg` with mtime older than threshold → deleted.
- unreferenced `capture-*.jpg` with fresh mtime → kept (race guard).
- referenced `capture-*.jpg` → kept regardless of age.
- non-`capture-*` files / scratch dirs → never touched.

## Architecture & boundaries

Two new small, independently-testable modules; existing files get minimal edits:

| Unit | Purpose | Depends on |
|---|---|---|
| `lib/useDesktopReachability.ts` (new, ~40 lines) | Poll desktop health while Home focused; expose `reachable` | `healthCheck`, expo-router `useFocusEffect` |
| `lib/reconcile-orphans.ts` (new, ~40 lines) | Delete unreferenced+aged `capture-*.jpg` | `Paths`/`Directory`/`File` (expo-file-system), `useSyncQueue`, `deleteImagesFromCache` |
| `app/index.tsx` (edit) | 3rd banner state from `paired` + `reachable` | `useDesktopReachability` |
| `stores/sync-queue.ts` (edit, 1 line) | `markSynced` clears `lastError` | — |
| `lib/useDrainQueue.ts` (edit, 1 line) | Call `reconcileOrphanImages()` in purge effect | `reconcile-orphans` |

## Constraints & risks

- **Expo SDK 56 FS API must be verified, not assumed.** `apps/mobile/AGENTS.md` mandates reading `https://docs.expo.dev/versions/v56.0.0/` before writing FS code. Confirm the exact `Directory.list()` shape and the `File.info()` field carrying modification time (e.g. `modificationTime`) before implementing finding 4; adapt the spec's field names to the real API.
- Immutable store updates preserved (spread, no mutation) per coding-style rule.
- No native code, so no device rebuild required to test — JS-only, loads over Metro. Unit tests via existing vitest setup; manual device re-smoke is optional (low risk) but the reachability banner is worth one A53 eyeball since it's UI.

## Out of scope

- Roadmap renumbering (`docs/mvp-roadmap.md` mobile-vs-Frappe phase mismatch) — tracked separately.
- Phase 5 (Frappe accounting bridge).
- iOS device smoke (deferred: no Mac access).
- Any change to expo scratch-dir cleanup.

## Success criteria

- Home banner shows "Desktop offline" (amber) within ~10s of the desktop sync server going down while paired, and returns to "Connected" within ~10s of it coming back.
- A synced queue item carries no `lastError`.
- Unreferenced aged `capture-*.jpg` files are reclaimed on the hourly purge; in-flight captures are never deleted.
- All new logic unit-tested; `npx vitest run` and `npx tsc --noEmit` green in `apps/mobile`.
