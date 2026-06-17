# v1.1 Mobile Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four non-blocking findings from the 2026-06-17 Galaxy A53 smoke — banner reachability, stale `lastError`, orphan-image reconciler — as one polish PR.

**Architecture:** Two new pure-logic modules (`desktop-reachability.ts`, `reconcile-orphans.ts`) are unit-tested; a thin hook (`useDesktopReachability.ts`) and the Home banner consume them as untested glue (matching the repo's convention: logic in `.test.ts`, screens/hooks untested). The existing `healthCheck()` transport function is reused as-is.

**Tech Stack:** Expo SDK 56, React 19, expo-router, Zustand, expo-file-system (new sync `File`/`Directory`/`Paths` API), Vitest (jsdom).

## Global Constraints

- All work in `apps/mobile`. No native (iOS/Android/Kotlin/Swift) code.
- Expo SDK 56 only. `expo-file-system` is `56.0.7`; use the **new sync API** (`File`, `Directory`, `Paths`) — `Directory.list(): (File | Directory)[]`, `File.info(): FileInfo` (sync; `modificationTime?: number`, ms since epoch), `File.delete(): void`, `File.name`.
- `expo-router` exports `useFocusEffect(effect)` — single-callback form, must wrap the callback in `useCallback`.
- Immutable store updates only (spread, no mutation) per coding-style rule.
- Tests are `.test.ts` (NOT `.tsx`); `vitest.config.ts` includes only `lib/**` and `stores/**`. No React rendering in tests.
- Run commands from `apps/mobile`. Suite: `npx vitest run`. Types: `npx tsc --noEmit`.
- Spec: `docs/superpowers/specs/2026-06-17-v1-1-mobile-cleanup-design.md`.

---

### Task 1: `markSynced` clears `lastError` (finding 2)

**Files:**
- Modify: `apps/mobile/stores/sync-queue.ts:69-75`
- Test: `apps/mobile/stores/sync-queue.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `markSynced(id, invoiceId)` now also sets `lastError: undefined`; `attempts` unchanged.

- [ ] **Step 1: Write the failing test** — append inside the `describe("sync-queue", ...)` block in `apps/mobile/stores/sync-queue.test.ts`:

```ts
  it("markSynced clears stale lastError but keeps attempts", () => {
    const id = useSyncQueue.getState().enqueue(sample);
    useSyncQueue.getState().markFailed(id, "Failed to connect");
    useSyncQueue.getState().markSynced(id, "inv_ok");
    const item = useSyncQueue.getState().findById(id)!;
    expect(item.status).toBe("synced");
    expect(item.syncedInvoiceId).toBe("inv_ok");
    expect(item.lastError).toBeUndefined();
    expect(item.attempts).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx vitest run stores/sync-queue.test.ts`
Expected: FAIL — `lastError` is `"Failed to connect"`, not `undefined`.

- [ ] **Step 3: Write minimal implementation** — in `apps/mobile/stores/sync-queue.ts`, replace the `markSynced` body (currently lines ~69-75):

```ts
  markSynced: (id, invoiceId) => {
    const items = get().items.map((i) =>
      i.id === id
        ? { ...i, status: "synced" as const, syncedInvoiceId: invoiceId, lastError: undefined }
        : i,
    );
    save(items);
    set({ items });
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx vitest run stores/sync-queue.test.ts`
Expected: PASS (all sync-queue tests green, including the existing `markSyncing then markSynced` one).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/stores/sync-queue.ts apps/mobile/stores/sync-queue.test.ts
git commit -m "fix(mobile): clear stale lastError on markSynced"
```

---

### Task 2: `checkReachability` core (finding 1 logic)

**Files:**
- Create: `apps/mobile/lib/desktop-reachability.ts`
- Test: `apps/mobile/lib/desktop-reachability.test.ts`

**Interfaces:**
- Consumes: `healthCheck(pairing: PairingPayload): Promise<boolean>` from `@/lib/transport/ip-client`; `PairingPayload` type from `@/stores/pairing`.
- Produces: `checkReachability(pairing: PairingPayload | null): Promise<boolean | null>` — `null` when unpaired (no network call), `false` on `healthCheck` throw or false, `true` when reachable.

- [ ] **Step 1: Write the failing test** — create `apps/mobile/lib/desktop-reachability.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/transport/ip-client", () => ({ healthCheck: vi.fn() }));
import { healthCheck } from "@/lib/transport/ip-client";
import { checkReachability } from "./desktop-reachability";

const pairing = {
  rpc_url: "https://192.168.68.102:8233",
  auth_token: "t",
  cert_fingerprint: "f",
  desktop_comm_pubkey: "k",
};

describe("checkReachability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null and skips healthCheck when unpaired", async () => {
    expect(await checkReachability(null)).toBe(null);
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it("returns true when healthCheck resolves true", async () => {
    vi.mocked(healthCheck).mockResolvedValue(true);
    expect(await checkReachability(pairing)).toBe(true);
  });

  it("returns false when healthCheck resolves false", async () => {
    vi.mocked(healthCheck).mockResolvedValue(false);
    expect(await checkReachability(pairing)).toBe(false);
  });

  it("returns false (not a throw) when healthCheck rejects", async () => {
    vi.mocked(healthCheck).mockRejectedValue(new Error("network"));
    expect(await checkReachability(pairing)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx vitest run lib/desktop-reachability.test.ts`
Expected: FAIL — cannot resolve `./desktop-reachability`.

- [ ] **Step 3: Write minimal implementation** — create `apps/mobile/lib/desktop-reachability.ts`:

```ts
import { healthCheck } from "@/lib/transport/ip-client";
import type { PairingPayload } from "@/stores/pairing";

/**
 * Returns desktop reachability for the Home banner.
 * - null  → not paired (no probe attempted)
 * - true  → desktop answered the pinned health check
 * - false → unreachable (health check failed or threw)
 */
export async function checkReachability(pairing: PairingPayload | null): Promise<boolean | null> {
  if (!pairing) return null;
  try {
    return await healthCheck(pairing);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx vitest run lib/desktop-reachability.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/desktop-reachability.ts apps/mobile/lib/desktop-reachability.test.ts
git commit -m "feat(mobile): checkReachability core for desktop health"
```

---

### Task 3: `useDesktopReachability` hook + Home banner (finding 1 glue)

**Files:**
- Create: `apps/mobile/lib/useDesktopReachability.ts`
- Modify: `apps/mobile/app/index.tsx`

**Interfaces:**
- Consumes: `checkReachability` from `@/lib/desktop-reachability`; `useFocusEffect` from `expo-router`; `PairingPayload` from `@/stores/pairing`.
- Produces: `useDesktopReachability(pairing: PairingPayload | null): boolean | null`; constant `REACHABILITY_POLL_MS = 10_000`.

This task is untested glue (consistent with the repo: no screen/hook render tests). Verification is `tsc` + full suite staying green.

- [ ] **Step 1: Create the hook** — `apps/mobile/lib/useDesktopReachability.ts`:

```ts
import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { checkReachability } from "@/lib/desktop-reachability";
import type { PairingPayload } from "@/stores/pairing";

export const REACHABILITY_POLL_MS = 10_000;

/**
 * While the screen is focused and paired, polls the desktop health endpoint
 * (immediately, then every REACHABILITY_POLL_MS). Returns:
 *   null  → unpaired / first probe not yet resolved
 *   true  → reachable, false → unreachable
 */
export function useDesktopReachability(pairing: PairingPayload | null): boolean | null {
  const [reachable, setReachable] = useState<boolean | null>(null);
  const pairingRef = useRef(pairing);
  pairingRef.current = pairing;

  useFocusEffect(
    useCallback(() => {
      if (!pairing) {
        setReachable(null);
        return;
      }
      let cancelled = false;
      const probe = async (): Promise<void> => {
        const r = await checkReachability(pairingRef.current);
        if (!cancelled) setReachable(r);
      };
      void probe();
      const id = setInterval(() => void probe(), REACHABILITY_POLL_MS);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
    }, [pairing]),
  );

  return reachable;
}
```

- [ ] **Step 2: Wire into the Home banner** — in `apps/mobile/app/index.tsx`:

(a) Add the import near the other `@/lib` imports:

```ts
import { useDesktopReachability } from "@/lib/useDesktopReachability";
```

(b) After the existing `const paired = pairing !== null;` line, add:

```ts
  const reachable = useDesktopReachability(pairing);
  const offline = paired && reachable === false;
```

(c) Replace the status card opening `<View ...>` style expression — change `paired ? styles.statusOk : styles.statusWarn` to:

```tsx
        <View style={[styles.statusCard, paired && !offline ? styles.statusOk : styles.statusWarn]}>
```

(d) Replace the status badge `<Text>` content:

```tsx
          <Text style={styles.statusBadge}>{paired ? (offline ? "Desktop offline" : "Connected") : wasAutoCleared ? "Re-pair required" : "Not paired"}</Text>
```

(The `statusDetail` line is unchanged — it still shows `desktopHost` when paired, so the host appears under both "Connected" and "Desktop offline".)

- [ ] **Step 3: Verify types and full suite**

Run: `cd apps/mobile && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests pass (48 + Task 1's new test + Task 2's 4 = 53).

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/lib/useDesktopReachability.ts apps/mobile/app/index.tsx
git commit -m "feat(mobile): Home banner shows 'Desktop offline' via health poll"
```

---

### Task 4: `reconcileOrphanImages` core (finding 4 logic)

**Files:**
- Create: `apps/mobile/lib/reconcile-orphans.ts`
- Test: `apps/mobile/lib/reconcile-orphans.test.ts`

**Interfaces:**
- Consumes: `File`, `Directory`, `Paths` from `expo-file-system`; `useSyncQueue` from `@/stores/sync-queue`.
- Produces: `reconcileOrphanImages(now?: number): string[]` (returns deleted filenames); constant `ORPHAN_MIN_AGE_MS = 5 * 60_000`.

- [ ] **Step 1: Write the failing test** — create `apps/mobile/lib/reconcile-orphans.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockState, queueState } = vi.hoisted(() => ({
  mockState: { entries: [] as unknown[] },
  queueState: { items: [] as { imageRef: string }[] },
}));

vi.mock("expo-file-system", () => {
  class File {
    name: string;
    _mtime: number | undefined;
    deleted = false;
    constructor(name = "", mtime?: number) {
      this.name = name;
      this._mtime = mtime;
    }
    info(): { exists: boolean; modificationTime: number | undefined } {
      return { exists: true, modificationTime: this._mtime };
    }
    delete(): void {
      this.deleted = true;
    }
  }
  class Directory {
    constructor(_p?: unknown) {}
    list(): unknown[] {
      return mockState.entries;
    }
  }
  return { File, Directory, Paths: { cache: "/cache" } };
});

vi.mock("@/stores/sync-queue", () => ({
  useSyncQueue: { getState: () => ({ items: queueState.items }) },
}));

import { File } from "expo-file-system";
import { reconcileOrphanImages, ORPHAN_MIN_AGE_MS } from "./reconcile-orphans";

const NOW = 1_700_000_000_000;
const makeEntry = (name: string, mtime?: number): InstanceType<typeof File> =>
  new (File as unknown as new (n: string, m?: number) => InstanceType<typeof File>)(name, mtime);

beforeEach(() => {
  mockState.entries = [];
  queueState.items = [];
});

describe("reconcileOrphanImages", () => {
  it("deletes unreferenced capture-*.jpg older than the threshold", () => {
    const old = makeEntry("capture-1.jpg", NOW - ORPHAN_MIN_AGE_MS - 1);
    mockState.entries = [old];
    expect(reconcileOrphanImages(NOW)).toEqual(["capture-1.jpg"]);
    expect((old as unknown as { deleted: boolean }).deleted).toBe(true);
  });

  it("keeps a fresh unreferenced capture (race guard)", () => {
    const fresh = makeEntry("capture-2.jpg", NOW - 1000);
    mockState.entries = [fresh];
    expect(reconcileOrphanImages(NOW)).toEqual([]);
    expect((fresh as unknown as { deleted: boolean }).deleted).toBe(false);
  });

  it("keeps a referenced capture regardless of age", () => {
    const ref = makeEntry("capture-3.jpg", NOW - ORPHAN_MIN_AGE_MS - 1);
    mockState.entries = [ref];
    queueState.items = [{ imageRef: "capture-3.jpg" }];
    expect(reconcileOrphanImages(NOW)).toEqual([]);
    expect((ref as unknown as { deleted: boolean }).deleted).toBe(false);
  });

  it("keeps a capture with unknown modificationTime", () => {
    const noMtime = makeEntry("capture-4.jpg", undefined);
    mockState.entries = [noMtime];
    expect(reconcileOrphanImages(NOW)).toEqual([]);
  });

  it("ignores non-capture files", () => {
    const other = makeEntry("notes.txt", NOW - ORPHAN_MIN_AGE_MS - 1);
    mockState.entries = [other];
    expect(reconcileOrphanImages(NOW)).toEqual([]);
    expect((other as unknown as { deleted: boolean }).deleted).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx vitest run lib/reconcile-orphans.test.ts`
Expected: FAIL — cannot resolve `./reconcile-orphans`.

- [ ] **Step 3: Write minimal implementation** — create `apps/mobile/lib/reconcile-orphans.ts`:

```ts
import { File, Directory, Paths } from "expo-file-system";
import { useSyncQueue } from "@/stores/sync-queue";

export const ORPHAN_MIN_AGE_MS = 5 * 60_000;
const CAPTURE_RE = /^capture-.*\.jpg$/;

/**
 * Deletes capture images in the cache that no queue item references AND whose
 * mtime is older than ORPHAN_MIN_AGE_MS (so a just-captured, not-yet-enqueued
 * file is never removed). Best-effort: any per-file/list error is swallowed.
 * Returns the names of deleted files. `now` is injectable for tests.
 */
export function reconcileOrphanImages(now: number = Date.now()): string[] {
  const referenced = new Set(useSyncQueue.getState().items.map((i) => i.imageRef));
  const deleted: string[] = [];

  let entries: (File | Directory)[];
  try {
    entries = new Directory(Paths.cache).list();
  } catch {
    return deleted;
  }

  for (const entry of entries) {
    if (!(entry instanceof File)) continue;
    const name = entry.name;
    if (!CAPTURE_RE.test(name)) continue;
    if (referenced.has(name)) continue;

    let mtime: number | undefined;
    try {
      mtime = entry.info().modificationTime ?? undefined;
    } catch {
      continue;
    }
    if (typeof mtime !== "number") continue; // unknown age → keep
    if (now - mtime <= ORPHAN_MIN_AGE_MS) continue; // too fresh → keep

    try {
      entry.delete();
      deleted.push(name);
    } catch {
      // best-effort
    }
  }

  return deleted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx vitest run lib/reconcile-orphans.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/reconcile-orphans.ts apps/mobile/lib/reconcile-orphans.test.ts
git commit -m "feat(mobile): reconcileOrphanImages sweeps unreferenced cache captures"
```

---

### Task 5: Wire reconciler into the drain purge (finding 4 glue)

**Files:**
- Modify: `apps/mobile/lib/useDrainQueue.ts:78-96` (the purge `useEffect`)

**Interfaces:**
- Consumes: `reconcileOrphanImages` from `@/lib/reconcile-orphans`.
- Produces: nothing new (side effect: orphan sweep runs on mount + hourly).

Untested glue; verification is `tsc` + full suite green. Reuses the existing `PURGE_INTERVAL_MS` timer — no new interval.

- [ ] **Step 1: Add the import** — near the top of `apps/mobile/lib/useDrainQueue.ts`, after the existing `import { runDrainOnce } from "@/lib/transport";` line:

```ts
import { reconcileOrphanImages } from "@/lib/reconcile-orphans";
```

- [ ] **Step 2: Call the reconciler inside the existing `purge` function** — in the purge `useEffect` (currently around lines 79-91), add the reconcile call at the end of the `purge` closure, just before its closing brace:

```ts
    const purge = (): void => {
      const refs = queue.getState().removeSynced(IMAGE_CACHE_RETENTION_MS);
      deleteImagesFromCache(refs);
      if (cacheBytes() > IMAGE_CACHE_LIMIT_BYTES) {
        const allSynced = queue.getState().items.filter((i) => i.status === "synced");
        if (allSynced.length > 0) {
          const moreRefs = queue.getState().removeSynced(0);
          deleteImagesFromCache(moreRefs);
        }
      }
      reconcileOrphanImages();
    };
```

- [ ] **Step 3: Verify types and full suite**

Run: `cd apps/mobile && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests pass (53 + Task 4's 5 = 58).

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/lib/useDrainQueue.ts
git commit -m "feat(mobile): run orphan-image reconciler on the hourly purge"
```

---

### Task 6: Final verification + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Full green check**

Run: `cd apps/mobile && npx vitest run && npx tsc --noEmit`
Expected: all tests pass, tsc clean.

- [ ] **Step 2: (Optional, low-risk) device eyeball of the banner**

With desktop sync server up + A53 connected over Metro: confirm Home shows "Connected" (green); stop the desktop server, confirm it flips to "Desktop offline" (amber) within ~10s; restart, confirm it returns to "Connected". JS-only change — no rebuild needed.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin polish/mobile-v1-1-cleanup
gh pr create --title "polish(mobile): v1.1 cleanup — banner reachability + markSynced + orphan reconciler" --body "$(cat <<'EOF'
## Summary
Closes the 4 non-blocking findings from the 2026-06-17 Galaxy A53 smoke (see PR #12 comment).

- **Banner reachability:** new `useDesktopReachability` polls the existing `healthCheck()` while Home is focused; banner shows "Desktop offline" (amber) when the paired desktop is unreachable, instead of always-green "Connected".
- **markSynced** clears stale `lastError` (kept `attempts` as flaky-history).
- **Orphan reconciler:** `reconcileOrphanImages()` sweeps unreferenced `capture-*.jpg` older than 5min on the existing hourly purge (race-guarded against in-flight captures).
- `attempts` reset: deliberately left as-is (documented).

Spec: `docs/superpowers/specs/2026-06-17-v1-1-mobile-cleanup-design.md`

## Test plan
- [ ] `cd apps/mobile && npx vitest run` — green (58 tests)
- [ ] `cd apps/mobile && npx tsc --noEmit` — clean
- [ ] No native code; JS-only, loads over Metro.
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Finding 1 (banner reachability) → Tasks 2 (core) + 3 (hook + banner). ✓
- Finding 2 (markSynced lastError) → Task 1. ✓
- Finding 3 (attempts — no change) → documented in Task 1 (keeps `attempts`) + spec. ✓
- Finding 4 (orphan reconciler) → Tasks 4 (core) + 5 (wiring). ✓
- Expo SDK 56 API constraint → Global Constraints + verified against `expo-file-system@56.0.7`. ✓

**Type consistency:** `checkReachability(pairing): Promise<boolean|null>` used identically in Task 2 (def) and Task 3 (hook). `reconcileOrphanImages(now?): string[]` consistent in Tasks 4 (def) and 5 (call, no arg → defaults to `Date.now()`). `REACHABILITY_POLL_MS`, `ORPHAN_MIN_AGE_MS` defined once. `markSynced` signature unchanged. ✓

**Placeholder scan:** none — every code/test step shows full content. ✓

**Deviation from spec, noted:** the spec said the reconciler would reuse `deleteImagesFromCache`; the plan instead deletes inline (`entry.delete()`) so `reconcile-orphans.ts` stays decoupled from `useDrainQueue.ts` (which imports `NetInfo` and would drag the whole drain machinery — incl. an unmocked native module — into the reconciler's test). Same behavior, better test isolation.
