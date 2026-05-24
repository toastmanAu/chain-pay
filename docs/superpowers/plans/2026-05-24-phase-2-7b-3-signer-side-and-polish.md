# Phase 2.7b-3 — Signer Side + Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the signer-side comm UI + ack feedback loop + sender retry/backoff + `expiresAt` enforcement + clipboard demotion, closing the Phase 2.7 comm-channel epic. After this PR, the comm channel is the default; clipboard is a debug fallback.

**Architecture:** Stacked on Phase 2.7b-2 (PR #3). Adds a peer addrHash mapping (for ack sender resolution), an `incoming-packets` buffer (mirrors `incoming-sigs`), a `debug-settings` store (clipboard toggle), an `expires-at` helper, transport-level `sendAck`/`onIncomingAck`, an app-level retry scheduler, a `SignInbox` UI surface that auto-loads into the existing paste-based sign flow, and a render gate on `ClipboardBar`. Auto-ack on packet receive closes the operator's status pill loop. Retry uses exponential backoff (5m / 10m / 20m, cap 3) keyed by `(batchId, slotIndex)`, persisted via `commSendStatus.retryCount` so it survives app restart.

**Tech Stack:** TypeScript, Vitest, Zustand (with persist + createJSONStorage), React + Testing Library (jsdom for component tests), Electron preload IPC, CCC for chain interactions. Reuses the validated patterns from Phase 2.7a/b-1/b-2.

**Prerequisite:** Phase 2.7b-2 (PR #3) must be merged into `main` before starting Task 1. After merge, rebase this branch:

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-3
git fetch origin main
git rebase origin/main
```

The spec doc (`b1f5c7c`) should replay cleanly on top of the merged 2.7b-2 tree.

---

## File Structure

### New files (10)

| Path | Responsibility |
|---|---|
| `apps/desktop/src/stores/incoming-packets.ts` | Buffers decrypted comm packets by sighashDigest. Mirrors `incoming-sigs` shape. |
| `apps/desktop/src/stores/incoming-packets.test.ts` | ~7 tests. |
| `apps/desktop/src/stores/debug-settings.ts` | `{ showClipboard: boolean }` toggle, persisted. |
| `apps/desktop/src/stores/debug-settings.test.ts` | ~3 tests. |
| `apps/desktop/src/lib/comm/expires-at.ts` | `isExpired(expiresAt?, now?)` pure helper. |
| `apps/desktop/src/lib/comm/expires-at.test.ts` | ~3 tests. |
| `apps/desktop/src/features/payments/useCommSendRetry.ts` | App-level retry scheduler. |
| `apps/desktop/src/features/payments/useCommSendRetry.test.ts` | ~6 tests (fake timers). |
| `apps/desktop/src/features/sign/SignInbox.tsx` | Inbox list container. |
| `apps/desktop/src/features/sign/SignInbox.test.tsx` | ~6 tests. |
| `apps/desktop/src/features/sign/sign-inbox-rows/InboxRow.tsx` | Single packet row. |

### Modified files (7)

| Path | Change |
|---|---|
| `packages/shared/src/payroll.ts` | `CommSendSlotStatus.retryCount?: number`. |
| `apps/desktop/src/lib/comm/types.ts` | `OutgoingAck`, `IncomingAckHandler`, `CommTransport.{sendAck, onIncomingAck}`. |
| `apps/desktop/src/lib/comm/errors.ts` | `AckEmissionError`, `RetryScheduleError`. |
| `apps/desktop/src/stores/peer-book.ts` | `Peer.addrHash` field, `findByAddrHash` selector, v1→v2 migration. |
| `apps/desktop/src/lib/comm/cemp-pq/watcher.ts` | Dispatch kind=ack; drop expired packets; auto-ack on packet receive. |
| `apps/desktop/src/lib/comm/cemp-pq/transport.ts` | Implement `sendAck` + `onIncomingAck`. |
| `apps/desktop/electron/main/comm-transport-service.ts` | `sendAck` IPC handler; ack envelope encoding. |
| `apps/desktop/src/App.tsx` | Subscribe `onIncomingAck` → flip status to `acked`; mount `useCommSendRetry`. |
| `apps/desktop/src/features/sign/SignPanel.tsx` | Mount `<SignInbox />`; `handleClaim` populates state. |
| `apps/desktop/src/components/clipboard/ClipboardBar.tsx` | Render gate: hide when comm active + debug off. |
| `apps/desktop/src/features/settings/Settings.tsx` | Add Debug section with clipboard toggle. |
| `scripts/smoke-comm-roundtrip.mts` | Wait for ack envelope before sending signature reply. |

---

### Task 1: Shared types (additive)

Add `retryCount?: number` to `CommSendSlotStatus`. Add `OutgoingAck`, `IncomingAckHandler`, and `sendAck` + `onIncomingAck` to the `CommTransport` interface.

**Files:**
- Modify: `packages/shared/src/payroll.ts`
- Modify: `apps/desktop/src/lib/comm/types.ts`

- [ ] **Step 1: Edit `packages/shared/src/payroll.ts`**

Find:

```ts
export interface CommSendSlotStatus {
  status: "idle" | "sending" | "sent" | "acked" | "error";
  txHash?: string;
  error?: string;
  updatedAt: number;
}
```

Replace with:

```ts
export interface CommSendSlotStatus {
  status: "idle" | "sending" | "sent" | "acked" | "error";
  txHash?: string;
  error?: string;
  updatedAt: number;
  /** Number of auto-retries completed for this slot (0..3). Reset to 0 on
   *  manual Retry. Used by useCommSendRetry to decide next-delay + stop. */
  retryCount?: number;
}
```

- [ ] **Step 2: Edit `apps/desktop/src/lib/comm/types.ts`**

After the existing `OutgoingSignature` interface and `IncomingSignatureHandler`, append:

```ts
export interface OutgoingAck {
  /** Matches OutgoingPacket.txHash / batch.sighashDigest. */
  txHash: string;
}

export interface IncomingAckHandler {
  (from: string, body: OutgoingAck): void;
}
```

Then in the existing `CommTransport` interface, add two methods:

```ts
export interface CommTransport {
  // ... existing members ...

  sendAck(peer: PeerProfile, body: OutgoingAck): Promise<string>;
  onIncomingAck(handler: IncomingAckHandler): Unsubscribe;
}
```

- [ ] **Step 3: Run typecheck — expect errors in transport.ts (not yet implementing)**

Run from `apps/desktop`: `npx tsc --noEmit`

Expected: errors at `lib/comm/cemp-pq/transport.ts` and `lib/comm/index.ts` complaining about missing `sendAck` / `onIncomingAck`. We'll fix these in Tasks 8 and 9.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/payroll.ts apps/desktop/src/lib/comm/types.ts
git commit -m "feat(2.7b-3): shared types — CommSendSlotStatus.retryCount + OutgoingAck"
```

(Branch will have failing typecheck until Task 8; Task 1 commits a type-only change that downstream tasks need.)

---

### Task 2: peer-book — addrHash + findByAddrHash + v1→v2 migration

The operator's ack handler needs to resolve `senderAddrHash` (from the envelope) to a peer. Adding the hash to `Peer` at add time + a `findByAddrHash` selector + a migration to backfill existing v1 records.

**Files:**
- Modify: `apps/desktop/src/stores/peer-book.ts`
- Modify: `apps/desktop/src/stores/peer-book.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/stores/peer-book.test.ts`, inside the existing `describe("peer-book store — associatedSignerHash", …)` block (after the last `it`):

```ts
it("addPeer stamps addrHash on the persisted peer", () => {
  const expected = new Uint8Array(20).fill(0x07);
  usePeerBookStore.getState().addPeer(PEER_A, expected);
  const stored = usePeerBookStore.getState().peers[0]!;
  expect(stored.addrHash).toBe(`0x${"07".repeat(20)}`);
});

it("findByAddrHash returns the peer whose addrHash matches", () => {
  const hashA = new Uint8Array(20).fill(0x07);
  const hashB = new Uint8Array(20).fill(0x08);
  usePeerBookStore.getState().addPeer(PEER_A, hashA);
  usePeerBookStore.getState().addPeer(
    { nickname: "Bob", address: "ckt1qbob", pairedAt: 1747900000_000 },
    hashB,
  );
  const found = usePeerBookStore.getState().findByAddrHash(`0x${"07".repeat(20)}`);
  expect(found?.address).toBe(PEER_A.address);
  expect(usePeerBookStore.getState().findByAddrHash(`0x${"09".repeat(20)}`)).toBeUndefined();
});
```

- [ ] **Step 2: Run tests — expect RED**

Run from `apps/desktop`: `npm test --workspace apps/desktop -- --run src/stores/peer-book.test.ts`

Expected: two test failures complaining `addrHash` is not defined / `findByAddrHash is not a function`.

- [ ] **Step 3: Edit `apps/desktop/src/stores/peer-book.ts`**

In the `Peer` interface, add `addrHash` (required, not optional — every peer has one after add):

```ts
export interface Peer {
  nickname: string;
  address: string;
  cachedProfile?: PeerProfile;
  pairedAt: number;
  associatedSignerHash?: `0x${string}`;
  /** 0x-prefixed 20-byte blake160 of the peer's cemp-pq lock args (first 20
   *  bytes). Cached at add time so onIncomingAck can resolve sender → peer
   *  without recomputing. Required in v2+; v1 records are backfilled on
   *  rehydrate via peerHashFromAddress. */
  addrHash: `0x${string}`;
}
```

Add `findByAddrHash` to the `PeerBookStore` interface:

```ts
interface PeerBookStore {
  // ... existing ...
  findByAddrHash: (addrHash: `0x${string}`) => Peer | undefined;
}
```

In `addPeer`, stamp `addrHash` from the `candidateHash` argument (the caller already passes a 20-byte Uint8Array):

```ts
addPeer: (peer, candidateHash) => {
  assertNotMultisigSigner(candidateHash, get().knownSignersGetter);
  if (peer.associatedSignerHash !== undefined) {
    assertSignerHashFree(get().peers, peer.associatedSignerHash);
  }
  const addrHash = bytesToHex20(candidateHash);
  set((s) => ({ peers: [...s.peers, { ...peer, addrHash }] }));
},
```

Add `findByAddrHash` to the store body:

```ts
findByAddrHash: (addrHash) =>
  get().peers.find((p) => p.addrHash === addrHash),
```

Add the helper `bytesToHex20` near the existing `assertSignerHashFree` helper:

```ts
function bytesToHex20(bytes: Uint8Array): `0x${string}` {
  if (bytes.length !== 20) {
    throw new Error(`expected 20-byte hash, got ${bytes.length}`);
  }
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}
```

Bump `version` to `2` and add a `migrate` callback on the persist config. The migration backfills `addrHash` by re-deriving from `peer.address` synchronously where possible; if derivation throws, drop the peer (no production users yet, safe).

Replace the existing `persist` config:

```ts
import { peerHashFromAddress } from "@/lib/comm/peer-hash";

// ... inside create<...>()(persist(

    {
      name: "chain-pay:peer-book",
      storage: createJSONStorage(() => storageImpl),
      version: 2,
      partialize: (state) => ({ peers: state.peers }),
      migrate: (persisted, fromVersion) => {
        const state = persisted as { peers?: Array<Partial<Peer> & { address: string }> };
        if (!state?.peers) return state as { peers: Peer[] };
        if (fromVersion < 2) {
          // v1 → v2: backfill addrHash. peerHashFromAddress is async; the migrate
          // callback is sync in zustand v5 — but the value is cheap to recompute
          // synchronously via decode + slice. We use a synchronous local copy.
          const peers: Peer[] = [];
          for (const p of state.peers) {
            try {
              const addrHash = derivePeerHashSync(p.address);
              peers.push({
                nickname: p.nickname ?? "(migrated)",
                address: p.address,
                pairedAt: p.pairedAt ?? 0,
                ...(p.cachedProfile !== undefined ? { cachedProfile: p.cachedProfile } : {}),
                ...(p.associatedSignerHash !== undefined
                  ? { associatedSignerHash: p.associatedSignerHash }
                  : {}),
                addrHash,
              });
            } catch {
              // Drop unmigrateable peers — no production users.
            }
          }
          return { peers };
        }
        return state as { peers: Peer[] };
      },
    },
```

Also add `derivePeerHashSync` as a synchronous mirror of `peerHashFromAddress` (the existing one is async because of the parser construction, but the parser is sync once instantiated). Define it inline at the top of `peer-book.ts`:

```ts
import { Address, ClientPublicTestnet } from "@ckb-ccc/core";

// Module-level parser — cheap, deterministic, no network.
const _parser = new ClientPublicTestnet();

function derivePeerHashSync(address: string): `0x${string}` {
  const lockArgs = Address.parsePrefix(address)
    ? (Address.fromString as unknown as (
        addr: string,
        client: typeof _parser,
      ) => { script: { args: string } }) /* fromString is async-typed but resolves sync for known prefixes */
    : null;
  // Fallback: defer to peerHashFromAddress, which IS async but the migrate
  // callback is intentionally tolerant — async work is via Promise.resolve+await
  // inside a synchronous wrapper would block the event loop. Instead we run a
  // simple inline parse here:
  const argsHex = parseCempPqArgs(address);
  let hex = "0x";
  for (let i = 0; i < 20; i++) hex += argsHex.slice(i * 2, i * 2 + 2);
  return hex as `0x${string}`;
}

function parseCempPqArgs(_address: string): string {
  // For 2.7b-3: the migration runs against persisted state from local dev only.
  // We keep the implementation tolerant by re-using the existing async helper
  // via top-level await at module init — Zustand persist runs migrate during
  // rehydrate which awaits the storage promise chain, so async migration IS
  // supported in practice. Switch the migrate function to async if needed:
  throw new Error("derivePeerHashSync stub — use the async migration path");
}
```

**Note to implementing engineer:** The sync derivation above is intentionally a stub. The cleaner path is to make `migrate` async (Zustand v4+ supports `Promise<State>` return from migrate). Replace the entire `derivePeerHashSync` block with:

```ts
// Drop the sync helper. In the persist config:

      migrate: async (persisted, fromVersion) => {
        const state = persisted as { peers?: Array<Partial<Peer> & { address: string }> };
        if (!state?.peers) return { peers: [] as Peer[] };
        if (fromVersion < 2) {
          const peers: Peer[] = [];
          for (const p of state.peers) {
            try {
              const hashBytes = await peerHashFromAddress(p.address);
              const addrHash = ("0x" + Array.from(hashBytes)
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("")) as `0x${string}`;
              peers.push({
                nickname: p.nickname ?? "(migrated)",
                address: p.address,
                pairedAt: p.pairedAt ?? 0,
                ...(p.cachedProfile !== undefined ? { cachedProfile: p.cachedProfile } : {}),
                ...(p.associatedSignerHash !== undefined
                  ? { associatedSignerHash: p.associatedSignerHash }
                  : {}),
                addrHash,
              });
            } catch {
              // Drop unmigrateable peers.
            }
          }
          return { peers };
        }
        return state as { peers: Peer[] };
      },
```

Use the async version. Delete the stub helpers.

- [ ] **Step 4: Run tests — expect GREEN**

Run: `npm test --workspace apps/desktop -- --run src/stores/peer-book.test.ts`

Expected: all peer-book tests pass (17 of them — 15 existing + 2 new).

Existing tests that pass a `new Uint8Array(20)` (filled with zeros) to `addPeer` will now stamp `addrHash = "0x" + "00".repeat(20)`. That's fine; no existing assertion checks `addrHash` value.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.json`

Expected: errors only at `lib/comm/cemp-pq/transport.ts` (from Task 1's interface additions). No new errors from this task.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/stores/peer-book.ts apps/desktop/src/stores/peer-book.test.ts
git commit -m "feat(2.7b-3): peer-book — addrHash field + findByAddrHash + v1→v2 migration"
```

---

### Task 3: incoming-packets store (NEW)

Mirror the `incoming-sigs` shape for decrypted packets. Used by the signer's inbox.

**Files:**
- Create: `apps/desktop/src/stores/incoming-packets.ts`
- Create: `apps/desktop/src/stores/incoming-packets.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/stores/incoming-packets.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import type { TransferPacket } from "@chain-pay/shared";
import type { OutgoingPacket } from "@/lib/comm/types";
import { useIncomingPacketsStore, type IncomingPacketEntry } from "./incoming-packets";

const DIGEST_A = `0x${"a1".repeat(32)}`;
const DIGEST_B = `0x${"b2".repeat(32)}`;
const SENDER_A = `0x${"aa".repeat(20)}`;

function makePacket(sighash: string, expiresAt = 9_999_999_999): OutgoingPacket {
  return {
    txHash: sighash,
    treasuryAddress: "ckt1qtreasury",
    expiresAt,
    packet: "encoded" as TransferPacket,
  };
}

function entry(overrides: Partial<IncomingPacketEntry> = {}): IncomingPacketEntry {
  return {
    sighashDigest: DIGEST_A,
    packet: makePacket(DIGEST_A),
    senderAddrHash: SENDER_A,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function reset(): void {
  useIncomingPacketsStore.setState({ bySighash: {} });
  globalThis.localStorage?.removeItem("chain-pay:incoming-packets");
}

describe("incoming-packets store", () => {
  beforeEach(reset);

  it("starts empty", () => {
    expect(useIncomingPacketsStore.getState().bySighash).toEqual({});
  });

  it("enqueue adds an entry under its sighashDigest", () => {
    const e = entry();
    useIncomingPacketsStore.getState().enqueue(e);
    expect(useIncomingPacketsStore.getState().bySighash[DIGEST_A]).toEqual(e);
  });

  it("enqueue is idempotent on duplicate sighashDigest (most recent wins)", () => {
    const first = entry({ receivedAt: 100 });
    const second = entry({ receivedAt: 200 });
    useIncomingPacketsStore.getState().enqueue(first);
    useIncomingPacketsStore.getState().enqueue(second);
    expect(useIncomingPacketsStore.getState().bySighash[DIGEST_A]).toEqual(second);
  });

  it("dismiss removes the entry", () => {
    useIncomingPacketsStore.getState().enqueue(entry());
    useIncomingPacketsStore.getState().dismiss(DIGEST_A);
    expect(useIncomingPacketsStore.getState().bySighash[DIGEST_A]).toBeUndefined();
  });

  it("dismiss on a missing key is a no-op", () => {
    useIncomingPacketsStore.getState().dismiss(DIGEST_B);
    expect(useIncomingPacketsStore.getState().bySighash).toEqual({});
  });

  it("pruneExpired drops entries whose packet.expiresAt has passed", () => {
    const now = 1_700_000_000_000;
    const oldEntry = entry({ packet: makePacket(DIGEST_A, 100) });
    const futureEntry = entry({
      sighashDigest: DIGEST_B,
      packet: makePacket(DIGEST_B, Math.floor(now / 1000) + 3600),
    });
    useIncomingPacketsStore.getState().enqueue(oldEntry);
    useIncomingPacketsStore.getState().enqueue(futureEntry);
    useIncomingPacketsStore.getState().pruneExpired(now);
    expect(useIncomingPacketsStore.getState().bySighash[DIGEST_A]).toBeUndefined();
    expect(useIncomingPacketsStore.getState().bySighash[DIGEST_B]).toBeDefined();
  });

  it("multiple senders for different digests coexist", () => {
    useIncomingPacketsStore.getState().enqueue(entry());
    useIncomingPacketsStore
      .getState()
      .enqueue(entry({ sighashDigest: DIGEST_B, packet: makePacket(DIGEST_B), senderAddrHash: `0x${"bb".repeat(20)}` }));
    expect(Object.keys(useIncomingPacketsStore.getState().bySighash)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests — expect RED**

Run: `npm test --workspace apps/desktop -- --run src/stores/incoming-packets.test.ts`

Expected: import fails because `incoming-packets.ts` doesn't exist.

- [ ] **Step 3: Create `apps/desktop/src/stores/incoming-packets.ts`**

```ts
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { OutgoingPacket } from "@/lib/comm/types";

export interface IncomingPacketEntry {
  /** Matches OutgoingPacket.txHash; used as the store key. */
  sighashDigest: string;
  /** Full decrypted packet body for replay into SignPanel. */
  packet: OutgoingPacket;
  /** 0x-prefixed 20-byte hex of the envelope sender's identity hash. */
  senderAddrHash: string;
  /** Epoch ms when the watcher dispatched this packet. */
  receivedAt: number;
}

interface IncomingPacketsStore {
  bySighash: Record<string, IncomingPacketEntry>;
  /** Add (or replace) an entry by sighashDigest. Most recent wins. */
  enqueue: (entry: IncomingPacketEntry) => void;
  /** Remove the entry for this digest. No-op if absent. */
  dismiss: (sighashDigest: string) => void;
  /**
   * Drop entries whose packet.expiresAt has passed. `now` is injectable for
   * deterministic tests; defaults to Date.now().
   */
  pruneExpired: (now?: number) => void;
}

const storageImpl: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useIncomingPacketsStore = create<IncomingPacketsStore>()(
  persist(
    (set) => ({
      bySighash: {},
      enqueue: (entry) =>
        set((s) => ({
          bySighash: { ...s.bySighash, [entry.sighashDigest]: entry },
        })),
      dismiss: (sighashDigest) =>
        set((s) => {
          if (!(sighashDigest in s.bySighash)) return s;
          const { [sighashDigest]: _omit, ...rest } = s.bySighash;
          return { bySighash: rest };
        }),
      pruneExpired: (now = Date.now()) =>
        set((s) => {
          const next: Record<string, IncomingPacketEntry> = {};
          const nowSec = now / 1000;
          for (const [digest, e] of Object.entries(s.bySighash)) {
            if (e.packet.expiresAt && e.packet.expiresAt <= nowSec) continue;
            next[digest] = e;
          }
          return { bySighash: next };
        }),
    }),
    {
      name: "chain-pay:incoming-packets",
      storage: createJSONStorage(() => storageImpl),
      version: 1,
      partialize: (state) => ({ bySighash: state.bySighash }),
    },
  ),
);
```

- [ ] **Step 4: Run tests — expect GREEN**

Run: `npm test --workspace apps/desktop -- --run src/stores/incoming-packets.test.ts`

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/incoming-packets.ts apps/desktop/src/stores/incoming-packets.test.ts
git commit -m "feat(2.7b-3): incoming-packets store for signer inbox"
```

---

### Task 4: debug-settings store (NEW)

A tiny persisted store for the clipboard demote toggle. Standalone so future debug toggles slot in cleanly.

**Files:**
- Create: `apps/desktop/src/stores/debug-settings.ts`
- Create: `apps/desktop/src/stores/debug-settings.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/stores/debug-settings.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
  removeItem(k: string): void { this.map.delete(k); }
  setItem(k: string, v: string): void { this.map.set(k, v); }
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("debug-settings store", () => {
  it("defaults showClipboard to false", async () => {
    const { useDebugSettingsStore } = await import("./debug-settings");
    expect(useDebugSettingsStore.getState().showClipboard).toBe(false);
  });

  it("setShowClipboard toggles the value", async () => {
    const { useDebugSettingsStore } = await import("./debug-settings");
    useDebugSettingsStore.getState().setShowClipboard(true);
    expect(useDebugSettingsStore.getState().showClipboard).toBe(true);
    useDebugSettingsStore.getState().setShowClipboard(false);
    expect(useDebugSettingsStore.getState().showClipboard).toBe(false);
  });

  it("persists across module reloads", async () => {
    const first = await import("./debug-settings");
    first.useDebugSettingsStore.getState().setShowClipboard(true);

    vi.resetModules();
    const second = await import("./debug-settings");
    expect(second.useDebugSettingsStore.getState().showClipboard).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — expect RED (file doesn't exist)**

Run: `npm test --workspace apps/desktop -- --run src/stores/debug-settings.test.ts`

- [ ] **Step 3: Create `apps/desktop/src/stores/debug-settings.ts`**

```ts
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

interface DebugSettingsStore {
  /** Show the clipboard bottom-bar even when comm is configured. */
  showClipboard: boolean;
  setShowClipboard: (v: boolean) => void;
}

const storageImpl: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useDebugSettingsStore = create<DebugSettingsStore>()(
  persist(
    (set) => ({
      showClipboard: false,
      setShowClipboard: (v) => set({ showClipboard: v }),
    }),
    {
      name: "chain-pay:debug-settings",
      storage: createJSONStorage(() => storageImpl),
      version: 1,
    },
  ),
);
```

- [ ] **Step 4: Run tests — expect GREEN**

Run: `npm test --workspace apps/desktop -- --run src/stores/debug-settings.test.ts`

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/debug-settings.ts apps/desktop/src/stores/debug-settings.test.ts
git commit -m "feat(2.7b-3): debug-settings store with clipboard-visibility toggle"
```

---

### Task 5: `expires-at` helper (NEW)

Pure helper used by the watcher (drop expired packets) and incoming-packets (`pruneExpired`).

**Files:**
- Create: `apps/desktop/src/lib/comm/expires-at.ts`
- Create: `apps/desktop/src/lib/comm/expires-at.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/lib/comm/expires-at.test.ts
import { describe, it, expect } from "vitest";
import { isExpired } from "./expires-at";

describe("isExpired", () => {
  it("returns true when expiresAt (epoch s) is before now (epoch ms)", () => {
    const now = 1_700_000_000_000;
    const past = Math.floor(now / 1000) - 60;
    expect(isExpired(past, now)).toBe(true);
  });

  it("returns false when expiresAt is in the future", () => {
    const now = 1_700_000_000_000;
    const future = Math.floor(now / 1000) + 60;
    expect(isExpired(future, now)).toBe(false);
  });

  it("returns false when expiresAt is undefined or zero", () => {
    expect(isExpired(undefined)).toBe(false);
    expect(isExpired(0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — expect RED**

Run: `npm test --workspace apps/desktop -- --run src/lib/comm/expires-at.test.ts`

- [ ] **Step 3: Create `apps/desktop/src/lib/comm/expires-at.ts`**

```ts
/**
 * True if `expiresAt` is set and has passed.
 *
 * `expiresAt` is epoch SECONDS (per OutgoingPacket.expiresAt). `now` is epoch
 * MILLISECONDS (Date.now()). Missing / zero expiresAt is treated as never-
 * expires — defensive for legacy packets pre-expiresAt support.
 */
export function isExpired(expiresAt: number | undefined, now: number = Date.now()): boolean {
  if (!expiresAt || expiresAt <= 0) return false;
  return now / 1000 > expiresAt;
}
```

- [ ] **Step 4: Run tests — expect GREEN**

Run: `npm test --workspace apps/desktop -- --run src/lib/comm/expires-at.test.ts`

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/comm/expires-at.ts apps/desktop/src/lib/comm/expires-at.test.ts
git commit -m "feat(2.7b-3): isExpired helper for expiresAt enforcement"
```

---

### Task 6: Watcher — kind=ack dispatch + expired-drop + auto-ack on receive

The cemp-pq watcher decrypts incoming envelopes and dispatches to typed handlers. Three changes:

1. Add `onIncomingAck` handler slot.
2. When a `packet` envelope arrives, check `isExpired(body.expiresAt)` → if expired, drop silently (no dispatch, no ack).
3. When a non-expired packet dispatches, auto-emit an ack envelope back to the sender.

**Files:**
- Modify: `apps/desktop/src/lib/comm/cemp-pq/watcher.ts`
- Modify: `apps/desktop/src/lib/comm/cemp-pq/watcher.test.ts` (or create if absent)

- [ ] **Step 1: Read the existing watcher**

Read `apps/desktop/src/lib/comm/cemp-pq/watcher.ts` end-to-end. Note where envelope kind branches (`if (kind === "packet") ... else if (kind === "signature") ...`). The ack branch + expiry check goes there.

- [ ] **Step 2: Read the existing watcher tests if any**

```bash
test -f apps/desktop/src/lib/comm/cemp-pq/watcher.test.ts && cat apps/desktop/src/lib/comm/cemp-pq/watcher.test.ts | head -40
```

If the test file exists, append the new tests to it. If not, create it following the patterns of other tests in `lib/comm/cemp-pq/`.

- [ ] **Step 3: Write the failing tests**

In `apps/desktop/src/lib/comm/cemp-pq/watcher.test.ts`, append (or create with) tests covering:

```ts
// (Wire up the existing watcher test scaffolding — mock the chain client, mock
// decryptIncoming, drive the watcher by injecting fake cells.)

it("kind=packet with expired expiresAt is dropped — no onIncomingPacket call, no ack", async () => {
  const onPacket = vi.fn();
  const onAck = vi.fn();
  watcher.onIncomingPacket(onPacket);
  watcher.onIncomingAck(onAck);
  // Inject a packet envelope with expiresAt = (now - 60s).
  const expiredPacket = makeEnvelope({
    kind: "packet",
    body: { txHash: "0xabc", treasuryAddress: "ckt1qx", expiresAt: Math.floor(Date.now() / 1000) - 60, packet: "p" },
  });
  await driveWatcherWith([expiredPacket]);
  expect(onPacket).not.toHaveBeenCalled();
  expect(transportMock.sendAck).not.toHaveBeenCalled();
});

it("kind=packet with valid expiresAt fires onIncomingPacket and emits an auto-ack", async () => {
  const onPacket = vi.fn();
  watcher.onIncomingPacket(onPacket);
  const validPacket = makeEnvelope({
    kind: "packet",
    body: { txHash: "0xdef", treasuryAddress: "ckt1qx", expiresAt: Math.floor(Date.now() / 1000) + 3600, packet: "p" },
  });
  await driveWatcherWith([validPacket]);
  expect(onPacket).toHaveBeenCalledOnce();
  expect(transportMock.sendAck).toHaveBeenCalledWith(
    expect.anything(),
    { txHash: "0xdef" },
  );
});

it("auto-ack failure does not block onIncomingPacket dispatch", async () => {
  transportMock.sendAck.mockRejectedValueOnce(new Error("ipc broke"));
  const onPacket = vi.fn();
  watcher.onIncomingPacket(onPacket);
  await driveWatcherWith([validPacketEnvelope()]);
  expect(onPacket).toHaveBeenCalledOnce();
});

it("kind=ack envelope routes to onIncomingAck handlers", async () => {
  const onAck = vi.fn();
  watcher.onIncomingAck(onAck);
  const ackEnv = makeEnvelope({ kind: "ack", body: { txHash: "0xabc" } });
  await driveWatcherWith([ackEnv]);
  expect(onAck).toHaveBeenCalledWith(expect.any(String), { txHash: "0xabc" });
});
```

The implementing engineer should adapt to the watcher's existing test helpers (`makeEnvelope`, `driveWatcherWith`, `transportMock`) — if they don't exist, build them as minimal local helpers in the test file.

- [ ] **Step 4: Run tests — expect RED**

Run: `npm test --workspace apps/desktop -- --run src/lib/comm/cemp-pq/watcher.test.ts`

- [ ] **Step 5: Modify `apps/desktop/src/lib/comm/cemp-pq/watcher.ts`**

Add `onIncomingAck` to the watcher's public interface (mirror `onIncomingPacket`/`onIncomingSignature`):

```ts
import { isExpired } from "../expires-at";
import type { IncomingAckHandler } from "../types";

// Inside the watcher implementation:

let ackHandlers: IncomingAckHandler[] = [];

// Public method:
onIncomingAck(h: IncomingAckHandler): Unsubscribe {
  ackHandlers.push(h);
  return () => { ackHandlers = ackHandlers.filter((f) => f !== h); };
},
```

In the envelope-dispatch switch, add the ack case and the expired-drop:

```ts
switch (envelope.kind) {
  case "packet": {
    if (isExpired(envelope.body.expiresAt)) {
      // Silent drop — operator's intent is the deadline.
      return;
    }
    for (const h of packetHandlers) h(envelope.senderAddrHash, envelope.body);
    // Auto-ack: fire-and-forget; failures don't block.
    transport
      .sendAck(envelope.senderProfile, { txHash: envelope.body.txHash })
      .catch((err) => {
        console.warn("[comm] auto-ack emission failed", err);
      });
    return;
  }
  case "signature": {
    for (const h of sigHandlers) h(envelope.senderAddrHash, envelope.body);
    return;
  }
  case "ack": {
    for (const h of ackHandlers) h(envelope.senderAddrHash, envelope.body);
    return;
  }
}
```

The exact shape (`envelope.senderProfile`, `envelope.senderAddrHash`) depends on what the existing watcher exposes; adapt accordingly. If the watcher doesn't have a `senderProfile`, resolve it via `transport.resolveProfile(envelope.senderAddress)` before the `sendAck` call.

- [ ] **Step 6: Run tests — expect GREEN**

Run: `npm test --workspace apps/desktop -- --run src/lib/comm/cemp-pq/watcher.test.ts`

Expected: all watcher tests pass (existing + 4 new).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/lib/comm/cemp-pq/watcher.ts apps/desktop/src/lib/comm/cemp-pq/watcher.test.ts
git commit -m "feat(2.7b-3): watcher dispatches kind=ack, drops expired packets, auto-acks"
```

---

### Task 7: Transport — sendAck + onIncomingAck

`CempPqCommTransport` now needs to implement the two methods added to the interface in Task 1.

**Files:**
- Modify: `apps/desktop/src/lib/comm/cemp-pq/transport.ts`

- [ ] **Step 1: Read `transport.ts`** to find the existing `sendSignature` + `onIncomingSignature` patterns. The ack methods mirror them.

- [ ] **Step 2: Implement `sendAck`**

Following the `sendSignature` template:

```ts
async sendAck(peer: PeerProfile, body: OutgoingAck): Promise<string> {
  return window.chainpay.commTransport.sendAck({
    recipientAddress: peer.address,
    body,
  });
}
```

The actual encoding (envelope wire format with `kind=ack`) happens in the main process (Task 8). The renderer just hands off to IPC.

- [ ] **Step 3: Implement `onIncomingAck`**

```ts
onIncomingAck(handler: IncomingAckHandler): Unsubscribe {
  return this.watcher.onIncomingAck(handler);
}
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.json`

Expected: no errors. Task 1's interface additions are now satisfied.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/comm/cemp-pq/transport.ts
git commit -m "feat(2.7b-3): CempPqCommTransport implements sendAck + onIncomingAck"
```

---

### Task 8: Main process — sendAck IPC + ack envelope encoding

The renderer's `transport.sendAck` calls `window.chainpay.commTransport.sendAck`. That handler lives in `apps/desktop/electron/main/comm-transport-service.ts` and needs to encode + broadcast the ack envelope just like `sendMessage` does for packets.

**Files:**
- Modify: `apps/desktop/electron/main/comm-transport-service.ts`
- Modify: `apps/desktop/electron/main/handlers.ts` (or wherever IPC handlers are registered — check by grep)
- Modify: `apps/desktop/electron/preload/index.ts` (or wherever the preload bridge is — check by grep)

- [ ] **Step 1: Locate the existing `sendMessage` / `sendSignature` patterns**

```bash
grep -rn "sendMessage\b\|sendSignature\b" apps/desktop/electron 2>/dev/null | head -10
```

The new `sendAck` follows the same shape.

- [ ] **Step 2: Add `sendAck` to `comm-transport-service.ts`**

Mirror `sendMessage` but with `kindByte = 0x03` (ack) and a body of just `{ txHash }` instead of the full packet.

```ts
import { serializeMessagePointer } from "cemp-pq";

const ENVELOPE_KIND_ACK = 0x03 as const;

export async function sendAck(input: {
  recipientAddress: string;
  body: { txHash: string };
}): Promise<string> {
  const envelopeBytes = encodeAckEnvelope(input.body);

  // Re-use the same tx-construction path sendMessage uses — pointer placeholder,
  // completeFeeBy, overwrite pointer with real hash post-fee, sign, broadcast.
  return sendMessageWithEnvelope(input.recipientAddress, envelopeBytes);
}

function encodeAckEnvelope(body: { txHash: string }): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(body));
  const out = new Uint8Array(22 + json.length);
  out[0] = 0x01; // ENVELOPE_VERSION
  out[1] = ENVELOPE_KIND_ACK;
  // bytes 2..22 reserved for senderHash (filled by the wrapping send path)
  out.set(json, 22);
  return out;
}
```

If `sendMessageWithEnvelope` doesn't already exist as a helper, refactor: extract the common path from `sendMessage` so both `sendMessage` (packet) and `sendAck` use it. The refactor is small (~20 lines) and removes duplication between sendMessage, sendSignature (existing), and sendAck (new).

- [ ] **Step 3: Register the IPC handler**

In `apps/desktop/electron/main/handlers.ts` (or equivalent):

```ts
ipcMain.handle("commTransport:sendAck", async (_e, input: { recipientAddress: string; body: { txHash: string } }) => {
  return sendAck(input);
});
```

- [ ] **Step 4: Add to preload bridge**

In `apps/desktop/electron/preload/index.ts`:

```ts
commTransport: {
  // ... existing methods ...
  sendAck: (input: { recipientAddress: string; body: { txHash: string } }) =>
    ipcRenderer.invoke("commTransport:sendAck", input) as Promise<string>,
},
```

- [ ] **Step 5: Update the global Window type**

In `apps/desktop/src/types/global.d.ts` (or wherever `window.chainpay` is typed):

```ts
commTransport: {
  // ...
  sendAck: (input: { recipientAddress: string; body: { txHash: string } }) => Promise<string>;
};
```

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.json`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/comm-transport-service.ts apps/desktop/electron/main/handlers.ts apps/desktop/electron/preload/index.ts apps/desktop/src/types/global.d.ts
git commit -m "feat(2.7b-3): main-process sendAck + preload IPC bridge"
```

---

### Task 9: `useCommSendRetry` hook (NEW)

App-level scheduler. Subscribes to payroll-batches changes; for each `commSendStatus.status === "sent"` slot with `retryCount < 3`, schedules a setTimeout at the appropriate delay from `updatedAt`. Cancels timers when status leaves `"sent"`. Persists implicitly via `retryCount` on the batch.

**Files:**
- Create: `apps/desktop/src/features/payments/useCommSendRetry.ts`
- Create: `apps/desktop/src/features/payments/useCommSendRetry.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { PayrollBatch, TransferPacket } from "@chain-pay/shared";
import type { CommTransport, OutgoingPacket } from "@/lib/comm/types";

const mockTransport = {
  start: vi.fn(),
  stop: vi.fn(),
  isRunning: vi.fn().mockReturnValue(true),
  publishProfile: vi.fn(),
  resolveProfile: vi.fn().mockResolvedValue({
    address: "ckt1qx", mlDsaPubKey: new Uint8Array(), mlKemPubKey: new Uint8Array(), fetchedAt: 0,
  }),
  sendPacket: vi.fn().mockResolvedValue("0x" + "01".repeat(32)),
  sendSignature: vi.fn(),
  sendAck: vi.fn(),
  onIncomingPacket: vi.fn(),
  onIncomingSignature: vi.fn(),
  onIncomingAck: vi.fn(),
} satisfies CommTransport;

vi.mock("@/lib/comm", async () => {
  const real = await vi.importActual<typeof import("@/lib/comm")>("@/lib/comm");
  return { ...real, createCommTransport: () => mockTransport };
});

import { useCommSendRetry } from "./useCommSendRetry";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { usePeerBookStore } from "@/stores/peer-book";

const HASH_A = `0x${"a1".repeat(20)}` as const;
const PACKET: OutgoingPacket = {
  txHash: `0x${"dd".repeat(32)}`,
  treasuryAddress: "ckt1qtrz",
  expiresAt: 9_999_999_999,
  packet: "encoded" as TransferPacket,
};
const sampleBatch: PayrollBatch = {
  id: "b1", label: "test", treasuryId: "t1",
  cycleStart: "2026-05-01", cycleEnd: "2026-05-31",
  fxSnapshot: [], lines: [], state: "calculated",
  sighashDigest: PACKET.txHash,
  createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z",
};

function reset(): void {
  vi.clearAllMocks();
  usePayrollBatchesStore.setState({ batches: [sampleBatch], selectedDraftId: null });
  usePeerBookStore.setState({ peers: [], knownSignersGetter: () => [] });
  usePeerBookStore.getState().addPeer(
    { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
    new Uint8Array(20).fill(0xaa),
  );
  vi.useFakeTimers();
}

describe("useCommSendRetry", () => {
  beforeEach(reset);
  afterEach(() => { vi.useRealTimers(); });

  it("schedules a retry 5min after a slot enters status='sent' with retryCount=0", () => {
    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "sent", { txHash: "0x01" });

    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(mockTransport.sendPacket).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    // setTimeout callback is sync; sendPacket is async — drain microtasks.
    return vi.runAllTimersAsync().then(() => {
      expect(mockTransport.sendPacket).toHaveBeenCalledTimes(1);
    });
  });

  it("cancels the pending retry when status flips to acked", () => {
    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "sent", { txHash: "0x01" });
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "acked");

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(mockTransport.sendPacket).not.toHaveBeenCalled();
  });

  it("uses exponential backoff: 5min then 10min then 20min", async () => {
    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "sent", { txHash: "0x01" });

    vi.advanceTimersByTime(5 * 60 * 1000 + 10);
    await vi.runAllTimersAsync();
    expect(mockTransport.sendPacket).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10 * 60 * 1000 + 10);
    await vi.runAllTimersAsync();
    expect(mockTransport.sendPacket).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(20 * 60 * 1000 + 10);
    await vi.runAllTimersAsync();
    expect(mockTransport.sendPacket).toHaveBeenCalledTimes(3);
  });

  it("stops scheduling after 3 retries", async () => {
    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "sent", { txHash: "0x01", retryCount: 3 });

    vi.advanceTimersByTime(60 * 60 * 1000);
    await vi.runAllTimersAsync();
    expect(mockTransport.sendPacket).not.toHaveBeenCalled();
  });

  it("rehydrates schedule from persisted updatedAt — if next-delay window passed, fires immediately", async () => {
    const past = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    usePayrollBatchesStore.setState({
      batches: [
        {
          ...sampleBatch,
          commSendStatus: {
            0: { status: "sent", txHash: "0x01", updatedAt: Date.parse(past), retryCount: 0 },
          },
          updatedAt: past,
        },
      ],
      selectedDraftId: null,
    });

    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    expect(mockTransport.sendPacket).toHaveBeenCalledTimes(1);
  });

  it("does not schedule for status='acked'", () => {
    renderHook(() =>
      useCommSendRetry({
        packetForBatch: () => PACKET,
        multisigForBatch: () => ({ pubkeyHashes: [HASH_A] }),
      }),
    );
    usePayrollBatchesStore.getState().recordCommSendStatus("b1", 0, "acked");
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(mockTransport.sendPacket).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — expect RED**

Run: `npm test --workspace apps/desktop -- --run src/features/payments/useCommSendRetry.test.ts`

- [ ] **Step 3: Create `apps/desktop/src/features/payments/useCommSendRetry.ts`**

```ts
import { useEffect, useRef } from "react";
import type { OutgoingPacket } from "@/lib/comm/types";
import type { MultisigRouting } from "./useCommSendDispatch";
import { usePayrollBatchesStore } from "@/stores/payroll-batches";
import { usePeerBookStore } from "@/stores/peer-book";
import { createCommTransport } from "@/lib/comm";

const RETRY_SCHEDULE_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000] as const;
const RETRY_CAP = 3;

interface UseCommSendRetryParams {
  packetForBatch: (batchId: string) => OutgoingPacket | null;
  multisigForBatch: (batchId: string) => MultisigRouting | null;
}

/**
 * App-level retry scheduler. Mounted once in App.tsx; survives PayPanel unmount.
 *
 * Subscribes to payroll-batches commSendStatus changes. For each (batchId,
 * slotIndex) entry whose status === "sent" and retryCount < RETRY_CAP,
 * schedules a re-send at the appropriate exponential delay from updatedAt.
 * Cancels timers when status leaves "sent" or retryCount caps.
 */
export function useCommSendRetry({
  packetForBatch,
  multisigForBatch,
}: UseCommSendRetryParams): void {
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    function scheduleAll(): void {
      const state = usePayrollBatchesStore.getState();
      for (const b of state.batches) {
        const status = b.commSendStatus;
        if (!status) continue;
        for (const [slot, slotStatus] of Object.entries(status)) {
          const key = `${b.id}:${slot}`;
          const existing = timersRef.current.get(key);
          if (existing) clearTimeout(existing);
          timersRef.current.delete(key);

          if (slotStatus.status !== "sent") continue;
          const count = slotStatus.retryCount ?? 0;
          if (count >= RETRY_CAP) continue;

          const nextDelay = RETRY_SCHEDULE_MS[count];
          if (nextDelay === undefined) continue;
          const elapsed = Date.now() - slotStatus.updatedAt;
          const remaining = Math.max(0, nextDelay - elapsed);

          const timer = setTimeout(() => {
            void fireRetry(b.id, Number(slot), count + 1);
            timersRef.current.delete(key);
          }, remaining);
          timersRef.current.set(key, timer);
        }
      }
    }

    async function fireRetry(batchId: string, slotIndex: number, nextCount: number): Promise<void> {
      const packet = packetForBatch(batchId);
      const multisig = multisigForBatch(batchId);
      if (!packet || !multisig) return;

      const hash = multisig.pubkeyHashes[slotIndex];
      if (!hash) return;
      const peer = usePeerBookStore.getState().findByAssociatedSignerHash(hash);
      const rec = usePayrollBatchesStore.getState().recordCommSendStatus;
      if (!peer) {
        rec(batchId, slotIndex, "error", { error: `no peer mapped to signer ${hash}` });
        return;
      }

      // Bump retryCount BEFORE the send so a successful send doesn't lose it.
      rec(batchId, slotIndex, "sent", { retryCount: nextCount });

      const transport = createCommTransport();
      if (!transport) {
        rec(batchId, slotIndex, "error", { error: "comm channel not started" });
        return;
      }

      try {
        const profile = peer.cachedProfile ?? (await transport.resolveProfile(peer.address));
        const txHash = await transport.sendPacket(profile, packet);
        rec(batchId, slotIndex, "sent", { txHash, retryCount: nextCount });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        rec(batchId, slotIndex, "error", { error });
      }
    }

    scheduleAll();
    const unsub = usePayrollBatchesStore.subscribe(scheduleAll);

    return () => {
      unsub();
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, [packetForBatch, multisigForBatch]);
}
```

Note the small extension to `recordCommSendStatus` — accepting an optional `retryCount` in `detail`. That requires a tiny update to `payroll-batches.ts`:

In `recordCommSendStatus`:

```ts
recordCommSendStatus: (batchId, slotIndex, status, detail) => {
  set((s) => ({
    batches: s.batches.map((b) => {
      if (b.id !== batchId) return b;
      const prev = b.commSendStatus?.[slotIndex];
      const slot: CommSendSlotStatus = {
        status,
        updatedAt: Date.now(),
        ...(detail?.txHash !== undefined ? { txHash: detail.txHash } : {}),
        ...(detail?.error !== undefined ? { error: detail.error } : {}),
        ...(detail?.retryCount !== undefined ? { retryCount: detail.retryCount } : {}),
      };
      return {
        ...b,
        commSendStatus: { ...(b.commSendStatus ?? {}), [slotIndex]: slot },
        updatedAt: new Date().toISOString(),
      };
    }),
  }));
},
```

And expand its signature in the `PayrollBatchesStore` interface:

```ts
recordCommSendStatus: (
  batchId: string,
  slotIndex: number,
  status: CommSendSlotStatus["status"],
  detail?: { txHash?: string; error?: string; retryCount?: number },
) => void;
```

- [ ] **Step 4: Run tests — expect GREEN**

Run: `npm test --workspace apps/desktop -- --run src/features/payments/useCommSendRetry.test.ts`

Expected: 6 passed.

- [ ] **Step 5: Run full suite to confirm no regressions**

Run: `npm test --workspace apps/desktop -- --run`

Expected: 270 + 22 (new) ≈ 292 passed, 4 skipped.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/features/payments/useCommSendRetry.ts apps/desktop/src/features/payments/useCommSendRetry.test.ts apps/desktop/src/stores/payroll-batches.ts
git commit -m "feat(2.7b-3): useCommSendRetry scheduler with exponential backoff"
```

---

### Task 10: `SignInbox` + `InboxRow` (NEW)

Inbox list of incoming packets. Each row shows nickname (resolved via peer-book), batch label (from packet), expiry, and Sign / Dismiss buttons.

**Files:**
- Create: `apps/desktop/src/features/sign/SignInbox.tsx`
- Create: `apps/desktop/src/features/sign/sign-inbox-rows/InboxRow.tsx`
- Create: `apps/desktop/src/features/sign/SignInbox.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
// apps/desktop/src/features/sign/SignInbox.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { TransferPacket } from "@chain-pay/shared";
import type { OutgoingPacket } from "@/lib/comm/types";
import { SignInbox } from "./SignInbox";
import { useIncomingPacketsStore } from "@/stores/incoming-packets";
import { usePeerBookStore } from "@/stores/peer-book";

const SENDER_A_HASH = `0x${"aa".repeat(20)}` as const;
const SENDER_B_HASH = `0x${"bb".repeat(20)}` as const;

function packetFor(label: string, expiresAt: number): OutgoingPacket {
  return {
    txHash: `0x${label.padEnd(64, "0")}`,
    treasuryAddress: "ckt1qtrz",
    expiresAt,
    packet: `encoded-${label}` as TransferPacket,
  };
}

function reset(): void {
  useIncomingPacketsStore.setState({ bySighash: {} });
  usePeerBookStore.setState({ peers: [], knownSignersGetter: () => [] });
  globalThis.localStorage?.clear?.();
}

describe("SignInbox", () => {
  beforeEach(reset);
  afterEach(cleanup);

  it("renders empty-state copy when no entries", () => {
    render(<SignInbox onClaim={() => {}} />);
    expect(screen.getByText(/no comm packets pending/i)).toBeInTheDocument();
  });

  it("renders one row per entry", () => {
    const p1 = packetFor("aa", Math.floor(Date.now() / 1000) + 3600);
    const p2 = packetFor("bb", Math.floor(Date.now() / 1000) + 7200);
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: p1.txHash, packet: p1, senderAddrHash: SENDER_A_HASH, receivedAt: 1,
    });
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: p2.txHash, packet: p2, senderAddrHash: SENDER_B_HASH, receivedAt: 2,
    });
    render(<SignInbox onClaim={() => {}} />);
    expect(screen.getAllByRole("button", { name: /sign/i })).toHaveLength(2);
  });

  it("clicking Sign calls onClaim with that entry", () => {
    const p = packetFor("aa", Math.floor(Date.now() / 1000) + 3600);
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: p.txHash, packet: p, senderAddrHash: SENDER_A_HASH, receivedAt: 1,
    });
    const onClaim = vi.fn();
    render(<SignInbox onClaim={onClaim} />);
    fireEvent.click(screen.getByRole("button", { name: /sign/i }));
    expect(onClaim).toHaveBeenCalledWith(expect.objectContaining({ sighashDigest: p.txHash }));
  });

  it("clicking Dismiss removes the entry from the store", () => {
    const p = packetFor("aa", Math.floor(Date.now() / 1000) + 3600);
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: p.txHash, packet: p, senderAddrHash: SENDER_A_HASH, receivedAt: 1,
    });
    render(<SignInbox onClaim={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(useIncomingPacketsStore.getState().bySighash[p.txHash]).toBeUndefined();
  });

  it("filters out expired entries (does not render)", () => {
    const expiredP = packetFor("aa", Math.floor(Date.now() / 1000) - 60);
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: expiredP.txHash, packet: expiredP, senderAddrHash: SENDER_A_HASH, receivedAt: 1,
    });
    render(<SignInbox onClaim={() => {}} />);
    expect(screen.getByText(/no comm packets pending/i)).toBeInTheDocument();
  });

  it("sorts entries newest-first by receivedAt", () => {
    const older = packetFor("aa", Math.floor(Date.now() / 1000) + 3600);
    const newer = packetFor("bb", Math.floor(Date.now() / 1000) + 3600);
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: older.txHash, packet: older, senderAddrHash: SENDER_A_HASH, receivedAt: 1,
    });
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: newer.txHash, packet: newer, senderAddrHash: SENDER_B_HASH, receivedAt: 2,
    });
    render(<SignInbox onClaim={() => {}} />);
    const buttons = screen.getAllByRole("button", { name: /sign/i });
    // First button (top of list) is for the newer entry.
    expect(buttons[0]!.closest("li")).toHaveTextContent(/bb/);
  });
});
```

- [ ] **Step 2: Run tests — expect RED**

Run: `npm test --workspace apps/desktop -- --run src/features/sign/SignInbox.test.tsx`

- [ ] **Step 3: Create `InboxRow.tsx`**

```tsx
// apps/desktop/src/features/sign/sign-inbox-rows/InboxRow.tsx
import type { IncomingPacketEntry } from "@/stores/incoming-packets";
import { usePeerBookStore } from "@/stores/peer-book";

interface InboxRowProps {
  entry: IncomingPacketEntry;
  onSign: () => void;
  onDismiss: () => void;
}

function shortSighash(hash: string): string {
  if (hash.length < 14) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-4)}`;
}

function expiresLabel(epochSec: number | undefined): string {
  if (!epochSec || epochSec <= 0) return "no expiry";
  const ms = epochSec * 1000 - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `expires in ${mins}m`;
  const hours = Math.round(mins / 60);
  return `expires in ${hours}h`;
}

export function InboxRow({ entry, onSign, onDismiss }: InboxRowProps) {
  const peer = usePeerBookStore((s) =>
    s.peers.find((p) => p.addrHash === entry.senderAddrHash),
  );
  const senderLabel = peer?.nickname ?? `unknown sender ${shortSighash(entry.senderAddrHash)}`;

  return (
    <li className="space-y-1 rounded border border-surface-hi bg-surface-lo p-3" data-testid={`inbox-row-${entry.sighashDigest}`}>
      <div className="font-medium">{senderLabel}</div>
      <div className="font-mono text-xs text-fg-muted">{shortSighash(entry.sighashDigest)}</div>
      <div className="text-xs text-fg-muted">{expiresLabel(entry.packet.expiresAt)}</div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="rounded px-2 py-0.5 text-xs text-fg-muted hover:text-fg"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={onSign}
          className="rounded bg-accent px-2 py-0.5 text-xs text-accent-fg"
        >
          Sign
        </button>
      </div>
    </li>
  );
}
```

- [ ] **Step 4: Create `SignInbox.tsx`**

```tsx
// apps/desktop/src/features/sign/SignInbox.tsx
import { useMemo } from "react";
import { useIncomingPacketsStore, type IncomingPacketEntry } from "@/stores/incoming-packets";
import { isExpired } from "@/lib/comm/expires-at";
import { InboxRow } from "./sign-inbox-rows/InboxRow";

interface SignInboxProps {
  onClaim: (entry: IncomingPacketEntry) => void;
}

export function SignInbox({ onClaim }: SignInboxProps) {
  const bySighash = useIncomingPacketsStore((s) => s.bySighash);
  const dismiss = useIncomingPacketsStore((s) => s.dismiss);

  const entries = useMemo(() => {
    return Object.values(bySighash)
      .filter((e) => !isExpired(e.packet.expiresAt))
      .sort((a, b) => b.receivedAt - a.receivedAt);
  }, [bySighash]);

  return (
    <section
      className="space-y-3 rounded-lg border border-surface-hi bg-surface p-5"
      aria-label="Sign inbox"
    >
      <header>
        <div className="text-xs uppercase tracking-wide text-fg-muted">Inbox</div>
        <p className="mt-1 text-sm text-fg-muted">
          Comm packets pending your signature.
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="text-sm italic text-fg-muted">
          No comm packets pending. Operators will appear here once they send.
        </p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <InboxRow
              key={e.sighashDigest}
              entry={e}
              onSign={() => onClaim(e)}
              onDismiss={() => dismiss(e.sighashDigest)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run tests — expect GREEN**

Run: `npm test --workspace apps/desktop -- --run src/features/sign/SignInbox.test.tsx`

Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/features/sign/SignInbox.tsx apps/desktop/src/features/sign/sign-inbox-rows/InboxRow.tsx apps/desktop/src/features/sign/SignInbox.test.tsx
git commit -m "feat(2.7b-3): SignInbox UI with InboxRow subcomponent"
```

---

### Task 11: `SignPanel` integration — claim handler

Mount `<SignInbox />` above the existing paste textarea. `handleClaim(entry)` populates the same state variables the paste flow sets, then dismisses the entry from the inbox.

**Files:**
- Modify: `apps/desktop/src/features/sign/SignPanel.tsx`

- [ ] **Step 1: Read the current SignPanel to find the paste handler + state init**

```bash
wc -l apps/desktop/src/features/sign/SignPanel.tsx
grep -n "handlePaste\|setPacketJson\|setTreasuryId\|setSkeleton\b" apps/desktop/src/features/sign/SignPanel.tsx | head
```

- [ ] **Step 2: Add `<SignInbox />` mount + `handleClaim` callback**

At the top of `SignPanel.tsx`, add imports:

```tsx
import { SignInbox } from "./SignInbox";
import type { IncomingPacketEntry } from "@/stores/incoming-packets";
import { useIncomingPacketsStore } from "@/stores/incoming-packets";
```

Inside the component, add a `handleClaim` function that mirrors the existing paste handler's state-setting logic:

```tsx
const handleClaim = (entry: IncomingPacketEntry) => {
  // entry.packet.packet is the TransferPacket string — same shape paste textarea accepts.
  // Reuse the existing paste-to-state handler.
  handlePaste(entry.packet.packet);
  useIncomingPacketsStore.getState().dismiss(entry.sighashDigest);
};
```

If `handlePaste` is named differently (e.g., `applyPastedPacket`), substitute accordingly.

In the render output, mount `<SignInbox />` above the paste section:

```tsx
return (
  <div className="space-y-4">
    <SignInbox onClaim={handleClaim} />
    {/* existing paste section, signature collection, etc. */}
    {/* ... */}
  </div>
);
```

- [ ] **Step 3: Run typecheck + tests**

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.json`
Run: `npm test --workspace apps/desktop -- --run`

Expected: clean typecheck; all suites green.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/features/sign/SignPanel.tsx
git commit -m "feat(2.7b-3): SignPanel mounts SignInbox and routes claim → paste flow"
```

---

### Task 12: `ClipboardBar` render gate + Settings Debug toggle

Hide the bar when comm is configured + debug-clipboard is off. Re-enable via Settings → Debug.

**Files:**
- Modify: `apps/desktop/src/components/clipboard/ClipboardBar.tsx`
- Modify: `apps/desktop/src/features/settings/Settings.tsx`

- [ ] **Step 1: Read the current ClipboardBar**

```bash
head -30 apps/desktop/src/components/clipboard/ClipboardBar.tsx
```

- [ ] **Step 2: Edit `ClipboardBar.tsx` — add render gate**

At the top of the component function:

```tsx
import { useCommIdentityStore } from "@/stores/comm-identity";
import { useDebugSettingsStore } from "@/stores/debug-settings";

export function ClipboardBar() {
  const identity = useCommIdentityStore((s) => s.identity);
  const showClipboard = useDebugSettingsStore((s) => s.showClipboard);
  const commActive = identity?.profileTxHash != null;
  if (commActive && !showClipboard) return null;
  // ... existing render ...
}
```

- [ ] **Step 3: Add Debug section to `Settings.tsx`**

In the Settings render output, after `<PeerBookSection />`, add:

```tsx
import { useDebugSettingsStore } from "@/stores/debug-settings";

// Inside Settings():
const showClipboard = useDebugSettingsStore((s) => s.showClipboard);
const setShowClipboard = useDebugSettingsStore((s) => s.setShowClipboard);

// In render output:
<section className="space-y-3 rounded-lg border border-surface-hi bg-surface p-5" aria-label="Debug">
  <header>
    <div className="text-xs uppercase tracking-wide text-fg-muted">Debug</div>
    <p className="mt-1 text-sm text-fg-muted">
      Tools for debugging, generally not needed in normal operation.
    </p>
  </header>
  <label className="flex items-center gap-2 text-sm">
    <input
      type="checkbox"
      checked={showClipboard}
      onChange={(e) => setShowClipboard(e.target.checked)}
    />
    Show clipboard bottom-bar (overrides auto-hide when comm is configured)
  </label>
</section>
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace apps/desktop -- --run`

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/clipboard/ClipboardBar.tsx apps/desktop/src/features/settings/Settings.tsx
git commit -m "feat(2.7b-3): clipboard demoted when comm active; Settings Debug toggle"
```

---

### Task 13: App.tsx — wire onIncomingAck + mount retry scheduler

App.tsx gains two pieces:

1. A subscription on `onIncomingAck` that resolves sender → peer → slot and flips the operator's status pill to `"acked"`.
2. A mount of `useCommSendRetry({ packetForBatch, multisigForBatch })` with resolvers that look up live batch + treasury state.

**Files:**
- Modify: `apps/desktop/src/App.tsx`

- [ ] **Step 1: Add imports**

```tsx
import { useIncomingPacketsStore } from "./stores/incoming-packets";
import { useCommSendRetry } from "./features/payments/useCommSendRetry";
import { isExpired } from "./lib/comm/expires-at";
import type { OutgoingPacket } from "./lib/comm/types";
import type { MultisigRouting } from "./features/payments/useCommSendDispatch";
```

- [ ] **Step 2: Extend `useCommTransportBoot` to also enqueue packets + dispatch acks**

Inside the existing `useCommTransportBoot` `useEffect`, after the existing `onIncomingSignature` subscription, add:

```ts
// Packet receive — enqueue into incoming-packets (after watcher's expiresAt check).
const offPacket = transport?.onIncomingPacket((senderHash, body) => {
  // Defensive: even though the watcher drops expired packets, double-check here.
  if (isExpired(body.expiresAt)) return;
  useIncomingPacketsStore.getState().enqueue({
    sighashDigest: body.txHash,
    packet: body,
    senderAddrHash: senderHash,
    receivedAt: Date.now(),
  });
});

// Ack receive — resolve sender → peer → slot, flip status to "acked".
const offAck = transport?.onIncomingAck((senderHash, body) => {
  const peer = usePeerBookStore.getState().findByAddrHash(senderHash as `0x${string}`);
  if (!peer) return;
  const batch = usePayrollBatchesStore
    .getState()
    .batches.find((b) => b.sighashDigest === body.txHash);
  if (!batch) return;
  const treasury = useTreasuryStore
    .getState()
    .treasuries.find((t) => t.id === batch.treasuryId);
  if (!treasury || !("pubkeyHashes" in treasury.multisig)) return;
  if (peer.associatedSignerHash === undefined) return;
  const slotIndex = treasury.multisig.pubkeyHashes.indexOf(peer.associatedSignerHash);
  if (slotIndex < 0) return;
  usePayrollBatchesStore
    .getState()
    .recordCommSendStatus(batch.id, slotIndex, "acked");
});

return () => {
  unsub();
  offSig?.();
  offPacket?.();
  offAck?.();
  const transport = createCommTransport();
  void transport?.stop();
};
```

- [ ] **Step 3: Mount the retry scheduler**

In the App component body (after `useCommTransportBoot()`):

```tsx
function App() {
  useCommTransportBoot();
  useCommSendRetry({
    packetForBatch: (batchId) => {
      const batch = usePayrollBatchesStore.getState().findById(batchId);
      if (!batch || !batch.sighashDigest) return null;
      const treasury = useTreasuryStore
        .getState()
        .treasuries.find((t) => t.id === batch.treasuryId);
      if (!treasury || !("pubkeyHashes" in treasury.multisig)) return null;
      // packetJson is volatile (re-encoded per PayPanel render); the retry uses
      // a placeholder. The proper fix is to persist the encoded packet on the
      // batch — for 2.7b-3 we use a no-op retry when packet text isn't recoverable
      // (operator can use manual Retry button instead). Stub returns null.
      return null;
    },
    multisigForBatch: (batchId) => {
      const batch = usePayrollBatchesStore.getState().findById(batchId);
      if (!batch) return null;
      const treasury = useTreasuryStore
        .getState()
        .treasuries.find((t) => t.id === batch.treasuryId);
      if (!treasury || !("pubkeyHashes" in treasury.multisig)) return null;
      return { pubkeyHashes: treasury.multisig.pubkeyHashes };
    },
  });

  // ... existing return ...
}
```

**Note to implementing engineer:** the `packetForBatch` resolver returning `null` is a known limitation — the retry can't reconstruct the original packet without it being persisted on `PayrollBatch`. Two options:

  (a) **Persist `commPacket` on `PayrollBatch`** alongside `txBytes` — add `commPacket?: string` to the shared interface, write it from PayPanel at build time. Adds one schema field; retry then has everything.

  (b) **Document the limitation, defer to 2.7c**. Auto-retry only works if PayPanel was open at send time (in-memory packet); cold-start retry returns null and falls through. Operator's manual Retry button still works.

For this plan we go with (a) — clean schema-additive change. Add `commPacket?: string` to `PayrollBatch` in `packages/shared/src/payroll.ts` (with a doc comment), populate it in PayPanel's send path where `packetJson` is set, and read it in `packetForBatch`. Updated `packetForBatch`:

```ts
packetForBatch: (batchId) => {
  const batch = usePayrollBatchesStore.getState().findById(batchId);
  if (!batch || !batch.sighashDigest || !batch.commPacket) return null;
  const treasury = useTreasuryStore
    .getState()
    .treasuries.find((t) => t.id === batch.treasuryId);
  if (!treasury || !("pubkeyHashes" in treasury.multisig)) return null;
  return {
    txHash: batch.sighashDigest,
    treasuryAddress: treasury.multisig.address,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    packet: batch.commPacket as TransferPacket,
  };
},
```

Add `commPacket` to `PayrollBatch` in shared:

```ts
/** Cleartext TransferPacket string, persisted at build time so the retry
 *  scheduler can rebroadcast even after PayPanel unmounts. Same string the
 *  signer would have pasted; not sensitive (already encrypted per-peer on chain). */
commPacket?: string;
```

Populate it in PayPanel's build flow (the place where `setPacketJson(json)` is called):

```ts
batchStore.updateBatch(activeBatchId, {
  // ... existing ...
  commPacket: json,
});
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.json`
Run: `npm test --workspace apps/desktop -- --run`

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx packages/shared/src/payroll.ts apps/desktop/src/features/payments/PayPanel.tsx
git commit -m "feat(2.7b-3): App.tsx wires onIncomingAck + retry scheduler; persist commPacket on batch"
```

---

### Task 14: Smoke extension — wait for ack before signing

The 2.7b-2 smoke already broadcasts a packet (A→B) and a signature (B→A). 2.7b-3 adds: after Role B receives the packet, wait for the auto-ack envelope to land on Role A's lock before sending the signature reply. This validates `sendAck` end-to-end on testnet.

**Files:**
- Modify: `scripts/smoke-comm-roundtrip.mts`

- [ ] **Step 1: Add a `waitForAck` helper**

Append to `scripts/smoke-comm-roundtrip.mts`, near the existing `pollIncoming`:

```ts
async function waitForAckOn(
  ownAddress: string,
  expectedTxHash: string,
  maxWaitSec = 60,
): Promise<void> {
  // Role A polls its own lock for a kind=ack envelope referencing expectedTxHash.
  // Same dereference convention as pollIncoming (notification at index 0,
  // message cell at outputs[0]).
  const client = makeClient();
  const ownLock = (await ccc.Address.fromString(ownAddress, client)).script;
  const deadline = Date.now() + maxWaitSec * 1000;
  const seen = new Set<string>();
  while (Date.now() < deadline) {
    const resp = await client.findCellsPaged(
      { script: ownLock, scriptType: "lock", scriptSearchMode: "exact" },
      "asc",
      50n,
    );
    for (const c of resp.cells) {
      const key = `${c.outPoint.txHash}:${c.outPoint.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!c.outputData || c.outputData === "0x") continue;
      try {
        const decryptedHex = await decryptIncoming({
          txHash: c.outPoint.txHash, index: 0,
        });
        const bytes = Uint8Array.from(Buffer.from(decryptedHex.slice(2), "hex"));
        const decoded = decodeEnvelope(bytes);
        const body = decoded.payload as { txHash?: string };
        if (decoded.kind === "ack" && body.txHash === expectedTxHash) {
          console.log(`[smoke] ack received for ${expectedTxHash}`);
          return;
        }
      } catch {
        // skip
      }
    }
    await sleep(5_000);
  }
  throw new Error(`timeout waiting for ack on ${expectedTxHash}`);
}
```

Also extend `decodeEnvelope`'s kind classification:

```ts
const KIND_ACK = 0x03;
const kind: DecodedEnvelope["kind"] =
  kindByte === KIND_PACKET ? "packet"
  : kindByte === KIND_SIGNATURE ? "signature"
  : kindByte === KIND_ACK ? "ack"
  : "unknown";

interface DecodedEnvelope {
  kind: "packet" | "signature" | "ack" | "unknown";
  // ...
}
```

- [ ] **Step 2: Call `waitForAckOn` inside `runRoleA`**

After `[smoke] packet sent: ${bundle.txHash}` and before `[smoke] waiting for FIXTURE_SIGNATURE reply from B...`:

```ts
if (process.env["SMOKE_SKIP_ACK"] !== "1") {
  console.log("[smoke] waiting for ack from B...");
  await waitForAckOn(address, bundle.txHash);
} else {
  console.log("[smoke] skipping ack wait (SMOKE_SKIP_ACK=1)");
}
```

- [ ] **Step 3: Smoke-test the script locally (syntax / type only)**

```bash
npx tsx --typeCheck scripts/smoke-comm-roundtrip.mts || true
```

Actual runtime verification happens on testnet (manual step).

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-comm-roundtrip.mts
git commit -m "feat(2.7b-3): smoke waits for ack envelope before signature reply"
```

---

### Task 15: Push branch + open PR #4

**Files:** (none — git only)

- [ ] **Step 1: Push**

```bash
git push -u origin feat/phase-2-7b-3-signer-side-and-polish
```

- [ ] **Step 2: Open PR #4 against `main`**

```bash
gh pr create --base main \
  --title "feat(2.7b-3): signer-side comm UI + ack loop + retry + clipboard demote" \
  --body "$(cat <<'EOF'
## Summary

Closes the Phase 2.7 comm-channel epic. After this PR:

- The signer's app has an **inbox** for incoming comm packets. Clicking Sign loads the packet into the existing paste-based sign flow; Dismiss removes it locally.
- The signer's transport **auto-acks on receive**. The operator's `commSendStatus[slot]` pill flips `sent → acked` as soon as the signer's machine has the packet.
- The operator's transport **auto-retries** missing acks at 5min / 10min / 20min (cap 3). Manual Retry from 2.7b-2 still works.
- Packets with **expired `expiresAt`** are dropped silently at watcher level — no inbox entry, no ack, operator's pill stays at `sent`.
- The **clipboard bottom-bar is hidden** once a comm identity + profile exist. Re-enable via Settings → Debug → "Show clipboard bar".

## What this PR does NOT do (deferred to 2.7c+)

- Auto-broadcast at M sigs
- Group ack consensus
- Per-peer rate limiting
- Cell consumption / reclaim
- Address rotation, forward secrecy, mainnet readiness
- Notification UI for auto-state-transition

## Files

**New (10)**: incoming-packets store, debug-settings store, expires-at helper, useCommSendRetry hook, SignInbox + InboxRow.

**Modified (7)**: CommSendSlotStatus.retryCount, peer-book v1→v2 migration with addrHash, watcher (ack dispatch + expired drop + auto-ack), cemp-pq transport.sendAck/onIncomingAck, comm-transport-service main-process sendAck, App.tsx onIncomingAck + retry boot, SignPanel inbox mount, ClipboardBar render gate, Settings Debug section, smoke ack wait.

## Test plan

- [ ] \`npm test --workspace apps/desktop -- --run\` passes (~305 tests)
- [ ] \`npx tsc --noEmit -p apps/desktop/tsconfig.json\` clean
- [ ] Manual: operator sends → signer receives → operator pill flips to "acked"
- [ ] Manual: operator sends → signer offline → 5min later operator app rebroadcasts
- [ ] Manual: signer claims → sign flow pre-populates → signs → operator partialSigs auto-fill
- [ ] Manual: clipboard hidden after comm ceremony; Settings → Debug toggle re-enables it
- [ ] Smoke: \`scripts/smoke-comm-roundtrip.mts\` runs A→B with ack roundtrip on testnet

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Confirm PR URL** is printed; share with team.

---

## Self-Review

- [x] **Spec coverage**: every section of the spec maps to a task.
  - SignPanel inbox → T10 + T11
  - Auto-ack on receive → T6 + T7 + T8
  - Operator auto-retry → T9 + T13
  - `expiresAt` enforcement → T5 + T6 + T10 (filter)
  - Clipboard demotion → T12
  - Peer-book addrHash + findByAddrHash → T2
  - Smoke extension → T14

- [x] **Placeholder scan**: no TBDs, no "TODO", no "similar to Task N" hand-waves. Every code step has a code block. The known limitation in Task 13 (packetForBatch) is documented + the schema-additive fix (`commPacket`) is fully spelled out.

- [x] **Type consistency**: method names match across tasks. `recordCommSendStatus` signature updated in Task 9 to accept `retryCount` and used consistently in Tasks 9+13. `Peer.addrHash` typed `\`0x${string}\`` everywhere. `OutgoingAck = { txHash: string }` consistent.

- [x] **Scope check**: single PR, ~17 commits, ~305 tests target. Comparable in size to 2.7b-2 (which shipped 11 commits, 41 new tests).

No issues found. Plan is ready for execution.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-phase-2-7b-3-signer-side-and-polish.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a large plan like this where each task is well-defined and isolated.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Better if you want to be in the loop on each commit.

Either way, prerequisite is **PR #3 must be merged into main first** (then rebase this branch onto post-merge main via the command at the top of this doc).
