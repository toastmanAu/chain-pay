# Send-source rescan + dedup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-source "Rescan from genesis / from block N" control and dedup send-sources by address (guard + one-time migration), so deep-history JoyID/imported wallets show correct balances and repeated Connect clicks stop creating duplicates.

**Architecture:** A pure `rescanLock(client, script, fromBlock)` helper issues `setScripts(Delete)` then `setScripts(Partial)` (re-watching can't lower an existing cursor); `LightClientHost.rescanLockFromBlock` is a thin delegate. Dedup is a pure `dedupeSourcesByAddress` reused by both the `addSource` guard and a persist `version 1→2` migration. A `RescanControl` component (with an injectable rescan fn + pure block validator) mounts on each `SourceList` row.

**Tech Stack:** TypeScript, React, Zustand (persist middleware), `@nervosnetwork/ckb-light-client-js`, `@ckb-ccc/core`, Vitest (+ Testing Library / jsdom).

## Global Constraints

- Immutability — never mutate, always return new objects/state.
- Files < 800 lines; functions < 50 lines; nesting ≤ 4.
- No `console.log` in production code.
- TDD: failing test first, minimal impl, frequent commits.
- Dedup key is the source **`address`** (CKB addresses are network-prefixed → fully identify a lock).
- Genesis rescan ⇒ `fromBlock = 0n`.
- Light client runs in the **renderer**; `rescanLockFromBlock` is called directly via `lightClient()` — **no IPC**.
- The persist `version` bump and its `migrate` function land in the **same commit**.
- Branch: `feat/send-source-rescan-dedup` (already created; spec at `docs/superpowers/specs/2026-06-30-send-source-rescan-dedup-design.md`).
- Run tests from `apps/desktop`: `npx vitest run <path>`.

---

### Task 1: Light-client rescan helper + host method

**Files:**
- Create: `apps/desktop/src/lib/light-client/rescan-lock.ts`
- Create: `apps/desktop/src/lib/light-client/rescan-lock.test.ts`
- Modify: `apps/desktop/src/lib/light-client/host.ts` (add `rescanLockFromBlock` method + import)

**Interfaces:**
- Produces: `rescanLock(client: SetScriptsClient, script: ScriptLike, fromBlock: bigint): Promise<void>` and `interface SetScriptsClient { setScripts(scripts: ScriptStatus[], command: LightClientSetScriptsCommand): Promise<unknown> }`.
- Produces: `LightClientHost.rescanLockFromBlock(script: ScriptLike, fromBlock: bigint): Promise<void>`.
- Consumes: `LightClientSetScriptsCommand` (`.Delete = 2`, `.Partial = 1`) and `ScriptStatus` from `@nervosnetwork/ckb-light-client-js`; `ScriptLike` from `@ckb-ccc/core`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/lib/light-client/rescan-lock.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { LightClientSetScriptsCommand } from "@nervosnetwork/ckb-light-client-js";
import { rescanLock } from "./rescan-lock";

const script = { codeHash: ("0x" + "11".repeat(32)) as `0x${string}`, hashType: "type" as const, args: ("0x" + "22".repeat(20)) as `0x${string}` };

describe("rescanLock", () => {
  it("deletes the stale cursor then re-adds the lock at fromBlock", async () => {
    const calls: Array<{ scripts: unknown; command: LightClientSetScriptsCommand }> = [];
    const client = {
      setScripts: vi.fn(async (scripts, command) => { calls.push({ scripts, command }); }),
    };

    await rescanLock(client, script, 12_345n);

    expect(client.setScripts).toHaveBeenCalledTimes(2);
    // First call: Delete
    expect(calls[0]?.command).toBe(LightClientSetScriptsCommand.Delete);
    expect(calls[0]?.scripts).toEqual([{ script, scriptType: "lock", blockNumber: 0n }]);
    // Second call: Partial re-add at fromBlock
    expect(calls[1]?.command).toBe(LightClientSetScriptsCommand.Partial);
    expect(calls[1]?.scripts).toEqual([{ script, scriptType: "lock", blockNumber: 12_345n }]);
  });

  it("re-adds at genesis (0n) for a from-genesis rescan", async () => {
    const client = { setScripts: vi.fn(async () => {}) };
    await rescanLock(client, script, 0n);
    expect(client.setScripts).toHaveBeenLastCalledWith(
      [{ script, scriptType: "lock", blockNumber: 0n }],
      LightClientSetScriptsCommand.Partial,
    );
  });

  it("does not re-add if the delete fails (no orphaned watch)", async () => {
    const client = { setScripts: vi.fn(async () => { throw new Error("delete boom"); }) };
    await expect(rescanLock(client, script, 5n)).rejects.toThrow("delete boom");
    expect(client.setScripts).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/light-client/rescan-lock.test.ts`
Expected: FAIL — `Cannot find module './rescan-lock'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/lib/light-client/rescan-lock.ts`:

```typescript
import {
  LightClientSetScriptsCommand,
  type ScriptStatus,
} from "@nervosnetwork/ckb-light-client-js";
import type { ScriptLike } from "@ckb-ccc/core";

export interface SetScriptsClient {
  setScripts(
    scripts: ScriptStatus[],
    command: LightClientSetScriptsCommand,
  ): Promise<unknown>;
}

/**
 * Force a fresh filter-sync of an already-watched lock from `fromBlock`.
 *
 * Delete + re-add, because `setScripts(Partial)` will NOT lower an existing
 * cursor — re-watching is a documented no-op upstream. The Delete clears the
 * persisted IndexedDB cursor; the Partial re-add registers the lock at
 * `fromBlock` (0n = genesis). If the Delete throws, we never re-add, so the
 * lock is left in its prior state rather than orphaned.
 */
export async function rescanLock(
  client: SetScriptsClient,
  script: ScriptLike,
  fromBlock: bigint,
): Promise<void> {
  await client.setScripts(
    [{ script, scriptType: "lock", blockNumber: 0n }],
    LightClientSetScriptsCommand.Delete,
  );
  await client.setScripts(
    [{ script, scriptType: "lock", blockNumber: fromBlock }],
    LightClientSetScriptsCommand.Partial,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/lib/light-client/rescan-lock.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the host delegate method**

In `apps/desktop/src/lib/light-client/host.ts`, add the import near the other `./recent-watch-block` import:

```typescript
import { rescanLock } from "./rescan-lock";
```

Then add this method to the `LightClientHost` class, immediately after `watchLockScriptFromRecent` (around line 175):

```typescript
  /**
   * Re-scan an already-watched lock from `fromBlock` (0n = genesis). Use when a
   * connected/imported wallet holds coins older than the fresh-wallet watch
   * margin and its balance reads low. Delegates to the pure `rescanLock` helper.
   */
  async rescanLockFromBlock(script: ScriptLike, fromBlock: bigint): Promise<void> {
    await rescanLock(this.requireClient(), script, fromBlock);
  }
```

- [ ] **Step 6: Verify the whole light-client suite + types still pass**

Run: `cd apps/desktop && npx vitest run src/lib/light-client/ && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/lib/light-client/rescan-lock.ts apps/desktop/src/lib/light-client/rescan-lock.test.ts apps/desktop/src/lib/light-client/host.ts
git commit -m "feat(light-client): rescanLockFromBlock (delete + re-add at block N)"
```

---

### Task 2: Dedup sources by address — guard + v1→v2 migration

**Files:**
- Modify: `apps/desktop/src/stores/sources.ts` (export `dedupeSourcesByAddress`, guard `addSource`, bump `version` to 2 + `migrate`)
- Modify: `apps/desktop/src/stores/sources.test.ts` (add guard + dedupe + migration tests)

**Interfaces:**
- Produces: `dedupeSourcesByAddress(sources: Source[], activeSourceId: string | null): { sources: Source[]; activeSourceId: string | null }`.
- Consumes: `Source` from `@chain-pay/shared` (fields used: `id`, `address`, `createdAt`).
- Behaviour change: `addSource(s)` is a no-op when a source with the same `address` already exists.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/stores/sources.test.ts` (inside the existing `describe("useSourcesStore", …)` block, after the last `it`). Also add the `dedupeSourcesByAddress` import at the top alongside the existing imports:

At the top, change the import line to also import the helper (note: it comes from `./sources`, imported lazily in tests via `await import` like the store — so add a dedicated describe that imports it):

```typescript
  it("ignores addSource for an address that already exists (keeps the original)", async () => {
    const { useSourcesStore } = await import("./sources");
    const first = makeSource("a"); // address ckt1qa
    const dupAddr = { ...makeSource("b"), address: first.address }; // same address, different id
    useSourcesStore.getState().addSource(first);
    useSourcesStore.getState().addSource(dupAddr);
    const s = useSourcesStore.getState();
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]?.id).toBe("a");
    expect(s.activeSourceId).toBe("a");
  });

  it("still adds sources with distinct addresses", async () => {
    const { useSourcesStore } = await import("./sources");
    useSourcesStore.getState().addSource(makeSource("a")); // ckt1qa
    useSourcesStore.getState().addSource(makeSource("b")); // ckt1qb
    expect(useSourcesStore.getState().sources).toHaveLength(2);
  });
```

Then add a separate `describe` block at the end of the file for the pure helper and migration:

```typescript
describe("dedupeSourcesByAddress", () => {
  it("collapses duplicates by address keeping the oldest createdAt", async () => {
    const { dedupeSourcesByAddress } = await import("./sources");
    const older: Source = { ...makeSource("old"), address: "ckt1qdup", createdAt: "2026-06-01T00:00:00Z" };
    const newer: Source = { ...makeSource("new"), address: "ckt1qdup", createdAt: "2026-06-29T00:00:00Z" };
    const solo: Source = { ...makeSource("solo"), address: "ckt1qsolo" };
    const { sources } = dedupeSourcesByAddress([newer, older, solo], "new");
    expect(sources.map((s) => s.id).sort()).toEqual(["old", "solo"]);
  });

  it("repoints activeSourceId to the surviving entry when the active one was dropped", async () => {
    const { dedupeSourcesByAddress } = await import("./sources");
    const older: Source = { ...makeSource("old"), address: "ckt1qdup", createdAt: "2026-06-01T00:00:00Z" };
    const newer: Source = { ...makeSource("new"), address: "ckt1qdup", createdAt: "2026-06-29T00:00:00Z" };
    const { activeSourceId } = dedupeSourcesByAddress([older, newer], "new");
    expect(activeSourceId).toBe("old"); // "new" dropped → repoint to same-address survivor
  });

  it("leaves a still-present activeSourceId untouched", async () => {
    const { dedupeSourcesByAddress } = await import("./sources");
    const a: Source = { ...makeSource("a"), address: "ckt1qa" };
    const b: Source = { ...makeSource("b"), address: "ckt1qb" };
    const { activeSourceId } = dedupeSourcesByAddress([a, b], "b");
    expect(activeSourceId).toBe("b");
  });

  it("handles empty input and null active without throwing", async () => {
    const { dedupeSourcesByAddress } = await import("./sources");
    expect(dedupeSourcesByAddress([], null)).toEqual({ sources: [], activeSourceId: null });
  });

  it("migrates persisted v1 state by collapsing duplicates on load", async () => {
    // Seed a v1 persisted payload with two same-address entries before import.
    const dup = (id: string, createdAt: string) => ({
      id, label: `w ${id}`, chain: "ckb:testnet", address: "ckt1qmig",
      joyidLockArgs: "0x" + "11".repeat(20), createdAt, updatedAt: createdAt,
    });
    const v1 = {
      state: { sources: [dup("new", "2026-06-29T00:00:00Z"), dup("old", "2026-06-01T00:00:00Z")], activeSourceId: "new" },
      version: 1,
    };
    globalThis.localStorage?.setItem("chain-pay:sources", JSON.stringify(v1));
    vi.resetModules();
    const { useSourcesStore } = await import("./sources");
    const s = useSourcesStore.getState();
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]?.id).toBe("old");
    expect(s.activeSourceId).toBe("old");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && npx vitest run src/stores/sources.test.ts`
Expected: FAIL — `dedupeSourcesByAddress` is not exported; the guard tests fail (current `addSource` appends the duplicate → length 2).

- [ ] **Step 3: Implement the helper, guard, and migration**

Replace `apps/desktop/src/stores/sources.ts` with:

```typescript
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Source } from "@chain-pay/shared";

interface SourcesStore {
  sources: Source[];
  activeSourceId: string | null;
  addSource: (s: Source) => void;
  removeSource: (id: string) => void;
  setActiveSource: (id: string | null) => void;
  findById: (id: string) => Source | undefined;
}

/**
 * Collapse duplicate sources that share an `address`, keeping the entry with
 * the oldest `createdAt`. If `activeSourceId` pointed at a dropped duplicate,
 * repoint it to the surviving entry for that same address. Pure + total.
 */
export function dedupeSourcesByAddress(
  sources: Source[],
  activeSourceId: string | null,
): { sources: Source[]; activeSourceId: string | null } {
  const byAddr = new Map<string, Source>();
  for (const s of sources) {
    const cur = byAddr.get(s.address);
    if (!cur || s.createdAt < cur.createdAt) byAddr.set(s.address, s);
  }
  const survivors = [...byAddr.values()];
  let active = activeSourceId;
  if (active && !survivors.some((s) => s.id === active)) {
    const dropped = sources.find((s) => s.id === active);
    active = (dropped ? byAddr.get(dropped.address)?.id : undefined) ?? survivors[0]?.id ?? null;
  }
  return { sources: survivors, activeSourceId: active };
}

const sourcesStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useSourcesStore = create<SourcesStore>()(
  persist(
    (set, get) => ({
      sources: [],
      activeSourceId: null,
      setActiveSource: (id) => set({ activeSourceId: id }),
      addSource: (s) =>
        set((st) => {
          // Dedup by address: a CKB address fully identifies a lock on a network,
          // so a repeat Connect/keystore-add for the same wallet is a no-op.
          if (st.sources.some((x) => x.address === s.address)) return st;
          return {
            sources: [...st.sources, s],
            activeSourceId: st.activeSourceId ?? s.id,
          };
        }),
      removeSource: (id) =>
        set((st) => ({
          sources: st.sources.filter((x) => x.id !== id),
          activeSourceId: st.activeSourceId === id ? null : st.activeSourceId,
        })),
      findById: (id) => get().sources.find((x) => x.id === id),
    }),
    {
      name: "chain-pay:sources",
      storage: createJSONStorage(() => sourcesStorage),
      version: 2,
      migrate: (persisted, version) => {
        const st = (persisted ?? {}) as Partial<Pick<SourcesStore, "sources" | "activeSourceId">>;
        if (version < 2) {
          return dedupeSourcesByAddress(st.sources ?? [], st.activeSourceId ?? null);
        }
        return { sources: st.sources ?? [], activeSourceId: st.activeSourceId ?? null };
      },
      partialize: (st) => ({ sources: st.sources, activeSourceId: st.activeSourceId }),
    },
  ),
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/stores/sources.test.ts`
Expected: PASS (original 9 tests + new guard/dedupe/migration tests).

- [ ] **Step 5: Verify types**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/stores/sources.ts apps/desktop/src/stores/sources.test.ts
git commit -m "feat(sources): dedup by address — addSource guard + v1->v2 migration"
```

---

### Task 3: Pure rescan-block validator

**Files:**
- Create: `apps/desktop/src/features/send/parse-rescan-block.ts`
- Create: `apps/desktop/src/features/send/parse-rescan-block.test.ts`

**Interfaces:**
- Produces: `type ParseRescanBlockResult = { ok: true; block: bigint } | { ok: false; error: string }` and `parseRescanBlock(input: string, tip: bigint | null): ParseRescanBlockResult`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/features/send/parse-rescan-block.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseRescanBlock } from "./parse-rescan-block";

describe("parseRescanBlock", () => {
  it("accepts a plain non-negative integer", () => {
    expect(parseRescanBlock("12345", null)).toEqual({ ok: true, block: 12_345n });
  });

  it("accepts 0 (genesis)", () => {
    expect(parseRescanBlock("0", null)).toEqual({ ok: true, block: 0n });
  });

  it("trims surrounding whitespace", () => {
    expect(parseRescanBlock("  42  ", null)).toEqual({ ok: true, block: 42n });
  });

  it("rejects an empty string", () => {
    const r = parseRescanBlock("   ", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/enter a block/i);
  });

  it("rejects non-digit input", () => {
    const r = parseRescanBlock("12.5", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/whole number/i);
  });

  it("rejects negatives", () => {
    expect(parseRescanBlock("-5", null).ok).toBe(false);
  });

  it("rejects a block above the known tip", () => {
    const r = parseRescanBlock("2000000", 1_000_000n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/above the current tip/i);
  });

  it("allows a block equal to the tip", () => {
    expect(parseRescanBlock("1000000", 1_000_000n)).toEqual({ ok: true, block: 1_000_000n });
  });

  it("skips the upper-bound check when tip is unknown (null)", () => {
    expect(parseRescanBlock("999999999", null)).toEqual({ ok: true, block: 999_999_999n });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/features/send/parse-rescan-block.test.ts`
Expected: FAIL — `Cannot find module './parse-rescan-block'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/features/send/parse-rescan-block.ts`:

```typescript
export type ParseRescanBlockResult =
  | { ok: true; block: bigint }
  | { ok: false; error: string };

/**
 * Validate a user-entered start block for a custom rescan. Accepts a plain
 * non-negative integer; rejects empty/non-digit/negative input and (when `tip`
 * is known) any block above the chain tip. `tip = null` skips the upper bound.
 */
export function parseRescanBlock(input: string, tip: bigint | null): ParseRescanBlockResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "Enter a block number." };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: "Block must be a whole number." };
  const block = BigInt(trimmed);
  if (tip !== null && block > tip) {
    return { ok: false, error: `Block is above the current tip (${tip}).` };
  }
  return { ok: true, block };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/features/send/parse-rescan-block.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/send/parse-rescan-block.ts apps/desktop/src/features/send/parse-rescan-block.test.ts
git commit -m "feat(send): pure validator for custom rescan block input"
```

---

### Task 4: RescanControl component + wire into SourceList

**Files:**
- Create: `apps/desktop/src/features/send/rescan-source.ts` (default rescan + tip fns)
- Create: `apps/desktop/src/features/send/RescanControl.tsx`
- Create: `apps/desktop/src/features/send/RescanControl.test.tsx`
- Modify: `apps/desktop/src/features/send/SourceList.tsx` (render `<RescanControl source={s} />` in each row)

**Interfaces:**
- Consumes: `parseRescanBlock` (Task 3); `dedupeSourcesByAddress` not needed here; `Source` from `@chain-pay/shared`; `lightClient().rescanLockFromBlock` (Task 1).
- Produces: `RescanControl(props: { source: Source; rescan?: (source: Source, fromBlock: bigint) => Promise<void>; getTip?: () => Promise<bigint | null> })`.
- Produces (default impls, untested — follow the dynamic-import convention of `SourceList.handleConnect`): `rescanSourceFromBlock(source: Source, fromBlock: bigint): Promise<void>` and `fetchLcTip(): Promise<bigint | null>`.

- [ ] **Step 1: Write the default rescan/tip helpers**

Create `apps/desktop/src/features/send/rescan-source.ts`:

```typescript
import type { Source } from "@chain-pay/shared";

/**
 * Resolve a source's lock from its stored address (kind-agnostic: the address
 * encodes the full lock script) and re-scan it from `fromBlock`. Mirrors the
 * dynamic-import shape of SourceList.handleConnect so it shares no module-load
 * cost with tests. Injected into RescanControl; the component is tested with a
 * stub instead.
 */
export async function rescanSourceFromBlock(source: Source, fromBlock: bigint): Promise<void> {
  const { Address, ClientPublicMainnet, ClientPublicTestnet } = await import("@ckb-ccc/core");
  const { lightClient } = await import("@/lib/light-client/client");
  const client =
    source.chain === "ckb:mainnet" ? new ClientPublicMainnet() : new ClientPublicTestnet();
  const parsed = await Address.fromString(source.address, client);
  await lightClient().rescanLockFromBlock(parsed.script, fromBlock);
}

/** Best-effort current tip for upper-bound validation; null on any failure. */
export async function fetchLcTip(): Promise<bigint | null> {
  try {
    const { lightClient } = await import("@/lib/light-client/client");
    const tip = await lightClient().getTipHeader();
    return BigInt(tip.number ?? 0);
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Write the failing component test**

Create `apps/desktop/src/features/send/RescanControl.test.tsx`:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RescanControl } from "./RescanControl";
import type { Source } from "@chain-pay/shared";

afterEach(cleanup);

const source: Source = {
  id: "a", label: "Ops", chain: "ckb:testnet", address: "ckt1qsource",
  joyidLockArgs: ("0x" + "11".repeat(20)) as `0x${string}`,
  createdAt: "2026-06-25T00:00:00Z", updatedAt: "2026-06-25T00:00:00Z",
};

function setup(rescan = vi.fn(async () => {})) {
  const getTip = vi.fn(async () => 1_000_000n);
  render(<RescanControl source={source} rescan={rescan} getTip={getTip} />);
  return { rescan, getTip };
}

describe("RescanControl", () => {
  it("rescans from genesis (0n) when 'From genesis' is clicked", async () => {
    const { rescan } = setup();
    fireEvent.click(screen.getByRole("button", { name: /rescan/i })); // open disclosure
    fireEvent.click(screen.getByRole("button", { name: /from genesis/i }));
    await waitFor(() => expect(rescan).toHaveBeenCalledWith(source, 0n));
  });

  it("rescans from a valid custom block", async () => {
    const { rescan } = setup();
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));
    fireEvent.change(screen.getByLabelText(/from block/i), { target: { value: "12345" } });
    fireEvent.click(screen.getByRole("button", { name: /^go$/i }));
    await waitFor(() => expect(rescan).toHaveBeenCalledWith(source, 12_345n));
  });

  it("shows a field error and does not call rescan for invalid input", async () => {
    const { rescan } = setup();
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));
    fireEvent.change(screen.getByLabelText(/from block/i), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: /^go$/i }));
    expect(await screen.findByText(/whole number/i)).toBeInTheDocument();
    expect(rescan).not.toHaveBeenCalled();
  });

  it("shows a rescanning status line after a successful rescan", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));
    fireEvent.click(screen.getByRole("button", { name: /from genesis/i }));
    expect(await screen.findByText(/balance updates as the light client syncs/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/features/send/RescanControl.test.tsx`
Expected: FAIL — `Cannot find module './RescanControl'`.

- [ ] **Step 4: Implement the component**

Create `apps/desktop/src/features/send/RescanControl.tsx`:

```typescript
import { useEffect, useState } from "react";
import type { Source } from "@chain-pay/shared";
import { parseRescanBlock } from "./parse-rescan-block";
import { rescanSourceFromBlock, fetchLcTip } from "./rescan-source";

interface RescanControlProps {
  source: Source;
  /** Injectable for tests; defaults to the real light-client path. */
  rescan?: (source: Source, fromBlock: bigint) => Promise<void>;
  /** Injectable for tests; best-effort current tip for upper-bound validation. */
  getTip?: () => Promise<bigint | null>;
}

export function RescanControl({
  source,
  rescan = rescanSourceFromBlock,
  getTip = fetchLcTip,
}: RescanControlProps) {
  const [open, setOpen] = useState(false);
  const [blockInput, setBlockInput] = useState("");
  const [tip, setTip] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rescanning, setRescanning] = useState<bigint | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void getTip().then((t) => { if (live) setTip(t); });
    return () => { live = false; };
  }, [open, getTip]);

  async function run(fromBlock: bigint) {
    setBusy(true);
    setError(null);
    try {
      await rescan(source, fromBlock);
      setRescanning(fromBlock);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rescan failed.");
    } finally {
      setBusy(false);
    }
  }

  function onGo() {
    const parsed = parseRescanBlock(blockInput, tip);
    if (!parsed.ok) { setError(parsed.error); return; }
    void run(parsed.block);
  }

  return (
    <div className="ml-3 shrink-0 text-right">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-surface-hi px-2 py-1 text-xs text-fg-muted hover:text-fg"
      >
        Rescan ▾
      </button>
      {open ? (
        <div className="mt-2 space-y-2 rounded border border-border bg-bg p-2 text-left">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(0n)}
            className="block w-full rounded bg-surface px-2 py-1 text-xs hover:opacity-90 disabled:opacity-50"
          >
            From genesis (complete, slower)
          </button>
          <div className="flex items-center gap-2">
            <label className="text-xs text-fg-muted" htmlFor={`rescan-block-${source.id}`}>
              From block
            </label>
            <input
              id={`rescan-block-${source.id}`}
              inputMode="numeric"
              value={blockInput}
              onChange={(e) => setBlockInput(e.target.value)}
              className="w-28 rounded border border-surface-hi bg-bg px-2 py-1 font-mono text-xs"
            />
            <button
              type="button"
              disabled={busy}
              onClick={onGo}
              className="rounded bg-accent px-2 py-1 text-xs text-accent-fg disabled:opacity-50"
            >
              Go
            </button>
          </div>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
          {rescanning !== null ? (
            <p className="text-xs text-fg-muted">
              Rescanning from block {rescanning.toString()} — balance updates as the light client
              syncs (can take minutes from genesis).
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/features/send/RescanControl.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Wire RescanControl into the SourceList row**

In `apps/desktop/src/features/send/SourceList.tsx`, add the import after the `JoyIdSignModal` import (line 5):

```typescript
import { RescanControl } from "./RescanControl";
```

Then replace the existing Remove button block (lines 105–111) so the row carries both Rescan and Remove:

```typescript
              <div className="ml-3 flex shrink-0 items-start gap-2">
                <RescanControl source={s} />
                <button
                  type="button"
                  onClick={() => removeSource(s.id)}
                  className="rounded-md border border-surface-hi px-2 py-1 text-xs text-fg-muted hover:border-danger hover:text-danger"
                >
                  Remove
                </button>
              </div>
```

- [ ] **Step 7: Run the send-feature suite + types**

Run: `cd apps/desktop && npx vitest run src/features/send/ && npx tsc --noEmit`
Expected: PASS (existing SourceList tests + RescanControl + parse-rescan-block), no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/features/send/rescan-source.ts apps/desktop/src/features/send/RescanControl.tsx apps/desktop/src/features/send/RescanControl.test.tsx apps/desktop/src/features/send/SourceList.tsx
git commit -m "feat(send): per-source RescanControl (genesis + custom block) on SourceList rows"
```

---

### Task 5: Full-suite gate + review

**Files:** none (verification)

- [ ] **Step 1: Run the full desktop suite + typecheck**

Run: `cd apps/desktop && npx vitest run && npx tsc --noEmit`
Expected: all tests green (prior count + the new rescan/dedup tests), zero type errors.

- [ ] **Step 2: Whole-branch review**

Request a code review of the full branch diff (`git diff main...HEAD`) — security + correctness focus on the light-client `setScripts(Delete)` path and the persist migration. Address CRITICAL/HIGH before PR.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/send-source-rescan-dedup
gh pr create --base main --title "feat(send): send-source rescan + dedup" --body "Implements docs/superpowers/specs/2026-06-30-send-source-rescan-dedup-design.md. Per-source Rescan (genesis + custom block) via light-client delete+re-add; addSource deduped by address + v1->v2 migration collapsing existing duplicates."
```

---

## Post-merge: relay-sign on-chain smoke (Thread 2 — manual, no code)

Not a task in this plan; tracked separately. After merge: build a real testnet payment through `lib/send/build-and-send.ts` (`buildAndSend`) with a `JoyIdRelaySigner`, approve on the phone via the relay QR, and confirm the tx hash on a testnet explorer. Only relay *connect* and *keystore send* have on-chain proof today; this closes the relay *sign* gap. If it surfaces a bug, that becomes its own fix.

## Self-review notes

- **Spec coverage:** rescan host method (Task 1) ✓; genesis + custom block UX (Tasks 3, 4) ✓; dedup guard + migration (Task 2) ✓; address-keyed dedup ✓; no instant balance refresh / persistent status line (Task 4) ✓; lock resolved by parsing address (Task 4 `rescan-source.ts`) ✓; treasuries/presets/progress out of scope (not implemented) ✓; relay-sign smoke kept manual (post-merge section) ✓.
- **Type consistency:** `rescanLockFromBlock(script, fromBlock)` used identically in Tasks 1 and 4; `parseRescanBlock(input, tip)` defined in Task 3 and consumed in Task 4; `dedupeSourcesByAddress(sources, activeSourceId)` defined and consumed within Task 2; `rescan`/`getTip` prop names match between `RescanControl` impl and its test.
- **No placeholders:** every code/test step shows complete content.
