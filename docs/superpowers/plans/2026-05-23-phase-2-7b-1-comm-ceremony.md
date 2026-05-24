# Phase 2.7b-1 — Comm Ceremony & Transport Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the CEMP-PQ MessagePointer gap so the smoke roundtrip actually completes; wire the transport on app boot; build the Settings → Comm Channel ceremony so a user can set up their identity from the GUI.

**Architecture:** Two phases. **Phase A — Transport fixes (Tasks 1-12)**: patch vendored `packages/cemp-pq/tx-builder.js` to write a MessagePointer into the notification cell, enrich `fetchRecipientProfile`, cache the parsed 20-byte address hash on the identity record so `getOwnIdentityHash()` works in production, key the CommTransport singleton by `identity.address` for auto-invalidation on identity change, and wire the boot effect that auto-starts the transport in `App.tsx`. **Phase B — Settings ceremony (Tasks 13-19)**: a state-machine container with four step components (NotConfigured / Funding / Publishing / Ready) driven by a single hook reading `useCommIdentityStore`.

**Tech Stack:** TypeScript 5.6, React 19, Electron 33, Vitest 4.1, Zustand 5 (persisted), `@ckb-ccc/core` 1.12, `@noble/post-quantum` (transitive via CEMP-PQ), Tailwind 4. Working directory: `/home/phill/chain-pay/.worktrees/phase-2-7b-1` on branch `feat/phase-2-7b-1-comm-ceremony` (stacked on `feat/phase-2-7a-comm-transport`).

**Spec reference:** `docs/superpowers/specs/2026-05-23-phase-2-7b-1-comm-ceremony-design.md`

---

## Plan overview

19 tasks across 2 phases. Each task is one TDD cycle where applicable (failing test → minimal impl → green → commit). Tests targeted: ~35 new + ~6 modifications, total project ~177 tests.

| # | Phase | Task | Files touched |
|---|-------|------|---------------|
| 1 | A | Patch CEMP-PQ tx-builder — MessagePointer write | `packages/cemp-pq/tx-builder.js` |
| 2 | A | Patch CEMP-PQ tx-builder — fetchRecipientProfile enrichment | `packages/cemp-pq/tx-builder.js` |
| 3 | A | First test in vendored cemp-pq (Node built-in test) | `packages/cemp-pq/tx-builder.test.js`, `packages/cemp-pq/package.json` |
| 4 | A | Update cemp-pq TypeScript surface for new shape | `packages/cemp-pq/index.d.ts` |
| 5 | A | Add `addrHash` to `CommIdentityState` + v1→v2 migration | `apps/desktop/src/stores/comm-identity.{ts,test.ts}` |
| 6 | A | Update main-process service for addrHash + richer profile | `apps/desktop/electron/main/comm-transport-service.ts` |
| 7 | A | Tests for comm-transport-service (NEW file) | `apps/desktop/electron/main/comm-transport-service.test.ts` |
| 8 | A | Make `getOwnIdentityHash()` work in production | `apps/desktop/src/lib/comm/own-identity-hash.{ts,test.ts}` |
| 9 | A | Update preload bridge types for `addrHash` | `apps/desktop/electron/preload/index.ts`, `apps/desktop/src/vite-env.d.ts` |
| 10 | A | Address-keyed singleton + `resetCommTransport()` | `apps/desktop/src/lib/comm/index.{ts,test.ts}` |
| 11 | A | Boot effect in `App.tsx` (`useCommTransportBoot`) | `apps/desktop/src/App.tsx` |
| 12 | A | Phase-A integration check (typecheck + tests + build) | n/a — verification only |
| 13 | B | New error classes for ceremony | `apps/desktop/src/lib/comm/errors.ts` |
| 14 | B | `useCommChannelSetup` hook + tests | `apps/desktop/src/features/settings/useCommChannelSetup.{ts,test.ts}` |
| 15 | B | `NotConfiguredStep` component | `apps/desktop/src/features/settings/steps/NotConfiguredStep.tsx` |
| 16 | B | `FundingStep` component (balance poll) | `apps/desktop/src/features/settings/steps/FundingStep.tsx` |
| 17 | B | `PublishingStep` + `ReadyStep` components | `apps/desktop/src/features/settings/steps/{PublishingStep,ReadyStep}.tsx` |
| 18 | B | `CommChannelSection` container + tests | `apps/desktop/src/features/settings/CommChannelSection.{tsx,test.tsx}` |
| 19 | B | Wire `CommChannelSection` into `Settings.tsx` | `apps/desktop/src/features/settings/Settings.tsx` |

After Task 19: rebuild, manual smoke roundtrip on testnet to verify Phase 2.7b-1 done.

---

# Phase A — Transport fixes

### Task 1: Patch CEMP-PQ `buildSendMessageTx` to write MessagePointer

**Files:**
- Modify: `packages/cemp-pq/tx-builder.js`

The vendored `buildSendMessageTx` puts the encrypted envelope in `outputs[0]` (sender's lock) and leaves `outputs[1]` (recipient's notification cell) with `"0x"` data. The watcher polls the recipient's lock, finds empty data, silently drops. This task fixes that by serializing a `MessagePointer(messageTxHash, 0)` into the notification cell's outputData.

- [ ] **Step 1: Read the current `buildSendMessageTx` to find the right injection site**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
sed -n '140,200p' packages/cemp-pq/tx-builder.js
```

Identify:
- Where `outputs[1]` (the notification cell) is constructed
- Where `outputsData` is assigned
- Where the final `tx` object is ready (after `completeInputsByCapacity` + `completeFeeBy`)

The pointer write must happen AFTER `completeFeeBy` (so tx structure is final) but BEFORE `signOnlyTransaction` (so the witness isn't filled yet — tx hash excludes witness in CCC).

- [ ] **Step 2: Add the MessagePointer write**

Find the section that returns `tx` at the end of `buildSendMessageTx`. Just before the return, add:

```js
// Phase 2.7b-1: write MessagePointer into the notification cell so receivers
// can locate the corresponding Message Cell. Pre-witness tx.hash() is stable.
const messageTxHash = tx.hash();
const messagePointer = serializeMessagePointer(messageTxHash, 0);
tx.outputsData[1] = "0x" + Buffer.from(messagePointer).toString("hex");
return tx;
```

`serializeMessagePointer` is already exported from `packages/cemp-pq/index.js` and imported at the top of `tx-builder.js`. If it's not imported, add:

```js
import { serializeMessagePointer } from "./index.js";
```

- [ ] **Step 3: Smoke-test the change manually**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
node -e "
import('cemp-pq').then(m => {
  console.log('serializeMessagePointer present:', typeof m.serializeMessagePointer);
});
"
```

Expected: `serializeMessagePointer present: function`.

Then quick syntactic check that the file still parses:

```bash
node --check packages/cemp-pq/tx-builder.js
```

Expected: no output (silent success).

- [ ] **Step 4: Commit**

```bash
git add packages/cemp-pq/tx-builder.js
git commit -m "fix(cemp-pq): write MessagePointer into notification cell data"
```

---

### Task 2: Patch CEMP-PQ `fetchRecipientProfile` to return richer shape

**Files:**
- Modify: `packages/cemp-pq/tx-builder.js`

Currently returns bare `Uint8Array` (just the ML-KEM pubkey) and throws on not-found. The spec calls for `{ mlDsaPubKey, mlKemPubKey, metadata }` and `null` on not-found.

- [ ] **Step 1: Read current `fetchRecipientProfile`**

```bash
sed -n '85,120p' packages/cemp-pq/tx-builder.js
```

Identify how the profile cell data is currently unpacked and what fields are reachable.

- [ ] **Step 2: Rewrite to return the richer shape**

Replace the body of `fetchRecipientProfile` with:

```js
async fetchRecipientProfile(recipientLock) {
  // Iterate cells at recipient's lock. Pick the one that looks like a Profile Cell
  // (data length > 3000 bytes — the placeholder until upstream finalises a type script).
  for await (const cell of this.#client.findCells({
    script: recipientLock,
    scriptType: "lock",
    scriptSearchMode: "exact",
    withData: true,
  })) {
    if (!cell.outputData || cell.outputData === "0x") continue;
    const dataBytes = Buffer.from(cell.outputData.slice(2), "hex");
    if (dataBytes.length < 3000) continue;
    // Profile molecule layout (per packages/cemp-pq/index.js::serializeProfile):
    //   full_size(4) | off_dsa(4) | off_kem(4) | off_meta(4)
    //   | dsa_len(4) + dsa_bytes(1952)
    //   | kem_len(4) + kem_bytes(1184)
    //   | meta_len(4) + meta_bytes(variable)
    const offDsa = dataBytes.readUInt32LE(4);
    const offKem = dataBytes.readUInt32LE(8);
    const offMeta = dataBytes.readUInt32LE(12);
    const dsaLen = dataBytes.readUInt32LE(offDsa);
    const mlDsaPubKey = dataBytes.subarray(offDsa + 4, offDsa + 4 + dsaLen);
    const kemLen = dataBytes.readUInt32LE(offKem);
    const mlKemPubKey = dataBytes.subarray(offKem + 4, offKem + 4 + kemLen);
    const metaLen = dataBytes.readUInt32LE(offMeta);
    const metadata = dataBytes.subarray(offMeta + 4, offMeta + 4 + metaLen);
    return { mlDsaPubKey, mlKemPubKey, metadata };
  }
  return null;
}
```

**Implementer note:** If `this.#client` uses a different identifier in the actual file (e.g. `this.client` without the private # syntax), match the existing convention. Read the constructor in `tx-builder.js` to verify.

- [ ] **Step 3: Verify the file parses**

```bash
node --check packages/cemp-pq/tx-builder.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add packages/cemp-pq/tx-builder.js
git commit -m "feat(cemp-pq): fetchRecipientProfile returns full profile, null on miss"
```

---

### Task 3: Add Node-native tests for the cemp-pq patches

**Files:**
- Create: `packages/cemp-pq/tx-builder.test.js`
- Modify: `packages/cemp-pq/package.json`

First test inside the vendored package. Uses Node's built-in test runner — no new tooling for cemp-pq.

- [ ] **Step 1: Add test script to package.json**

Open `packages/cemp-pq/package.json`. In the `"scripts"` block (add it if absent), add:

```json
{
  "scripts": {
    "test": "node --test"
  }
}
```

Full package.json should now look like:

```json
{
  "name": "cemp-pq",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "CKB Post-Quantum Encrypted Messaging Protocol (vendored from ~/ecms/cemp-pq)",
  "main": "index.js",
  "types": "index.d.ts",
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "default": "./index.js"
    },
    "./tx-builder": {
      "default": "./tx-builder.js"
    }
  },
  "scripts": {
    "test": "node --test"
  },
  "dependencies": {
    "@ckb-ccc/core": "^1.12.0",
    "@noble/hashes": "^1.8.0",
    "@noble/post-quantum": "^0.2.1"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/cemp-pq/tx-builder.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeMessagePointer, serializeProfile } from "./index.js";

test("serializeMessagePointer produces a parseable molecule", () => {
  const txHash = "0x" + "ab".repeat(32);
  const bytes = serializeMessagePointer(txHash, 0);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length >= 36, `expected at least 36 bytes, got ${bytes.length}`);
});

test("fetchRecipientProfile parses serializeProfile output (roundtrip)", async () => {
  // Encode a profile, then verify the offset-based parsing matches.
  const dsaPub = new Uint8Array(1952).fill(0xa1);
  const kemPub = new Uint8Array(1184).fill(0xa2);
  const meta = new TextEncoder().encode(JSON.stringify({ displayName: "Test" }));
  const profileBytes = serializeProfile(dsaPub, kemPub, meta);

  // Parse via the same offset logic as fetchRecipientProfile.
  const offDsa = new DataView(profileBytes.buffer, profileBytes.byteOffset).getUint32(4, true);
  const offKem = new DataView(profileBytes.buffer, profileBytes.byteOffset).getUint32(8, true);
  const offMeta = new DataView(profileBytes.buffer, profileBytes.byteOffset).getUint32(12, true);

  const dsaLen = new DataView(profileBytes.buffer, profileBytes.byteOffset).getUint32(offDsa, true);
  assert.equal(dsaLen, 1952);

  const kemLen = new DataView(profileBytes.buffer, profileBytes.byteOffset).getUint32(offKem, true);
  assert.equal(kemLen, 1184);

  const metaLen = new DataView(profileBytes.buffer, profileBytes.byteOffset).getUint32(offMeta, true);
  assert.equal(metaLen, meta.length);

  // Extracted byte equality
  const extractedDsa = profileBytes.subarray(offDsa + 4, offDsa + 4 + dsaLen);
  assert.equal(extractedDsa[0], 0xa1);
  assert.equal(extractedDsa[1951], 0xa1);
});

test("serializeMessagePointer with non-zero index produces distinct output", () => {
  const txHash = "0x" + "cd".repeat(32);
  const ptr0 = serializeMessagePointer(txHash, 0);
  const ptr1 = serializeMessagePointer(txHash, 1);
  assert.notDeepEqual(Array.from(ptr0), Array.from(ptr1));
});
```

- [ ] **Step 3: Run the tests**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/packages/cemp-pq
npm test 2>&1 | tail -10
```

Expected: 3 passing tests. If any fail because the offset layout differs from what's described, read `index.js::serializeProfile` and adjust the assertions to match the actual layout.

- [ ] **Step 4: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add packages/cemp-pq/package.json packages/cemp-pq/tx-builder.test.js
git commit -m "test(cemp-pq): node:test coverage for serializers and profile layout"
```

---

### Task 4: Update cemp-pq TypeScript surface for new shape

**Files:**
- Modify: `packages/cemp-pq/index.d.ts`

The 2.7a `.d.ts` declared `fetchRecipientProfile(): Promise<Uint8Array>` to match the bare-Uint8Array reality. Task 2 just changed the JS to return `ProfileFetchResult | null`. Revert the `.d.ts` to the aspirational target.

- [ ] **Step 1: Read current declaration**

```bash
grep -A 3 "fetchRecipientProfile" packages/cemp-pq/index.d.ts
```

- [ ] **Step 2: Update the declaration**

Find this line in `packages/cemp-pq/index.d.ts`:

```ts
  fetchRecipientProfile(recipientLock: ccc.Script): Promise<Uint8Array>;
```

Replace with:

```ts
  fetchRecipientProfile(recipientLock: ccc.Script): Promise<ProfileFetchResult | null>;
```

The `ProfileFetchResult` interface is already declared in the same file. If it's not, add this above the `CEMPTransactionBuilder` class:

```ts
export interface ProfileFetchResult {
  mlDsaPubKey: Uint8Array;
  mlKemPubKey: Uint8Array;
  metadata: Uint8Array;
}
```

- [ ] **Step 3: Typecheck the desktop app**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npm run typecheck 2>&1 | tail -10
```

Expected: passes. If there are type errors in `comm-transport-service.ts` because it was written against the bare-Uint8Array shape, those are addressed in Task 6 — note the errors but proceed to commit this task.

- [ ] **Step 4: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add packages/cemp-pq/index.d.ts
git commit -m "chore(cemp-pq): .d.ts fetchRecipientProfile returns ProfileFetchResult|null"
```

---

### Task 5: Add `addrHash` to `CommIdentityState` + v1→v2 migration

**Files:**
- Modify: `apps/desktop/src/stores/comm-identity.ts`
- Modify: `apps/desktop/src/stores/comm-identity.test.ts`

The store gains a required `addrHash` field. Persist version bumps to 2; migration drops any v1 records (no real users yet).

- [ ] **Step 1: Add a failing test for the new field and migration**

Append to `apps/desktop/src/stores/comm-identity.test.ts`:

```ts
import { vi } from "vitest";

describe("comm-identity store — addrHash field (v2 migration)", () => {
  beforeEach(resetStore);

  it("setIdentity persists addrHash", () => {
    const id = {
      mlDsaPub: "0x" + "11".repeat(1952),
      mlKemPub: "0x" + "22".repeat(1184),
      address: "ckt1qmldsa...",
      addrHash: "0x" + "33".repeat(20),
      createdAt: 1747900000_000,
      fundedAt: null,
      profileTxHash: null,
      profilePublishedAt: null,
    };
    useCommIdentityStore.getState().setIdentity(id);
    expect(useCommIdentityStore.getState().identity?.addrHash).toBe("0x" + "33".repeat(20));
  });

  it("setIdentity rejects records without addrHash", () => {
    const idMissingHash = {
      mlDsaPub: "0x00",
      mlKemPub: "0x00",
      address: "ckt1qmldsa...",
      // addrHash missing
      createdAt: 0,
      fundedAt: null,
      profileTxHash: null,
      profilePublishedAt: null,
    } as never;
    expect(() => useCommIdentityStore.getState().setIdentity(idMissingHash)).toThrow(/addrHash/i);
  });

  it("v1 records are dropped on rehydrate", () => {
    // Simulate v1 record in localStorage (no addrHash field, version: 1).
    const v1State = {
      state: {
        identity: {
          mlDsaPub: "0x00",
          mlKemPub: "0x00",
          address: "ckt1qoldv1",
          createdAt: 0,
          fundedAt: null,
          profileTxHash: null,
          profilePublishedAt: null,
        },
      },
      version: 1,
    };
    globalThis.localStorage?.setItem("chain-pay:comm-identity", JSON.stringify(v1State));
    void useCommIdentityStore.persist.rehydrate();
    expect(useCommIdentityStore.getState().identity).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npx vitest run src/stores/comm-identity.test.ts
```

Expected: the three new tests fail (existing 8 still pass).

- [ ] **Step 3: Update `CommIdentityState` interface and persist config**

In `apps/desktop/src/stores/comm-identity.ts`:

Update the interface (add `addrHash` after `address`):

```ts
export interface CommIdentityState {
  /** Hex 0x-prefixed ML-DSA-65 public key (1952 bytes). */
  mlDsaPub: string;
  /** Hex 0x-prefixed ML-KEM-768 public key (1184 bytes). */
  mlKemPub: string;
  /** ckb-mldsa-lock address derived from mlDsaPub. */
  address: string;
  /** 0x-prefixed 20-byte hex of the address args (cached at keygen for sync access). */
  addrHash: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms when the address first observed >= 70 CKB. Null until funded. */
  fundedAt: number | null;
  /** Tx hash of the Profile Cell publish. Null until published. */
  profileTxHash: string | null;
  /** Epoch ms when profile publish landed. */
  profilePublishedAt: number | null;
}
```

Update `setIdentity` to validate `addrHash`:

```ts
setIdentity: (identity) => {
  if (get().identity) throw new Error("comm identity already exists; clear() first");
  if (!identity.addrHash || !/^0x[0-9a-f]{40}$/i.test(identity.addrHash)) {
    throw new Error("addrHash must be a 0x-prefixed 20-byte hex string");
  }
  set({ identity });
},
```

Update persist config — bump version to 2 with a migration that drops v1:

```ts
{
  name: "chain-pay:comm-identity",
  storage: createJSONStorage(() => storageImpl),
  version: 2,
  migrate: (_persisted, fromVersion) => {
    if (fromVersion < 2) {
      // Pre-v2 records lacked addrHash. Drop them — no production users yet.
      return { identity: null };
    }
    return _persisted as { identity: CommIdentityState | null };
  },
  partialize: (state) => ({ identity: state.identity }),
},
```

- [ ] **Step 4: Update the FIXTURE in the existing tests**

In `apps/desktop/src/stores/comm-identity.test.ts`, find the existing `FIXTURE` constant near the top and add `addrHash`:

```ts
const FIXTURE = {
  mlDsaPub: "0x" + "11".repeat(1952),
  mlKemPub: "0x" + "22".repeat(1184),
  address: "ckt1qmldsa...",
  addrHash: "0x" + "33".repeat(20),
  createdAt: 1747900000_000,
  fundedAt: null,
  profileTxHash: null,
  profilePublishedAt: null,
};
```

- [ ] **Step 5: Run all tests**

```bash
npx vitest run src/stores/comm-identity.test.ts
```

Expected: 11 passing (8 existing + 3 new).

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck 2>&1 | tail -5
```

Expected: clean. If there are type errors elsewhere (comm-transport-service.ts may not yet return addrHash), they're handled in Task 6 — note them and commit this task.

- [ ] **Step 7: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/src/stores/comm-identity.ts apps/desktop/src/stores/comm-identity.test.ts
git commit -m "feat(2.7b-1): add addrHash to CommIdentityState; persist v2 migration drops v1"
```

---

### Task 6: Update main-process service for `addrHash` + richer profile

**Files:**
- Modify: `apps/desktop/electron/main/comm-transport-service.ts`

`generateIdentity` now returns `addrHash`; `resolveProfile` returns the now-real richer shape.

- [ ] **Step 1: Read existing surface**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
grep -n "generateIdentity\|resolveProfile\|PublicIdentity" apps/desktop/electron/main/comm-transport-service.ts
```

- [ ] **Step 2: Update `PublicIdentity` and `generateIdentity` to include `addrHash`**

In `apps/desktop/electron/main/comm-identity-store.ts` (where `PublicIdentity` is defined), update the interface:

```ts
export interface PublicIdentity {
  mlDsaPub: string;
  mlKemPub: string;
  address: string;
  addrHash: string;  // NEW. 0x-prefixed 20-byte hex.
  createdAt: number;
}
```

Update `loadCommIdentity` to return `addrHash` — it's already in the stored shape (assuming saveCommIdentity persists it). If not, save it too. Read the existing `StoredShape` interface and the `saveCommIdentity`/`loadCommIdentity` body.

In `comm-identity-store.ts`, update `StoredShape`:

```ts
interface StoredShape {
  mlDsaSec: string;
  mlKemSec: string;
  mlDsaPub: string;
  mlKemPub: string;
  address: string;
  addrHash: string;  // NEW
  createdAt: number;
}
```

Update `PlainIdentity` to include `addrHash` (so save accepts it):

```ts
export interface PlainIdentity {
  mlDsaSec: Uint8Array;
  mlKemSec: Uint8Array;
  mlDsaPub: Uint8Array;
  mlKemPub: Uint8Array;
  address: string;
  addrHash: Uint8Array;  // NEW. 20 bytes.
  createdAt: number;
}
```

Update `saveCommIdentity` body to write addrHash via `toHex`:

```ts
const shape: StoredShape = {
  mlDsaSec: toHex(identity.mlDsaSec),
  mlKemSec: toHex(identity.mlKemSec),
  mlDsaPub: toHex(identity.mlDsaPub),
  mlKemPub: toHex(identity.mlKemPub),
  address: identity.address,
  addrHash: toHex(identity.addrHash),
  createdAt: identity.createdAt,
};
```

Update `loadCommIdentity` body to return it:

```ts
return {
  mlDsaPub: json.mlDsaPub,
  mlKemPub: json.mlKemPub,
  address: json.address,
  addrHash: json.addrHash,
  createdAt: json.createdAt,
};
```

- [ ] **Step 3: Update `generateIdentity` in `comm-transport-service.ts` to compute and pass `addrHash`**

Inside `generateIdentity`, after deriving the lock and address:

```ts
const lock = mldsaLock(dsa.publicKey);
const address = (await ccc.Address.fromScript(lock, client())).toString();
// Address args are the cached blake160-style hash; take first 20 bytes.
const argsHex = lock.args.startsWith("0x") ? lock.args.slice(2) : lock.args;
const addrHash = new Uint8Array(20);
for (let i = 0; i < 20; i++) addrHash[i] = parseInt(argsHex.slice(i * 2, i * 2 + 2), 16);

const plain: PlainIdentity = {
  mlDsaSec: dsa.secretKey,
  mlKemSec: kem.secretKey,
  mlDsaPub: dsa.publicKey,
  mlKemPub: kem.publicKey,
  address,
  addrHash,
  createdAt: Date.now(),
};
await saveCommIdentity(plain);
plain.mlDsaSec.fill(0);
plain.mlKemSec.fill(0);

return {
  mlDsaPub: "0x" + Buffer.from(dsa.publicKey).toString("hex"),
  mlKemPub: "0x" + Buffer.from(kem.publicKey).toString("hex"),
  address,
  addrHash: "0x" + Buffer.from(addrHash).toString("hex"),
  createdAt: plain.createdAt,
};
```

- [ ] **Step 4: Update `resolveProfile` to consume the richer shape**

Find the existing body of `resolveProfile`. Replace with:

```ts
export async function resolveProfile(address: string): Promise<ProfileFetchResult> {
  const lock = (await ccc.Address.fromString(address, client())).script;
  const builder = new CEMPTransactionBuilder(client());
  const result = await builder.fetchRecipientProfile(lock);
  if (!result) throw new Error(`no Profile Cell for ${address}`);
  return {
    address,
    mlDsaPubKey: "0x" + Buffer.from(result.mlDsaPubKey).toString("hex"),
    mlKemPubKey: "0x" + Buffer.from(result.mlKemPubKey).toString("hex"),
    metadata: new TextDecoder().decode(result.metadata),
  };
}
```

- [ ] **Step 5: Typecheck**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npm run typecheck 2>&1 | tail -5
```

Expected: clean. If preload IPC types complain about the new `addrHash` field, that's Task 9 — note but commit this.

- [ ] **Step 6: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/electron/main/comm-identity-store.ts apps/desktop/electron/main/comm-transport-service.ts
git commit -m "feat(2.7b-1): main service returns addrHash and richer ProfileFetchResult"
```

---

### Task 7: Tests for `comm-transport-service` (NEW file)

**Files:**
- Create: `apps/desktop/electron/main/comm-transport-service.test.ts`

Test the main-process verbs that don't require a live chain. Mock CCC client and CEMP-PQ where possible.

- [ ] **Step 1: Write the tests**

Create `apps/desktop/electron/main/comm-transport-service.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
const { resetSafeStorageForTests } = await import("./safe-storage");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "comm-transport-service-test-"));
const identityFile = path.join(tmpDir, "comm-identity.enc");

const { _setIdentityFileForTests } = await import("./comm-identity-store");
const { generateIdentity, exists, publicInfo, deleteIdentity } = await import("./comm-transport-service");

beforeEach(async () => {
  resetSafeStorageForTests();
  await fs.rm(identityFile, { force: true });
  _setIdentityFileForTests(identityFile);
});

describe("comm-transport-service", () => {
  it("generateIdentity returns addrHash as 0x-prefixed 20-byte hex", async () => {
    const id = await generateIdentity();
    expect(id.addrHash).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("generateIdentity persists; publicInfo returns the same addrHash", async () => {
    const generated = await generateIdentity();
    const loaded = await publicInfo();
    expect(loaded?.addrHash).toBe(generated.addrHash);
  });

  it("generateIdentity refuses to overwrite existing identity", async () => {
    await generateIdentity();
    await expect(generateIdentity()).rejects.toThrow(/already exists/i);
  });

  it("deleteIdentity removes the file; exists returns false after", async () => {
    await generateIdentity();
    expect(await exists()).toBe(true);
    await deleteIdentity();
    expect(await exists()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npx vitest run electron/main/comm-transport-service.test.ts 2>&1 | tail -10
```

Expected: 4 passing.

If the tests fail because `generateIdentity` requires a live CCC client (it does — `client.getCellsCapacity` etc), they may time out or throw network errors. Two options:
- (a) Add `vi.mock('@ckb-ccc/core', ...)` to stub the client at the file top
- (b) Accept that these tests require network access (testnet RPC) and skip them in CI via `it.skipIf(!process.env.ALLOW_NETWORK_TESTS)(...)`

Pick (b) for now — gate behind `ALLOW_NETWORK_TESTS=1`. Modify the `it(...)` calls:

```ts
const networkTest = process.env.ALLOW_NETWORK_TESTS ? it : it.skip;

describe("comm-transport-service", () => {
  networkTest("generateIdentity returns addrHash as 0x-prefixed 20-byte hex", async () => { ... });
  // ...
});
```

Then the smoke covers them in reality. Document this in a comment at the top of the test file.

- [ ] **Step 3: Verify the typecheck**

```bash
npm run typecheck 2>&1 | tail -3
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/electron/main/comm-transport-service.test.ts
git commit -m "test(2.7b-1): comm-transport-service generateIdentity + lifecycle (network-gated)"
```

---

### Task 8: Make `getOwnIdentityHash()` work in production

**Files:**
- Modify: `apps/desktop/src/lib/comm/own-identity-hash.ts`
- Modify: `apps/desktop/src/lib/comm/own-identity-hash.test.ts` (if exists; else create)

The 2.7a stub returned `null` in production. Now that `addrHash` is on the identity record, it can return real bytes.

- [ ] **Step 1: Write a failing test for the production path**

Check if the test file exists:

```bash
ls /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop/src/lib/comm/own-identity-hash.test.ts 2>/dev/null && echo "exists" || echo "create"
```

If absent, create `apps/desktop/src/lib/comm/own-identity-hash.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getOwnIdentityHash, setOwnIdentityHashGetterForTests } from "./own-identity-hash";
import { useCommIdentityStore } from "../../stores/comm-identity";

function resetStore(): void {
  useCommIdentityStore.setState({ identity: null });
  globalThis.localStorage?.removeItem("chain-pay:comm-identity");
}

describe("getOwnIdentityHash (production path)", () => {
  beforeEach(() => {
    resetStore();
    setOwnIdentityHashGetterForTests(null);
  });

  it("returns null when no identity is set", () => {
    expect(getOwnIdentityHash()).toBeNull();
  });

  it("returns the parsed bytes of identity.addrHash when set", () => {
    useCommIdentityStore.setState({
      identity: {
        mlDsaPub: "0x00",
        mlKemPub: "0x00",
        address: "ckt1qmldsa...",
        addrHash: "0x" + "ab".repeat(20),
        createdAt: 0,
        fundedAt: null,
        profileTxHash: null,
        profilePublishedAt: null,
      },
    });
    const hash = getOwnIdentityHash();
    expect(hash).not.toBeNull();
    expect(hash!.length).toBe(20);
    expect(hash![0]).toBe(0xab);
    expect(hash![19]).toBe(0xab);
  });

  it("test override takes precedence over store", () => {
    useCommIdentityStore.setState({
      identity: {
        mlDsaPub: "0x00",
        mlKemPub: "0x00",
        address: "ckt1qmldsa...",
        addrHash: "0x" + "ab".repeat(20),
        createdAt: 0,
        fundedAt: null,
        profileTxHash: null,
        profilePublishedAt: null,
      },
    });
    const override = new Uint8Array(20).fill(0x77);
    setOwnIdentityHashGetterForTests(() => override);
    expect(getOwnIdentityHash()).toEqual(override);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npx vitest run src/lib/comm/own-identity-hash.test.ts
```

Expected: test 2 ("returns the parsed bytes...") fails because the production path still returns null.

- [ ] **Step 3: Update `getOwnIdentityHash` to read the cached field**

Replace the production-path body in `apps/desktop/src/lib/comm/own-identity-hash.ts`:

```ts
import { useCommIdentityStore } from "../../stores/comm-identity";

let getterOverride: (() => Uint8Array | null) | null = null;

export function setOwnIdentityHashGetterForTests(fn: (() => Uint8Array | null) | null): void {
  getterOverride = fn;
}

export function getOwnIdentityHash(): Uint8Array | null {
  if (getterOverride) return getterOverride();
  const id = useCommIdentityStore.getState().identity;
  if (!id?.addrHash) return null;
  return hexToBytes(id.addrHash);
}

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
```

- [ ] **Step 4: Run to verify passing**

```bash
npx vitest run src/lib/comm/own-identity-hash.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck 2>&1 | tail -3
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/src/lib/comm/own-identity-hash.ts apps/desktop/src/lib/comm/own-identity-hash.test.ts
git commit -m "feat(2.7b-1): getOwnIdentityHash reads cached addrHash in production"
```

---

### Task 9: Update preload bridge types for `addrHash`

**Files:**
- Modify: `apps/desktop/electron/preload/index.ts`
- Modify: `apps/desktop/src/vite-env.d.ts` (if types are written manually there)

`generate()` and `publicInfo()` now return `addrHash` — update the IPC bridge declarations.

- [ ] **Step 1: Read the existing preload bridge**

```bash
grep -A 10 "commIdentity" /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop/electron/preload/index.ts
```

- [ ] **Step 2: Add `addrHash` to the return-type declarations**

In `apps/desktop/electron/preload/index.ts`, find the `commIdentity` block (likely the return-type annotations or the `ChainpayApi` exported type if structurally derived). The types should now read:

```ts
commIdentity: {
  exists(): Promise<boolean>;
  publicInfo(): Promise<{ mlDsaPub: string; mlKemPub: string; address: string; addrHash: string; createdAt: number } | null>;
  generate(): Promise<{ mlDsaPub: string; mlKemPub: string; address: string; addrHash: string; createdAt: number }>;
  delete(): Promise<void>;
},
```

If the existing preload uses `typeof` to derive the type from the runtime object, the runtime object's return types come from the main-process service exports — no manual annotation change needed beyond confirming the imports flow.

- [ ] **Step 3: Update vite-env.d.ts if it declares the Window.chainpay shape manually**

```bash
grep -A 10 "commIdentity" /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop/src/vite-env.d.ts
```

If the file declares `commIdentity` shape inline (not via `typeof`), update each return type to include `addrHash: string`.

- [ ] **Step 4: Typecheck**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npm run typecheck 2>&1 | tail -5
```

Expected: clean. If errors point at consumers expecting the old shape, hunt them down — they should be limited to the Settings ceremony (Phase B) and possibly `lib/comm/index.ts` (next task).

- [ ] **Step 5: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/electron/preload/index.ts apps/desktop/src/vite-env.d.ts
git commit -m "chore(2.7b-1): preload IPC types include addrHash on identity records"
```

---

### Task 10: Address-keyed singleton + `resetCommTransport()`

**Files:**
- Modify: `apps/desktop/src/lib/comm/index.ts`
- Create: `apps/desktop/src/lib/comm/index.test.ts`

The 2.7a factory cached the transport in a module-level `cached` variable but never invalidated on identity change. This task switches to address-keyed caching so identity delete/regenerate triggers auto-rebuild, and renames `_resetCommTransportForTests` to `resetCommTransport` (production-used).

- [ ] **Step 1: Write failing tests**

Create `apps/desktop/src/lib/comm/index.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createCommTransport, resetCommTransport } from "./index";
import { useCommIdentityStore } from "../../stores/comm-identity";

function resetStore(): void {
  useCommIdentityStore.setState({ identity: null });
  globalThis.localStorage?.removeItem("chain-pay:comm-identity");
  resetCommTransport();
}

const IDENTITY_A = {
  mlDsaPub: "0x" + "11".repeat(1952),
  mlKemPub: "0x" + "22".repeat(1184),
  address: "ckt1qalice",
  addrHash: "0x" + "33".repeat(20),
  createdAt: 0,
  fundedAt: null,
  profileTxHash: null,
  profilePublishedAt: null,
};

const IDENTITY_B = { ...IDENTITY_A, address: "ckt1qbob" };

describe("createCommTransport singleton", () => {
  beforeEach(resetStore);

  it("returns null when no identity is set", () => {
    expect(createCommTransport()).toBeNull();
  });

  it("returns the same instance across calls with the same identity", () => {
    useCommIdentityStore.setState({ identity: IDENTITY_A });
    const first = createCommTransport();
    const second = createCommTransport();
    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });

  it("rebuilds when identity.address changes", () => {
    useCommIdentityStore.setState({ identity: IDENTITY_A });
    const first = createCommTransport();
    useCommIdentityStore.setState({ identity: IDENTITY_B });
    const second = createCommTransport();
    expect(second).not.toBe(first);
    expect(second).not.toBeNull();
  });

  it("returns null after identity is cleared", () => {
    useCommIdentityStore.setState({ identity: IDENTITY_A });
    expect(createCommTransport()).not.toBeNull();
    useCommIdentityStore.setState({ identity: null });
    expect(createCommTransport()).toBeNull();
  });

  it("resetCommTransport() stops and clears the cached instance", () => {
    useCommIdentityStore.setState({ identity: IDENTITY_A });
    const first = createCommTransport();
    expect(first).not.toBeNull();
    resetCommTransport();
    const second = createCommTransport();
    expect(second).not.toBe(first);
  });

  it("identity address change does not leak old singleton", () => {
    // After A → B, the next createCommTransport call must not return the A instance.
    useCommIdentityStore.setState({ identity: IDENTITY_A });
    const first = createCommTransport();
    useCommIdentityStore.setState({ identity: IDENTITY_B });
    const second = createCommTransport();
    useCommIdentityStore.setState({ identity: IDENTITY_A });
    const third = createCommTransport();
    // After two rebuilds, third should NOT be the same as first (no implicit memoization of A's prior instance).
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npx vitest run src/lib/comm/index.test.ts
```

Expected: tests fail — either `resetCommTransport` not exported, or rebuild-on-address-change not implemented.

- [ ] **Step 3: Update `apps/desktop/src/lib/comm/index.ts`**

Replace the cache state + factory + reset hook. Read the existing file first:

```bash
cat apps/desktop/src/lib/comm/index.ts
```

The 2.7a version uses `let cached: CommTransport | null = null` and `_resetCommTransportForTests()`. Replace with the address-keyed version:

```ts
let cached: { transport: CempPqCommTransport; identityAddress: string } | null = null;

export function createCommTransport(): CommTransport | null {
  const identity = useCommIdentityStore.getState().identity;
  if (!identity) {
    if (cached) {
      void cached.transport.stop();
      cached = null;
    }
    return null;
  }
  if (cached && cached.identityAddress === identity.address) {
    return cached.transport;
  }
  if (cached) void cached.transport.stop();
  cached = {
    transport: new CempPqCommTransport({ /* keep existing wiring block */ }),
    identityAddress: identity.address,
  };
  return cached.transport;
}

export function resetCommTransport(): void {
  if (cached) {
    void cached.transport.stop();
    cached = null;
  }
}
```

The wiring block inside `new CempPqCommTransport({...})` is unchanged from 2.7a. Don't rewrite it — just preserve.

Remove the old `_resetCommTransportForTests` export if it existed. If it's referenced elsewhere in the codebase (likely tests), grep and update:

```bash
grep -rn "_resetCommTransportForTests" apps/desktop/src apps/desktop/electron
```

If any references found, change them to `resetCommTransport`.

- [ ] **Step 4: Run to verify passing**

```bash
npx vitest run src/lib/comm/index.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Run full test suite to catch any consumer breakage**

```bash
npx vitest run 2>&1 | tail -10
```

Expected: 141 + 9 new (3 from Task 5, 3 from Task 8, 4 from Task 7 if `ALLOW_NETWORK_TESTS` set) + 6 from this task. Allow some slack for previously-skipped tests. Confirm no regressions.

- [ ] **Step 6: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/src/lib/comm/index.ts apps/desktop/src/lib/comm/index.test.ts
git commit -m "feat(2.7b-1): address-keyed CommTransport singleton + resetCommTransport"
```

---

### Task 11: Boot effect in `App.tsx` (`useCommTransportBoot`)

**Files:**
- Modify: `apps/desktop/src/App.tsx`

Adds the boot effect that wires `peer-book.knownSignersGetter` to live treasury state and auto-starts the CommTransport when an identity with a published profile exists.

- [ ] **Step 1: Read current App.tsx structure**

```bash
cat /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop/src/App.tsx
```

Identify where other boot effects (if any) live — likely a single `App` component with effects calling existing stores. The new hook will be added alongside.

- [ ] **Step 2: Add `useCommTransportBoot` hook**

Add this hook at module scope in `apps/desktop/src/App.tsx`:

```tsx
import { useEffect } from "react";
import { createCommTransport } from "./lib/comm";
import { useCommIdentityStore } from "./stores/comm-identity";
import { usePeerBookStore } from "./stores/peer-book";
import { useTreasuryStore } from "./stores/treasury";

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

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
      const transport = createCommTransport();
      void transport?.stop();
    };
  }, []);
}
```

- [ ] **Step 3: Call the hook from the App component**

Find the `App` component (function or function-arrow) and add `useCommTransportBoot()` near the top:

```tsx
export function App() {
  useCommTransportBoot();
  // ... existing JSX or hook calls ...
}
```

- [ ] **Step 4: Typecheck**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npm run typecheck 2>&1 | tail -3
```

Expected: clean.

If `"pubkeyHashes" in t.multisig` produces a type-narrowing error because the `Treasury` type isn't a discriminated union with those keys, read `packages/shared/src/treasury.ts` (or wherever Treasury is defined) and adjust the narrowing. The Task 17 review in 2.7a's plan confirmed `CkbMultisig` uses `pubkeyHashes: Hex20[]`.

- [ ] **Step 5: Build**

```bash
npm run build 2>&1 | tail -8
```

Expected: success.

- [ ] **Step 6: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/src/App.tsx
git commit -m "feat(2.7b-1): App.tsx boot effect auto-starts transport, wires peer-book getter"
```

---

### Task 12: Phase-A integration check

**Files:** none — verification only.

Confirm everything from Phase A composes correctly before starting the UI work.

- [ ] **Step 1: Full test suite**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npx vitest run 2>&1 | tail -10
```

Expected: all passing (existing 141 + new ~12 from Tasks 5, 7, 8, 10).

- [ ] **Step 2: Typecheck root**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1 && npm run typecheck 2>&1 | tail -5
```

Expected: passes for both `apps/desktop` and any other workspace package with a typecheck script.

- [ ] **Step 3: Build**

```bash
cd apps/desktop && npm run build 2>&1 | tail -5
```

Expected: success.

- [ ] **Step 4: cemp-pq tests**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/packages/cemp-pq && npm test 2>&1 | tail -8
```

Expected: 3 passing.

- [ ] **Step 5: Document the manual smoke checkpoint**

Phase A is the gate where the smoke roundtrip becomes meaningful. The implementer should run the smoke now if they have funded testnet wallets to confirm Phase-A correctness before doing Phase-B UI work. Otherwise, document that the smoke is pending and proceed.

No commit needed for this task — it's a verification step.

---

# Phase B — Settings ceremony

### Task 13: New error classes for the ceremony

**Files:**
- Modify: `apps/desktop/src/lib/comm/errors.ts`

Add `IdentityGenerationError` and `ProfilePublishError` so the ceremony can surface specific failure causes.

- [ ] **Step 1: Append the new classes to `errors.ts`**

Open `apps/desktop/src/lib/comm/errors.ts` and add at the bottom:

```ts
export class IdentityGenerationError extends CommError {}

export class ProfilePublishError extends CommError {
  constructor(public readonly txHash: string | null, message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npm run typecheck 2>&1 | tail -3
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/src/lib/comm/errors.ts
git commit -m "feat(2.7b-1): IdentityGenerationError + ProfilePublishError"
```

---

### Task 14: `useCommChannelSetup` hook + tests

**Files:**
- Create: `apps/desktop/src/features/settings/useCommChannelSetup.ts`
- Create: `apps/desktop/src/features/settings/useCommChannelSetup.test.ts`

The hook derives a state-machine value from `useCommIdentityStore` and exposes `generate`/`deleteIdentity` actions. Pure logic — no rendering. The balance polling lives in `FundingStep` (Task 16) for now; the hook just reports state.

- [ ] **Step 1: Write failing tests**

Create `apps/desktop/src/features/settings/useCommChannelSetup.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCommChannelSetup } from "./useCommChannelSetup";
import { useCommIdentityStore } from "../../stores/comm-identity";

const FIXTURE_ID = {
  mlDsaPub: "0x" + "11".repeat(1952),
  mlKemPub: "0x" + "22".repeat(1184),
  address: "ckt1qmldsa-x",
  addrHash: "0x" + "33".repeat(20),
  createdAt: 1747900000_000,
  fundedAt: null,
  profileTxHash: null,
  profilePublishedAt: null,
};

function resetStore(): void {
  useCommIdentityStore.setState({ identity: null });
  globalThis.localStorage?.removeItem("chain-pay:comm-identity");
}

describe("useCommChannelSetup", () => {
  beforeEach(() => {
    resetStore();
    // Default mocks for IPC verbs.
    (globalThis as unknown as { window: Window }).window = {
      chainpay: {
        commIdentity: {
          exists: vi.fn().mockResolvedValue(false),
          publicInfo: vi.fn().mockResolvedValue(null),
          generate: vi.fn().mockResolvedValue(FIXTURE_ID),
          delete: vi.fn().mockResolvedValue(undefined),
        },
        commTransport: {
          publishProfile: vi.fn().mockResolvedValue({ txHash: "0xpubtx", txBytes: "0x00" }),
          sendMessage: vi.fn(),
          decryptIncoming: vi.fn(),
          resolveProfile: vi.fn(),
        },
      },
    } as never;
  });

  it("state.kind = 'not-configured' when no identity", () => {
    const { result } = renderHook(() => useCommChannelSetup());
    expect(result.current.state.kind).toBe("not-configured");
  });

  it("state.kind = 'funding' when identity exists without profileTxHash", () => {
    useCommIdentityStore.setState({ identity: FIXTURE_ID });
    const { result } = renderHook(() => useCommChannelSetup());
    expect(result.current.state.kind).toBe("funding");
    if (result.current.state.kind === "funding") {
      expect(result.current.state.address).toBe(FIXTURE_ID.address);
    }
  });

  it("state.kind = 'ready' when profileTxHash is set", () => {
    useCommIdentityStore.setState({
      identity: { ...FIXTURE_ID, profileTxHash: "0xpubtx", profilePublishedAt: Date.now() },
    });
    const { result } = renderHook(() => useCommChannelSetup());
    expect(result.current.state.kind).toBe("ready");
  });

  it("generate() calls the IPC verb and sets identity in store", async () => {
    const { result } = renderHook(() => useCommChannelSetup());
    await act(async () => {
      await result.current.generate();
    });
    expect(window.chainpay.commIdentity.generate).toHaveBeenCalledTimes(1);
    expect(useCommIdentityStore.getState().identity?.address).toBe(FIXTURE_ID.address);
  });

  it("deleteIdentity() calls the IPC verb and clears the store", async () => {
    useCommIdentityStore.setState({ identity: FIXTURE_ID });
    const { result } = renderHook(() => useCommChannelSetup());
    await act(async () => {
      await result.current.deleteIdentity();
    });
    expect(window.chainpay.commIdentity.delete).toHaveBeenCalledTimes(1);
    expect(useCommIdentityStore.getState().identity).toBeNull();
  });

  it("generate() surfaces errors as IdentityGenerationError", async () => {
    (window.chainpay.commIdentity.generate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("safeStorage unavailable"),
    );
    const { result } = renderHook(() => useCommChannelSetup());
    await expect(
      act(async () => {
        await result.current.generate();
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npx vitest run src/features/settings/useCommChannelSetup.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the hook**

Create `apps/desktop/src/features/settings/useCommChannelSetup.ts`:

```ts
import { useCommIdentityStore } from "../../stores/comm-identity";
import { IdentityGenerationError } from "../../lib/comm/errors";

export type CommSetupState =
  | { kind: "not-configured" }
  | { kind: "funding"; address: string; addrHash: string }
  | { kind: "publishing"; address: string }
  | { kind: "ready"; address: string; publishedAt: number };

export interface CommChannelSetupApi {
  state: CommSetupState;
  generate: () => Promise<void>;
  deleteIdentity: () => Promise<void>;
}

export function useCommChannelSetup(): CommChannelSetupApi {
  const identity = useCommIdentityStore((s) => s.identity);

  const state = deriveState(identity);

  async function generate(): Promise<void> {
    try {
      const generated = await window.chainpay.commIdentity.generate();
      useCommIdentityStore.getState().setIdentity({
        mlDsaPub: generated.mlDsaPub,
        mlKemPub: generated.mlKemPub,
        address: generated.address,
        addrHash: generated.addrHash,
        createdAt: generated.createdAt,
        fundedAt: null,
        profileTxHash: null,
        profilePublishedAt: null,
      });
    } catch (cause) {
      throw new IdentityGenerationError(
        cause instanceof Error ? cause.message : "comm identity generation failed",
        { cause },
      );
    }
  }

  async function deleteIdentity(): Promise<void> {
    await window.chainpay.commIdentity.delete();
    useCommIdentityStore.getState().clear();
  }

  return { state, generate, deleteIdentity };
}

function deriveState(identity: ReturnType<typeof useCommIdentityStore.getState>["identity"]): CommSetupState {
  if (!identity) return { kind: "not-configured" };
  if (identity.profileTxHash && identity.profilePublishedAt) {
    return { kind: "ready", address: identity.address, publishedAt: identity.profilePublishedAt };
  }
  return { kind: "funding", address: identity.address, addrHash: identity.addrHash };
}
```

**Implementer note:** The `"publishing"` state is transient — the hook itself derives only `"not-configured" | "funding" | "ready"` from store state. The `"publishing"` kind is set/cleared locally in `CommChannelSection` (Task 18) during the publish-flight window. To avoid extra component state, you can model publishing entirely inside the container component with a `useState` ("isPublishing" flag) that triggers a different step component while true.

- [ ] **Step 4: Install testing-library if not already**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop
grep "@testing-library/react" package.json
```

If absent, install:

```bash
npm install -D @testing-library/react @testing-library/dom jsdom
```

Update vitest config to use jsdom for tests in `src/features/settings/`:

Check `apps/desktop/vitest.config.ts` (or wherever vitest config lives). If there's no environment override, add one for the settings tests. Simplest: add a top-level `test.environment: "jsdom"` if the project doesn't require node for any tests. If the project does require node for some, use per-file `// @vitest-environment jsdom` directive at the top of the React test files.

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/features/settings/useCommChannelSetup.test.ts
```

Expected: 6 passing.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck 2>&1 | tail -3
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/src/features/settings/useCommChannelSetup.ts apps/desktop/src/features/settings/useCommChannelSetup.test.ts apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/vitest.config.ts
git commit -m "feat(2.7b-1): useCommChannelSetup hook + state-machine derivation"
```

---

### Task 15: `NotConfiguredStep` component

**Files:**
- Create: `apps/desktop/src/features/settings/steps/NotConfiguredStep.tsx`

Simplest step. Shows explanation + "Set up comm channel" button.

- [ ] **Step 1: Write the component**

Create `apps/desktop/src/features/settings/steps/NotConfiguredStep.tsx`:

```tsx
interface NotConfiguredStepProps {
  onSetup: () => void | Promise<void>;
  error: Error | null;
}

export function NotConfiguredStep({ onSetup, error }: NotConfiguredStepProps): JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        The comm channel is an on-chain encrypted relay for signing coordination. Setting up an
        identity generates a fresh ML-DSA-65 + ML-KEM-768 keypair and prompts you to fund a small
        capacity reserve. Your secret keys never leave this device.
      </p>
      <button
        type="button"
        onClick={() => {
          void onSetup();
        }}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hi"
      >
        Set up comm channel
      </button>
      {error && (
        <div className="rounded-md border border-danger bg-danger-bg p-3 text-sm text-danger-fg">
          <strong>Setup failed:</strong> {error.message}
        </div>
      )}
    </div>
  );
}
```

**Implementer note:** Tailwind class names like `bg-accent`, `border-danger`, `text-fg-muted` are project conventions. If the actual class names differ (e.g. `bg-blue-600`, `text-gray-500`), check the existing Settings.tsx for the palette in use and match it. The component should look at home alongside the existing settings cards.

- [ ] **Step 2: Typecheck**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npm run typecheck 2>&1 | tail -3
```

Expected: clean. If `JSX.Element` isn't recognized in this React 19 setup, use `React.ReactElement` or drop the return-type annotation entirely (TS infers).

- [ ] **Step 3: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/src/features/settings/steps/NotConfiguredStep.tsx
git commit -m "feat(2.7b-1): NotConfiguredStep — set-up button + error banner"
```

---

### Task 16: `FundingStep` component (balance poll)

**Files:**
- Create: `apps/desktop/src/features/settings/steps/FundingStep.tsx`

Shows address with copy button, required CKB, live balance poll every 5s, auto-transitions to publishing when balance ≥ 70 CKB.

- [ ] **Step 1: Write the component**

Create `apps/desktop/src/features/settings/steps/FundingStep.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ccc } from "@ckb-ccc/core";
import { lightClient } from "../../../lib/light-client/client";

interface FundingStepProps {
  address: string;
  onFunded: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

const REQUIRED_SHANNONS = 70n * 100_000_000n;
const POLL_INTERVAL_MS = 5_000;

export function FundingStep({ address, onFunded, onCancel }: FundingStepProps): JSX.Element {
  const [balanceShannons, setBalanceShannons] = useState<bigint | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [hasTriggered, setHasTriggered] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function pollOnce(): Promise<void> {
      try {
        const lock = (await ccc.Address.fromString(address, lightClient().client())).script;
        const cap = await lightClient().getLockBalance(lock);
        if (cancelled) return;
        setBalanceShannons(cap);
        setPollError(null);
        if (cap >= REQUIRED_SHANNONS && !hasTriggered) {
          setHasTriggered(true);
          void onFunded();
        }
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : "balance poll failed");
      }
    }

    void pollOnce();
    const interval = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [address, onFunded, hasTriggered]);

  function copyAddress(): void {
    void navigator.clipboard.writeText(address);
  }

  const balanceCkb = balanceShannons === null ? null : Number(balanceShannons / 100_000_000n);
  const requiredCkb = 70;

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        Fund this address with at least {requiredCkb} CKB. Once funded, the profile cell will be
        published automatically and the comm channel will start.
      </p>
      <div className="rounded-md border border-surface-hi bg-surface-elev p-3">
        <div className="text-xs uppercase tracking-wide text-fg-muted">Comm channel address</div>
        <div className="mt-1 break-all font-mono text-xs">{address}</div>
        <button
          type="button"
          onClick={copyAddress}
          className="mt-2 rounded bg-accent px-3 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hi"
        >
          Copy address
        </button>
      </div>
      <div className="rounded-md border border-surface-hi bg-surface p-3 text-sm">
        <span className="text-fg-muted">Balance:</span>{" "}
        <span className="font-mono">
          {balanceCkb === null ? "—" : `${balanceCkb} / ${requiredCkb} CKB`}
        </span>
        {pollError && <span className="ml-2 text-warning"> · {pollError}</span>}
      </div>
      <button
        type="button"
        onClick={() => void onCancel()}
        className="rounded-md border border-surface-hi px-3 py-1 text-xs text-fg-muted hover:bg-surface-elev"
      >
        Cancel setup (delete identity)
      </button>
    </div>
  );
}
```

**Implementer note:** `lightClient()` import path is `../../../lib/light-client/client` per the Task 16 finding from 2.7a (NOT `host`). If your structure differs, grep for `export.*lightClient` in `apps/desktop/src/lib/light-client/`.

`lightClient().getLockBalance(lock)` returns `bigint` per `light-client/host.ts:160`. `lightClient().client()` returning a CCC client may or may not exist — if there's no such getter, use a fresh `ccc.ClientPublicTestnet()` for `Address.fromString`. Read the existing client.ts/host.ts to confirm.

- [ ] **Step 2: Typecheck**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npm run typecheck 2>&1 | tail -3
```

Expected: clean. If `lightClient().client()` doesn't exist, replace with a stand-alone `new ccc.ClientPublicTestnet()` (it's used just for `Address.fromString` parsing — no network calls).

- [ ] **Step 3: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/src/features/settings/steps/FundingStep.tsx
git commit -m "feat(2.7b-1): FundingStep with 5s balance poll and auto-trigger at 70 CKB"
```

---

### Task 17: `PublishingStep` + `ReadyStep` components

**Files:**
- Create: `apps/desktop/src/features/settings/steps/PublishingStep.tsx`
- Create: `apps/desktop/src/features/settings/steps/ReadyStep.tsx`

`PublishingStep` is a transient "publishing in progress" display. `ReadyStep` shows the address + "Delete identity" button with confirmation.

- [ ] **Step 1: Write `PublishingStep`**

Create `apps/desktop/src/features/settings/steps/PublishingStep.tsx`:

```tsx
interface PublishingStepProps {
  address: string;
  error: Error | null;
  onRetry: () => void | Promise<void>;
}

export function PublishingStep({ address, error, onRetry }: PublishingStepProps): JSX.Element {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-surface-hi bg-surface-elev p-3">
        <div className="text-xs uppercase tracking-wide text-fg-muted">Publishing profile cell</div>
        <div className="mt-1 break-all font-mono text-xs">{address}</div>
        {!error && (
          <div className="mt-2 text-sm text-fg-muted">Broadcasting to testnet. This usually takes ~10 seconds…</div>
        )}
      </div>
      {error && (
        <>
          <div className="rounded-md border border-danger bg-danger-bg p-3 text-sm text-danger-fg">
            <strong>Publish failed:</strong> {error.message}
          </div>
          <button
            type="button"
            onClick={() => void onRetry()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hi"
          >
            Retry publish
          </button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write `ReadyStep`**

Create `apps/desktop/src/features/settings/steps/ReadyStep.tsx`:

```tsx
import { useState } from "react";

interface ReadyStepProps {
  address: string;
  publishedAt: number;
  onDelete: () => void | Promise<void>;
}

export function ReadyStep({ address, publishedAt, onDelete }: ReadyStepProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);

  function copyAddress(): void {
    void navigator.clipboard.writeText(address);
  }

  const publishedLocal = new Date(publishedAt).toLocaleString();

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-success bg-success-bg p-3">
        <div className="text-xs uppercase tracking-wide text-success-fg">Comm channel ready</div>
        <div className="mt-1 break-all font-mono text-xs">{address}</div>
        <div className="mt-2 text-xs text-fg-muted">Profile published {publishedLocal}</div>
        <button
          type="button"
          onClick={copyAddress}
          className="mt-2 rounded bg-accent px-3 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hi"
        >
          Copy address
        </button>
      </div>
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-md border border-danger px-3 py-1 text-xs text-danger hover:bg-danger-bg"
        >
          Delete identity
        </button>
      ) : (
        <div className="rounded-md border border-danger bg-danger-bg p-3 text-sm">
          <p className="text-danger-fg">
            This will permanently delete your comm-channel identity. The address{" "}
            <span className="font-mono">{address}</span> will become unreachable. Messages already
            sent stay on-chain forever. Continue?
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void onDelete()}
              className="rounded-md bg-danger px-3 py-1 text-xs font-medium text-danger-fg hover:opacity-90"
            >
              Yes, delete
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-surface-hi px-3 py-1 text-xs text-fg-muted hover:bg-surface-elev"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npm run typecheck 2>&1 | tail -3
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/src/features/settings/steps/PublishingStep.tsx apps/desktop/src/features/settings/steps/ReadyStep.tsx
git commit -m "feat(2.7b-1): PublishingStep + ReadyStep with delete confirmation"
```

---

### Task 18: `CommChannelSection` container + tests

**Files:**
- Create: `apps/desktop/src/features/settings/CommChannelSection.tsx`
- Create: `apps/desktop/src/features/settings/CommChannelSection.test.tsx`

The container reads from `useCommChannelSetup`, manages the transient "publishing" state, dispatches to the right step component, and handles the publish IPC call when funding transitions.

- [ ] **Step 1: Write failing tests**

Create `apps/desktop/src/features/settings/CommChannelSection.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CommChannelSection } from "./CommChannelSection";
import { useCommIdentityStore } from "../../stores/comm-identity";

const FIXTURE_ID = {
  mlDsaPub: "0x" + "11".repeat(1952),
  mlKemPub: "0x" + "22".repeat(1184),
  address: "ckt1qmldsa-fixture",
  addrHash: "0x" + "33".repeat(20),
  createdAt: 1747900000_000,
  fundedAt: null,
  profileTxHash: null,
  profilePublishedAt: null,
};

function resetStore(): void {
  useCommIdentityStore.setState({ identity: null });
  globalThis.localStorage?.removeItem("chain-pay:comm-identity");
}

function mockChainpay(overrides?: { generateReturn?: typeof FIXTURE_ID; generateReject?: Error }) {
  (globalThis as unknown as { window: Window }).window = {
    chainpay: {
      commIdentity: {
        exists: vi.fn().mockResolvedValue(false),
        publicInfo: vi.fn().mockResolvedValue(null),
        generate: overrides?.generateReject
          ? vi.fn().mockRejectedValue(overrides.generateReject)
          : vi.fn().mockResolvedValue(overrides?.generateReturn ?? FIXTURE_ID),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      commTransport: {
        publishProfile: vi.fn().mockResolvedValue({ txHash: "0xpubtx", txBytes: "0x00" }),
        sendMessage: vi.fn(),
        decryptIncoming: vi.fn(),
        resolveProfile: vi.fn(),
      },
    },
  } as never;
}

describe("CommChannelSection", () => {
  beforeEach(() => {
    resetStore();
    mockChainpay();
  });

  it("renders NotConfiguredStep when no identity", () => {
    render(<CommChannelSection />);
    expect(screen.getByText(/Set up comm channel/i)).toBeInTheDocument();
  });

  it("renders FundingStep when identity exists without profileTxHash", () => {
    useCommIdentityStore.setState({ identity: FIXTURE_ID });
    render(<CommChannelSection />);
    expect(screen.getByText(/Comm channel address/i)).toBeInTheDocument();
  });

  it("renders ReadyStep when profileTxHash is set", () => {
    useCommIdentityStore.setState({
      identity: { ...FIXTURE_ID, profileTxHash: "0xtx", profilePublishedAt: Date.now() },
    });
    render(<CommChannelSection />);
    expect(screen.getByText(/Comm channel ready/i)).toBeInTheDocument();
  });

  it("clicking Set up button calls generate IPC", async () => {
    render(<CommChannelSection />);
    const button = screen.getByRole("button", { name: /Set up comm channel/i });
    button.click();
    await waitFor(() => {
      expect(window.chainpay.commIdentity.generate).toHaveBeenCalledTimes(1);
    });
  });

  it("generate error renders error banner in NotConfiguredStep", async () => {
    mockChainpay({ generateReject: new Error("safeStorage unavailable") });
    render(<CommChannelSection />);
    const button = screen.getByRole("button", { name: /Set up comm channel/i });
    button.click();
    await waitFor(() => {
      expect(screen.getByText(/Setup failed/i)).toBeInTheDocument();
      expect(screen.getByText(/safeStorage unavailable/i)).toBeInTheDocument();
    });
  });

  it("Delete identity confirmation flow", async () => {
    useCommIdentityStore.setState({
      identity: { ...FIXTURE_ID, profileTxHash: "0xtx", profilePublishedAt: Date.now() },
    });
    render(<CommChannelSection />);
    screen.getByRole("button", { name: /Delete identity/i }).click();
    expect(screen.getByText(/permanently delete your comm-channel identity/i)).toBeInTheDocument();
    screen.getByRole("button", { name: /Yes, delete/i }).click();
    await waitFor(() => {
      expect(window.chainpay.commIdentity.delete).toHaveBeenCalledTimes(1);
      expect(useCommIdentityStore.getState().identity).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npx vitest run src/features/settings/CommChannelSection.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the container**

Create `apps/desktop/src/features/settings/CommChannelSection.tsx`:

```tsx
import { useState, useEffect } from "react";
import { ccc } from "@ckb-ccc/core";
import { useCommChannelSetup } from "./useCommChannelSetup";
import { useCommIdentityStore } from "../../stores/comm-identity";
import { lightClient } from "../../lib/light-client/client";
import { ProfilePublishError } from "../../lib/comm/errors";
import { NotConfiguredStep } from "./steps/NotConfiguredStep";
import { FundingStep } from "./steps/FundingStep";
import { PublishingStep } from "./steps/PublishingStep";
import { ReadyStep } from "./steps/ReadyStep";

export function CommChannelSection(): JSX.Element {
  const { state, generate, deleteIdentity } = useCommChannelSetup();
  const [generationError, setGenerationError] = useState<Error | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<Error | null>(null);

  async function handleSetup(): Promise<void> {
    setGenerationError(null);
    try {
      await generate();
    } catch (err) {
      setGenerationError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async function handleFunded(): Promise<void> {
    setIsPublishing(true);
    setPublishError(null);
    await runPublish();
  }

  async function runPublish(): Promise<void> {
    try {
      const { txHash, txBytes } = await window.chainpay.commTransport.publishProfile({});
      const txBytesU8 = Uint8Array.from(
        Buffer.from(txBytes.startsWith("0x") ? txBytes.slice(2) : txBytes, "hex"),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = (ccc.Transaction as any).fromBytes(txBytesU8);
      await lightClient().broadcastTransaction(tx);
      useCommIdentityStore.getState().recordProfilePublished(txHash, Date.now());
      setIsPublishing(false);
    } catch (err) {
      setPublishError(
        new ProfilePublishError(null, err instanceof Error ? err.message : "publish failed", {
          cause: err,
        }),
      );
      // Stay in publishing state so the retry UI is shown; FundingStep is the rollback target
      // if the user cancels (handled by setIsPublishing(false) inside onCancel below).
    }
  }

  async function handleDelete(): Promise<void> {
    setIsPublishing(false);
    setPublishError(null);
    await deleteIdentity();
  }

  if (state.kind === "not-configured") {
    return (
      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="mb-3 text-lg font-semibold">Comm channel</h2>
        <NotConfiguredStep onSetup={handleSetup} error={generationError} />
      </section>
    );
  }

  if (state.kind === "funding" && !isPublishing) {
    return (
      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="mb-3 text-lg font-semibold">Comm channel</h2>
        <FundingStep address={state.address} onFunded={handleFunded} onCancel={handleDelete} />
      </section>
    );
  }

  if (state.kind === "funding" && isPublishing) {
    return (
      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="mb-3 text-lg font-semibold">Comm channel</h2>
        <PublishingStep address={state.address} error={publishError} onRetry={runPublish} />
      </section>
    );
  }

  if (state.kind === "ready") {
    return (
      <section className="rounded-lg border border-surface-hi bg-surface p-5">
        <h2 className="mb-3 text-lg font-semibold">Comm channel</h2>
        <ReadyStep
          address={state.address}
          publishedAt={state.publishedAt}
          onDelete={handleDelete}
        />
      </section>
    );
  }

  // Defensive — shouldn't reach here if state.kind enumeration is exhaustive.
  return <></>;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/features/settings/CommChannelSection.test.tsx
```

Expected: 6 passing.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck 2>&1 | tail -3
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/src/features/settings/CommChannelSection.tsx apps/desktop/src/features/settings/CommChannelSection.test.tsx
git commit -m "feat(2.7b-1): CommChannelSection container with state-machine dispatch"
```

---

### Task 19: Wire `CommChannelSection` into `Settings.tsx`

**Files:**
- Modify: `apps/desktop/src/features/settings/Settings.tsx`

- [ ] **Step 1: Read current Settings.tsx**

```bash
cat /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop/src/features/settings/Settings.tsx
```

Currently shows a grid of static `<Card>` components. Add the new section below the grid.

- [ ] **Step 2: Update Settings.tsx**

Replace the contents:

```tsx
import { CommChannelSection } from "./CommChannelSection";

export function Settings() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="grid grid-cols-2 gap-4">
        <Card title="CKB network" body="Mainnet · embedded light client" />
        <Card title="EVM chains" body="Ethereum, Arbitrum, Optimism, Base" />
        <Card title="Signer transports" body="JoyID, Ledger (CKB), MetaMask, WalletConnect (EVM)" />
        <Card title="Frappe backend" body="Not connected · Phase 4" />
      </div>
      <CommChannelSection />
    </div>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-surface-hi bg-surface p-5">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{title}</div>
      <div className="mt-2 text-sm">{body}</div>
    </div>
  );
}
```

**Implementer note:** If Phase 2.6 has already restructured Settings.tsx (e.g. into tabs) and 2.7a/2.7b-1 was branched before that merged, the resolution may need to land `CommChannelSection` in a different way — as a tab, a panel, or a route. The implementer should reconcile with the actual current state of Settings.tsx at merge time. For 2.7b-1 in isolation against the 2.7a worktree's view of main, the above is correct.

- [ ] **Step 3: Build the desktop app**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npm run build 2>&1 | tail -8
```

Expected: success.

- [ ] **Step 4: Run all tests**

```bash
npx vitest run 2>&1 | tail -8
```

Expected: all passing (~165 tests = 141 baseline + ~24 from Phase A and B).

- [ ] **Step 5: Manual smoke from the Settings UI**

This is the gate. Start the dev server, open the Electron window, navigate to Settings, walk through the ceremony:

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npm run dev
```

- Settings page shows the new "Comm channel" section with NotConfiguredStep
- Click "Set up comm channel" → identity generates → FundingStep appears with the new address
- Fund the address from an external testnet wallet (faucet or transfer)
- Within ~10s the balance updates; once ≥70 CKB the ceremony auto-publishes
- Publishing succeeds → ReadyStep appears
- Restart the app → ReadyStep still appears (persisted)
- Click "Delete identity" → confirmation → state returns to NotConfiguredStep

If all these work, Phase 2.7b-1's GUI ceremony is functional.

If the smoke roundtrip script (Task 18 of 2.7a, unchanged) ALSO completes end-to-end against this new build, 2.7b-1 is done.

- [ ] **Step 6: Commit**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1
git add apps/desktop/src/features/settings/Settings.tsx
git commit -m "feat(2.7b-1): Settings page hosts CommChannelSection ceremony"
```

---

## Wrap-up

After Task 19:

- [ ] **Run the full unit suite**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npm test
```

Expected: ~165 tests passing.

- [ ] **Run cemp-pq's tests**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/packages/cemp-pq && npm test
```

Expected: 3 passing.

- [ ] **Build**

```bash
cd /home/phill/chain-pay/.worktrees/phase-2-7b-1/apps/desktop && npm run build
```

Expected: success.

- [ ] **Manual smoke roundtrip on testnet** (Phill, two funded wallets)

Run `scripts/smoke-comm-roundtrip.mts` in both roles per the existing playbook. Tick the verification checkpoints from the spec:

- [ ] Generate identity from Settings → persists across restart
- [ ] Address copies cleanly
- [ ] Balance updates within 10s of external transfer
- [ ] Auto-publish fires within one poll tick of crossing 70 CKB
- [ ] Profile cell visible on testnet explorer
- [ ] Delete identity → confirmation → returns to NotConfigured
- [ ] After delete + regenerate, transport singleton rebuilds
- [ ] Smoke script ends with "roundtrip OK" on both roles

Once green, Phase 2.7b-1 is complete. Open the 2.7b-2 spec.

---

## Spec coverage check

| Spec section | Tasks |
|---|---|
| Architecture & file layout | 1, 2, 3, 4, 5, 6, 8, 10, 11, 13–19 |
| Components & interfaces (cemp-pq patches) | 1, 2, 3, 4 |
| Components & interfaces (CommIdentityState + own-identity-hash) | 5, 8 |
| Components & interfaces (singleton + boot) | 10, 11 |
| Components & interfaces (Settings ceremony) | 13, 14, 15, 16, 17, 18, 19 |
| Data flow — boot | 11 |
| Data flow — happy path ceremony | 14, 15, 16, 17, 18 |
| Data flow — error paths | 13, 14, 18 |
| Data flow — identity deletion | 14, 17 |
| Data flow — smoke roundtrip after fixes | 1, 2 (validated in manual smoke after Task 19) |
| Error handling (typed classes) | 13 |
| Failure matrix coverage | 14, 16, 17, 18 |
| Testing (unit) | 3, 5, 7, 8, 10, 14, 18 |
| Testing (smoke) | manual gate after Task 19 |
| Manual verification checkpoints | Task 19 step 5, Wrap-up |
| Out of scope | None ship in 2.7b-1 — verified by absence of PayPanel/SignPanel/Peer-book tasks |
