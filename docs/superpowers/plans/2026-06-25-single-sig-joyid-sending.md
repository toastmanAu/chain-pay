# Single-Sig JoyID Sending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an SMB pay one or more payees from a single JoyID-controlled CKB wallet — build unsigned tx from the embedded light client, sign the whole tx via JoyID, broadcast, confirm, and post a balanced Journal Entry.

**Architecture:** A new parallel payment path that never touches the multisig relay. A `Source` (JoyID wallet) is the funding account; a pure tx-builder assembles an unsigned CKB tx using the JoyID lock; a `CkbTxSigner` hands the whole tx to JoyID for signing; the light-client host broadcasts; a lean state machine drives the `SendRecord` to `confirmed`, which posts a JE via the Phase-5 accounting bridge.

**Tech Stack:** TypeScript, React, Zustand (+persist), `@ckb-ccc/core` (Transaction/Script/Address/ClientPublic*), `@joyid/ckb` (new), Vitest.

## Global Constraints

- **Never custody keys** — JoyID signs; no key material in renderer or main. (hard-rule #1)
- **Light-client first** — collect cells via the embedded light client (`lightClient()` host); never a public CCC collector for reads. Broadcast via `host.broadcastTransaction` (routes to the Settings full-node RPC). (hard-rule #2)
- **Adapters stay adapters** — CKB logic lives in `src/lib/chains/ckb/`; signer transports in `src/lib/signers/`; never in features. (hard-rule #3)
- **Every confirmed payment posts a JE** — reuse the Phase-5 bridge; zero-FX policy (obligation == carryingCost, fee fiat 0). (hard-rule #5)
- **Immutability** — return new objects; never mutate store state in place.
- **Files <800 lines, functions <50 lines, nesting ≤4.** TDD: failing test first. Frequent commits.
- **CKB blake160 = `blake2b(outlen=32)[..20]`** via `HasherCkb(32)`, never `HasherCkb(20)`.
- **JoyID witness under-counts** — pad witness[0] with a 1000-byte placeholder in the caller BEFORE fee completion (per `~/.claude/rules/ckb-transactions.md`).
- **Recipient min cell capacity** — every payee output must be ≥ `minCapacityForLock(lock)` (the −302 `InsufficientCellCapacity` trap); secp recipients need ~61 CKB.
- This branch (`feat/single-sig-joyid-send`) is **stacked on `feat/phase5-accounting-bridge` (PR #15)** — the accounting bridge under `src/lib/accounting/` comes from there. Merge #15 before this branch's PR.

---

## File Structure

**Shared (`packages/shared/src/`)**
- Create `funding.ts` — `FundableAccount`, `Source`, `treasuryAsFundable`, `sourceAsFundable`.
- Create `send.ts` — `SendState`, `SendOutput`, `SendRecord`.
- Modify `index.ts` — re-export the two new modules.

**Desktop (`apps/desktop/src/`)**
- Create `stores/sources.ts` — persisted JoyID wallet records.
- Create `stores/sends.ts` — persisted `SendRecord`s + lifecycle actions.
- Create `lib/send/state-machine.ts` — `SendState` transition table.
- Create `lib/chains/ckb/joyid-lock.ts` — resolve JoyID lock Script + cellDeps.
- Create `lib/chains/ckb/single-sig-tx-builder.ts` — pure unsigned-tx builder.
- Create `lib/signers/ckb-tx-signer.ts` — `CkbTxSigner` interface.
- Create `lib/signers/mock-ckb-tx-signer.ts` — deterministic test signer.
- Create `lib/signers/joyid-ckb-tx-signer.ts` — real JoyID signer (`@joyid/ckb`).
- Create `lib/send/send-journal.ts` — `buildSendJournalInputs`, `postSendJournal`.
- Create `lib/send/use-send-confirmation-to-accounting.ts` — confirmed→post reactor.
- Create `lib/send/build-and-send.ts` — orchestrator (build→sign→broadcast→drive state).
- Create `features/send/SourceList.tsx`, `features/send/SendPanel.tsx`, `features/send/SendHistory.tsx`.
- Modify `App.tsx` — route `/send`, mount the send accounting reactor.
- Modify `components/layout/Sidebar.tsx` — nav entry.

---

## Task 1: Shared `FundableAccount` + `Source` types and adapters

**Files:**
- Create: `packages/shared/src/funding.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/funding.test.ts`

**Interfaces:**
- Consumes: `Identified`, `Timestamped`, `Hex20` from `./types`; `ChainId` from `./chainIds`; `Treasury`, `MultisigConfig` from `./treasury`.
- Produces:
  - `interface FundableAccount { id: string; label: string; chain: ChainId; address: string; lockKind: "ckb-multisig" | "ckb-joyid-single"; capabilities: { coSign: boolean } }`
  - `interface Source extends Identified, Timestamped { label: string; chain: "ckb:mainnet" | "ckb:testnet"; address: string; joyidLockArgs: Hex20; notes?: string }`
  - `function treasuryAsFundable(t: Treasury): FundableAccount`
  - `function sourceAsFundable(s: Source): FundableAccount`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/funding.test.ts
import { describe, it, expect } from "vitest";
import { treasuryAsFundable, sourceAsFundable, type Source } from "./funding";
import type { Treasury } from "./treasury";

const source: Source = {
  id: "s1",
  label: "Ops wallet",
  chain: "ckb:testnet",
  address: "ckt1qjoyid...",
  joyidLockArgs: "0x1234567890123456789012345678901234567890",
  createdAt: "2026-06-25T00:00:00Z",
  updatedAt: "2026-06-25T00:00:00Z",
};

const treasury: Treasury = {
  id: "t1",
  label: "Main treasury",
  createdAt: "2026-06-25T00:00:00Z",
  updatedAt: "2026-06-25T00:00:00Z",
  multisig: {
    chain: "ckb:testnet",
    s: 0, r: 0, m: 2, n: 3,
    pubkeyHashes: [],
    address: "ckt1qmultisig...",
  },
};

describe("FundableAccount adapters", () => {
  it("maps a Source to a single-sig FundableAccount that cannot co-sign", () => {
    const f = sourceAsFundable(source);
    expect(f).toEqual({
      id: "s1",
      label: "Ops wallet",
      chain: "ckb:testnet",
      address: "ckt1qjoyid...",
      lockKind: "ckb-joyid-single",
      capabilities: { coSign: false },
    });
  });

  it("maps a Treasury to a multisig FundableAccount that can co-sign", () => {
    const f = treasuryAsFundable(treasury);
    expect(f.id).toBe("t1");
    expect(f.address).toBe("ckt1qmultisig...");
    expect(f.lockKind).toBe("ckb-multisig");
    expect(f.capabilities.coSign).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/funding.test.ts`
Expected: FAIL — `Cannot find module './funding'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/shared/src/funding.ts
import type { Identified, Timestamped, Hex20 } from "./types";
import type { ChainId } from "./chainIds";
import type { Treasury } from "./treasury";

export interface FundableAccount {
  id: string;
  label: string;
  chain: ChainId;
  address: string;
  lockKind: "ckb-multisig" | "ckb-joyid-single";
  capabilities: { coSign: boolean };
}

/** A single-sig JoyID-controlled wallet — the non-treasury funding source. */
export interface Source extends Identified, Timestamped {
  label: string;
  chain: "ckb:mainnet" | "ckb:testnet";
  /** JoyID CKB address (ckb1.../ckt1...). */
  address: string;
  /** JoyID lock args, for watchLockScript + change outputs. */
  joyidLockArgs: Hex20;
  notes?: string;
}

export function treasuryAsFundable(t: Treasury): FundableAccount {
  return {
    id: t.id,
    label: t.label,
    chain: t.multisig.chain,
    address: t.multisig.address,
    lockKind: "ckb-multisig",
    capabilities: { coSign: true },
  };
}

export function sourceAsFundable(s: Source): FundableAccount {
  return {
    id: s.id,
    label: s.label,
    chain: s.chain,
    address: s.address,
    lockKind: "ckb-joyid-single",
    capabilities: { coSign: false },
  };
}
```

- [ ] **Step 4: Add the re-export**

In `packages/shared/src/index.ts`, add (follow the existing `export * from "./..."` style):

```typescript
export * from "./funding";
export * from "./send";
```

(`./send` is created in Task 3; adding both exports now is harmless — TS resolves them once the files exist. If your toolchain errors on a missing `./send` here, add only `./funding` now and `./send` in Task 3.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/funding.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/funding.ts packages/shared/src/funding.test.ts packages/shared/src/index.ts
git commit -m "feat(send): shared FundableAccount + Source types and adapters"
```

---

## Task 2: `sources` store

**Files:**
- Create: `apps/desktop/src/stores/sources.ts`
- Test: `apps/desktop/src/stores/sources.test.ts`

**Interfaces:**
- Consumes: `Source` from `@chain-pay/shared`.
- Produces: `useSourcesStore` with `{ sources: Source[]; activeSourceId: string | null; addSource(s): void; removeSource(id): void; setActiveSource(id): void; findById(id): Source | undefined }`.

Mirror `stores/treasury.ts` exactly (zustand `persist` + `createJSONStorage` + the `StateStorage` localStorage shim) but with NO bigint fields, so plain JSON — omit the `bigintReplacer`/`bigintReviver`. Persist name `chain-pay:sources`, version 1.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/stores/sources.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import type { Source } from "@chain-pay/shared";

function makeSource(id: string): Source {
  return {
    id,
    label: `wallet ${id}`,
    chain: "ckb:testnet",
    address: `ckt1q${id}`,
    joyidLockArgs: "0x1234567890123456789012345678901234567890",
    createdAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z",
  };
}

// localStorage shim for the node test env (mirrors stores/treasury.test.ts)
beforeEach(() => {
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

describe("useSourcesStore", () => {
  it("adds a source and auto-selects the first one", async () => {
    const { useSourcesStore } = await import("./sources");
    useSourcesStore.setState({ sources: [], activeSourceId: null });
    useSourcesStore.getState().addSource(makeSource("a"));
    const s = useSourcesStore.getState();
    expect(s.sources).toHaveLength(1);
    expect(s.activeSourceId).toBe("a");
  });

  it("removes a source and clears active when it was active", async () => {
    const { useSourcesStore } = await import("./sources");
    useSourcesStore.setState({ sources: [], activeSourceId: null });
    useSourcesStore.getState().addSource(makeSource("a"));
    useSourcesStore.getState().removeSource("a");
    expect(useSourcesStore.getState().sources).toHaveLength(0);
    expect(useSourcesStore.getState().activeSourceId).toBeNull();
  });

  it("finds by id", async () => {
    const { useSourcesStore } = await import("./sources");
    useSourcesStore.setState({ sources: [], activeSourceId: null });
    useSourcesStore.getState().addSource(makeSource("a"));
    expect(useSourcesStore.getState().findById("a")?.label).toBe("wallet a");
    expect(useSourcesStore.getState().findById("z")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/stores/sources.test.ts`
Expected: FAIL — cannot find `./sources`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/desktop/src/stores/sources.ts
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
        set((st) => ({
          sources: [...st.sources, s],
          activeSourceId: st.activeSourceId ?? s.id,
        })),
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
      version: 1,
      partialize: (st) => ({ sources: st.sources, activeSourceId: st.activeSourceId }),
    },
  ),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/stores/sources.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/sources.ts apps/desktop/src/stores/sources.test.ts
git commit -m "feat(send): sources store for JoyID single-sig wallets"
```

---

## Task 3: Shared send types + send state machine

**Files:**
- Create: `packages/shared/src/send.ts`
- Create: `apps/desktop/src/lib/send/state-machine.ts`
- Modify: `packages/shared/src/index.ts` (if `./send` export not added in Task 1)
- Test: `apps/desktop/src/lib/send/state-machine.test.ts`

**Interfaces:**
- Consumes: `Identified`, `Timestamped`, `TransactionHash` from `./types`; `Money`, `FiatAmount` from `./money`.
- Produces (`send.ts`):
  - `type SendState = "draft" | "built" | "signing" | "broadcasted" | "confirmed" | "posting" | "posted" | "post_failed"`
  - `interface SendOutput { payeeId: string; payeeAddress: string; amount: Money; fiat: FiatAmount }`
  - `interface SendRecord extends Identified, Timestamped { sourceId: string; chain: "ckb:mainnet" | "ckb:testnet"; outputs: SendOutput[]; feeShannons: bigint; state: SendState; txHash?: TransactionHash; journalEntryName?: string; postError?: string }`
- Produces (`state-machine.ts`): `canTransition(from, to)`, `assertCanTransition(from, to)`, `isTerminal(state)`, `nextStates(from)`.

Note: `SendOutput.fiat` is the user-entered fiat valuation of the line (zero-FX policy: obligation == carryingCost). FX auto-valuation is Slice D.

- [ ] **Step 1: Write `send.ts` (no test of its own — it's pure types)**

```typescript
// packages/shared/src/send.ts
import type { Identified, Timestamped, TransactionHash } from "./types";
import type { Money, FiatAmount } from "./money";

export type SendState =
  | "draft"
  | "built"
  | "signing"
  | "broadcasted"
  | "confirmed"
  | "posting"
  | "posted"
  | "post_failed";

export interface SendOutput {
  payeeId: string;
  payeeAddress: string;
  amount: Money;
  /** User-entered fiat valuation of this line (zero-FX: obligation == carryingCost). */
  fiat: FiatAmount;
}

export interface SendRecord extends Identified, Timestamped {
  sourceId: string;
  chain: "ckb:mainnet" | "ckb:testnet";
  outputs: SendOutput[];
  feeShannons: bigint;
  state: SendState;
  txHash?: TransactionHash;
  journalEntryName?: string;
  postError?: string;
}
```

Ensure `export * from "./send";` is present in `packages/shared/src/index.ts`.

- [ ] **Step 2: Write the failing state-machine test**

```typescript
// apps/desktop/src/lib/send/state-machine.test.ts
import { describe, it, expect } from "vitest";
import { canTransition, assertCanTransition, isTerminal, nextStates } from "./state-machine";

describe("send state machine", () => {
  it("allows the happy path forward edges", () => {
    expect(canTransition("draft", "built")).toBe(true);
    expect(canTransition("built", "signing")).toBe(true);
    expect(canTransition("signing", "broadcasted")).toBe(true);
    expect(canTransition("broadcasted", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "posting")).toBe(true);
    expect(canTransition("posting", "posted")).toBe(true);
    expect(canTransition("posting", "post_failed")).toBe(true);
    expect(canTransition("post_failed", "posting")).toBe(true);
  });

  it("returns signing/broadcast failures to built", () => {
    expect(canTransition("signing", "built")).toBe(true);
    expect(canTransition("broadcasted", "built")).toBe(false); // in flight, chain decides
  });

  it("forbids same-state and post-terminal transitions", () => {
    expect(canTransition("built", "built")).toBe(false);
    expect(canTransition("posted", "posting")).toBe(false);
    expect(isTerminal("posted")).toBe(true);
    expect(isTerminal("confirmed")).toBe(false);
  });

  it("assertCanTransition throws on an illegal edge", () => {
    expect(() => assertCanTransition("draft", "confirmed")).toThrow(/invalid send transition/);
  });

  it("nextStates lists forward edges", () => {
    expect(nextStates("confirmed")).toEqual(["posting"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/send/state-machine.test.ts`
Expected: FAIL — cannot find `./state-machine`.

- [ ] **Step 4: Write minimal implementation**

```typescript
// apps/desktop/src/lib/send/state-machine.ts
import type { SendState } from "@chain-pay/shared";

/**
 * draft → built → signing → broadcasted → confirmed → posting → posted
 * signing failure → built (re-build/re-sign). broadcast in flight is irreversible.
 * confirmed → posting → posted (terminal) | post_failed → posting (retry).
 */
const TRANSITIONS: Record<SendState, SendState[]> = {
  draft: ["built"],
  built: ["signing"],
  signing: ["broadcasted", "built"],
  broadcasted: ["confirmed"],
  confirmed: ["posting"],
  posting: ["posted", "post_failed"],
  post_failed: ["posting"],
  posted: [],
};

const terminalStates: readonly SendState[] = ["posted"];

export function canTransition(from: SendState, to: SendState): boolean {
  if (from === to) return false;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertCanTransition(from: SendState, to: SendState): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `invalid send transition: ${from} → ${to} (allowed from '${from}': ${TRANSITIONS[from]?.join(", ") || "none"})`,
    );
  }
}

export function isTerminal(state: SendState): boolean {
  return terminalStates.includes(state);
}

export function nextStates(from: SendState): SendState[] {
  return TRANSITIONS[from] ?? [];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/lib/send/state-machine.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/send.ts packages/shared/src/index.ts apps/desktop/src/lib/send/state-machine.ts apps/desktop/src/lib/send/state-machine.test.ts
git commit -m "feat(send): shared send types + send state machine"
```

---

## Task 4: `sends` store

**Files:**
- Create: `apps/desktop/src/stores/sends.ts`
- Test: `apps/desktop/src/stores/sends.test.ts`

**Interfaces:**
- Consumes: `SendRecord`, `SendState`, `TransactionHash` from `@chain-pay/shared`; `assertCanTransition` from `@/lib/send/state-machine`.
- Produces: `useSendsStore` with `{ sends: SendRecord[]; addSend(s): void; markBuilt(id, feeShannons): void; markSigning(id): void; markBroadcasted(id, txHash): void; markBackToBuilt(id): void; markConfirmed(id): void; markPosting(id): void; markPosted(id, jeName): void; markPostFailed(id, error): void }`.

Mirror `stores/payroll-batches.ts`: persist (`chain-pay:sends`, version 1) with the bigint replacer/reviver (since `feeShannons` and `amount.value`/`fiat.minor` are bigint), and each `mark*` action validates via `assertCanTransition` before updating, returning a NEW array (immutability).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/stores/sends.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import type { SendRecord } from "@chain-pay/shared";

function makeSend(id: string): SendRecord {
  return {
    id,
    sourceId: "src1",
    chain: "ckb:testnet",
    outputs: [
      {
        payeeId: "p1",
        payeeAddress: "ckt1qpayee",
        amount: { asset: "CKB", value: 7_000_000_000n, decimals: 8 },
        fiat: { currency: "AUD", minor: 10000n },
      },
    ],
    feeShannons: 0n,
    state: "draft",
    createdAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z",
  };
}

beforeEach(() => {
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

describe("useSendsStore", () => {
  it("drives a send through the happy path", async () => {
    const { useSendsStore } = await import("./sends");
    useSendsStore.setState({ sends: [] });
    const st = useSendsStore.getState();
    st.addSend(makeSend("x"));
    st.markBuilt("x", 1200n);
    st.markSigning("x");
    st.markBroadcasted("x", "0xabc");
    st.markConfirmed("x");
    st.markPosting("x");
    st.markPosted("x", "ACC-JV-0001");
    const s = useSendsStore.getState().sends.find((r) => r.id === "x")!;
    expect(s.state).toBe("posted");
    expect(s.feeShannons).toBe(1200n);
    expect(s.txHash).toBe("0xabc");
    expect(s.journalEntryName).toBe("ACC-JV-0001");
  });

  it("rejects an illegal transition", async () => {
    const { useSendsStore } = await import("./sends");
    useSendsStore.setState({ sends: [] });
    useSendsStore.getState().addSend(makeSend("y"));
    expect(() => useSendsStore.getState().markConfirmed("y")).toThrow(/invalid send transition/);
  });

  it("records a post failure and allows retry back to posting", async () => {
    const { useSendsStore } = await import("./sends");
    useSendsStore.setState({ sends: [] });
    const st = useSendsStore.getState();
    st.addSend(makeSend("z"));
    st.markBuilt("z", 1200n);
    st.markSigning("z");
    st.markBroadcasted("z", "0xdef");
    st.markConfirmed("z");
    st.markPosting("z");
    st.markPostFailed("z", "backend down");
    expect(useSendsStore.getState().sends.find((r) => r.id === "z")!.state).toBe("post_failed");
    useSendsStore.getState().markPosting("z");
    expect(useSendsStore.getState().sends.find((r) => r.id === "z")!.state).toBe("posting");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/stores/sends.test.ts`
Expected: FAIL — cannot find `./sends`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/desktop/src/stores/sends.ts
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { SendRecord, SendState, TransactionHash } from "@chain-pay/shared";
import { assertCanTransition } from "@/lib/send/state-machine";

interface SendsStore {
  sends: SendRecord[];
  addSend: (s: SendRecord) => void;
  markBuilt: (id: string, feeShannons: bigint) => void;
  markSigning: (id: string) => void;
  markBroadcasted: (id: string, txHash: TransactionHash) => void;
  markBackToBuilt: (id: string) => void;
  markConfirmed: (id: string) => void;
  markPosting: (id: string) => void;
  markPosted: (id: string, jeName: string) => void;
  markPostFailed: (id: string, error: string) => void;
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? `${v.toString()}n` : v;
}
function bigintReviver(_k: string, v: unknown): unknown {
  return typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
}

const sendsStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

function transition(
  sends: SendRecord[],
  id: string,
  to: SendState,
  patch: (s: SendRecord) => SendRecord,
): SendRecord[] {
  return sends.map((s) => {
    if (s.id !== id) return s;
    assertCanTransition(s.state, to);
    return { ...patch(s), state: to, updatedAt: s.updatedAt };
  });
}

export const useSendsStore = create<SendsStore>()(
  persist(
    (set) => ({
      sends: [],
      addSend: (s) => set((st) => ({ sends: [...st.sends, s] })),
      markBuilt: (id, feeShannons) =>
        set((st) => ({ sends: transition(st.sends, id, "built", (s) => ({ ...s, feeShannons })) })),
      markSigning: (id) =>
        set((st) => ({ sends: transition(st.sends, id, "signing", (s) => s) })),
      markBroadcasted: (id, txHash) =>
        set((st) => ({ sends: transition(st.sends, id, "broadcasted", (s) => ({ ...s, txHash })) })),
      markBackToBuilt: (id) =>
        set((st) => ({ sends: transition(st.sends, id, "built", (s) => s) })),
      markConfirmed: (id) =>
        set((st) => ({ sends: transition(st.sends, id, "confirmed", (s) => s) })),
      markPosting: (id) =>
        set((st) => ({ sends: transition(st.sends, id, "posting", (s) => s) })),
      markPosted: (id, jeName) =>
        set((st) => ({
          sends: transition(st.sends, id, "posted", (s) => ({ ...s, journalEntryName: jeName, postError: undefined })),
        })),
      markPostFailed: (id, error) =>
        set((st) => ({
          sends: transition(st.sends, id, "post_failed", (s) => ({ ...s, postError: error })),
        })),
    }),
    {
      name: "chain-pay:sends",
      storage: createJSONStorage(() => sendsStorage, { replacer: bigintReplacer, reviver: bigintReviver }),
      version: 1,
      partialize: (st) => ({ sends: st.sends }),
    },
  ),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/stores/sends.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/sends.ts apps/desktop/src/stores/sends.test.ts
git commit -m "feat(send): sends store with validated lifecycle transitions"
```

---

## Task 5: JoyID lock resolution

**Files:**
- Create: `apps/desktop/src/lib/chains/ckb/joyid-lock.ts`
- Test: `apps/desktop/src/lib/chains/ckb/joyid-lock.test.ts`

**Interfaces:**
- Consumes: `Script`, `CellDep`, `ScriptInfo`, `KnownScript`, `ClientPublicTestnet`, `ClientPublicMainnet` from `@ckb-ccc/core`; `CkbNetwork` from `../../light-client/network-configs`.
- Produces:
  - `function joyidLockAndDeps(scriptInfo: ScriptInfo, args: string): { lock: Script; cellDeps: CellDep[] }` — PURE.
  - `async function resolveJoyIdScriptInfo(network: CkbNetwork): Promise<ScriptInfo>` — thin async; not unit-tested (manual smoke).

`ScriptInfo` is `{ codeHash: Hex; hashType: HashType; cellDeps: CellDepInfo[] }`. Build the lock from `codeHash`/`hashType`/`args`; map `cellDeps` to bare `CellDep[]` via `.map((c) => CellDep.from(c.cellDep))`.

- [ ] **Step 1: Write the failing test (pure converter only)**

```typescript
// apps/desktop/src/lib/chains/ckb/joyid-lock.test.ts
import { describe, it, expect } from "vitest";
import { CellDep, ScriptInfo } from "@ckb-ccc/core";
import { joyidLockAndDeps } from "./joyid-lock";

const JOYID_CODE_HASH = "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac";
const ARGS = "0x0001f293e5a5d1f8e8b7c6a5b4c3d2e1f00112233";

function fakeScriptInfo(): ScriptInfo {
  return ScriptInfo.from({
    codeHash: JOYID_CODE_HASH,
    hashType: "type",
    cellDeps: [
      {
        cellDep: {
          outPoint: {
            txHash: "0x4dcf3f3b09efac8995d6cbee87c5345e812d310094651e0c3d9a730f32dc9263",
            index: 0,
          },
          depType: "depGroup",
        },
      },
    ],
  });
}

describe("joyidLockAndDeps", () => {
  it("builds the JoyID lock script from scriptInfo + args", () => {
    const { lock } = joyidLockAndDeps(fakeScriptInfo(), ARGS);
    expect(lock.codeHash).toBe(JOYID_CODE_HASH);
    expect(lock.hashType).toBe("type");
    expect(lock.args).toBe(ARGS);
  });

  it("extracts the JoyID cell deps", () => {
    const { cellDeps } = joyidLockAndDeps(fakeScriptInfo(), ARGS);
    expect(cellDeps).toHaveLength(1);
    expect(cellDeps[0]).toBeInstanceOf(CellDep);
    expect(cellDeps[0].depType).toBe("depGroup");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/chains/ckb/joyid-lock.test.ts`
Expected: FAIL — cannot find `./joyid-lock`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/desktop/src/lib/chains/ckb/joyid-lock.ts
import {
  CellDep,
  ClientPublicMainnet,
  ClientPublicTestnet,
  KnownScript,
  Script,
  ScriptInfo,
} from "@ckb-ccc/core";
import type { CkbNetwork } from "../../light-client/network-configs";

/** PURE: build the JoyID lock Script + its cell deps from resolved ScriptInfo + args. */
export function joyidLockAndDeps(
  scriptInfo: ScriptInfo,
  args: string,
): { lock: Script; cellDeps: CellDep[] } {
  const lock = Script.from({
    codeHash: scriptInfo.codeHash,
    hashType: scriptInfo.hashType,
    args,
  });
  const cellDeps = scriptInfo.cellDeps.map((c) => CellDep.from(c.cellDep));
  return { lock, cellDeps };
}

/**
 * Resolve the JoyID known-script config for a network. CCC ships the JoyID
 * codeHash/hashType/cellDeps as static known-script data — this is a lookup,
 * not an RPC round-trip, so it doesn't violate light-client-first. Not unit
 * tested (exercised by manual JoyID smoke).
 */
export async function resolveJoyIdScriptInfo(network: CkbNetwork): Promise<ScriptInfo> {
  const client = network === "mainnet" ? new ClientPublicMainnet() : new ClientPublicTestnet();
  return client.getKnownScript(KnownScript.JoyId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/lib/chains/ckb/joyid-lock.test.ts`
Expected: PASS (2 tests).

If `ScriptInfo.from` / `CellDep.from` shapes differ from the test fixture, adjust the fixture to match `@ckb-ccc/core` — the production converter is the unit under test, not the fixture.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/chains/ckb/joyid-lock.ts apps/desktop/src/lib/chains/ckb/joyid-lock.test.ts
git commit -m "feat(send): resolve JoyID lock script + cell deps from CCC known scripts"
```

---

## Task 6: Single-sig tx-builder (pure)

**Files:**
- Create: `apps/desktop/src/lib/chains/ckb/single-sig-tx-builder.ts`
- Test: `apps/desktop/src/lib/chains/ckb/single-sig-tx-builder.test.ts`

**Interfaces:**
- Consumes: `Cell`, `CellDep`, `CellInput`, `CellOutput`, `Script`, `Transaction`, `hexFrom`, `numFrom` from `@ckb-ccc/core`; `minCapacityForLock` from `./tx-builder`.
- Produces:
  - `const JOYID_WITNESS_PLACEHOLDER_BYTES = 1000`
  - `interface SingleSigRecipient { lock: Script; capacity: bigint }`
  - `interface SingleSigSendInput { sourceLock: Script; joyidCellDeps: CellDep[]; recipients: SingleSigRecipient[]; availableCells: Cell[]; feeRateShannonsPerByte: bigint }`
  - `interface SingleSigSendSkeleton { tx: Transaction; totalIn: bigint; totalOut: bigint; change: bigint; fee: bigint }`
  - `function buildSingleSigSend(input: SingleSigSendInput): SingleSigSendSkeleton`

This mirrors `buildPaymentSkeleton` (Task reference: `lib/chains/ckb/tx-builder.ts`) but: cellDeps = `input.joyidCellDeps`; witness[0] is a `JOYID_WITNESS_PLACEHOLDER_BYTES`-long zero placeholder (JoyID fills the real lock at sign time); change goes to `sourceLock`; recipient min-capacity is validated. Inputs are selected greedy-largest-first; change is dropped to fee when below min.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/lib/chains/ckb/single-sig-tx-builder.test.ts
import { describe, it, expect } from "vitest";
import { Cell, CellDep, Script, hexFrom } from "@ckb-ccc/core";
import {
  buildSingleSigSend,
  JOYID_WITNESS_PLACEHOLDER_BYTES,
  type SingleSigSendInput,
} from "./single-sig-tx-builder";
import { minCapacityForLock } from "./tx-builder";

const JOYID = "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac";
const SECP = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

function joyidLock(): Script {
  return Script.from({ codeHash: JOYID, hashType: "type", args: "0x" + "11".repeat(20) });
}
function payeeLock(): Script {
  return Script.from({ codeHash: SECP, hashType: "type", args: "0x" + "22".repeat(20) });
}
function cell(capacityCkb: bigint, idx: number): Cell {
  return Cell.from({
    outPoint: { txHash: "0x" + "ab".repeat(32), index: idx },
    cellOutput: { capacity: capacityCkb * 100_000_000n, lock: joyidLock() },
    outputData: hexFrom("0x"),
  });
}
function joyidDeps(): CellDep[] {
  return [
    CellDep.from({
      outPoint: { txHash: "0x" + "cd".repeat(32), index: 0 },
      depType: "depGroup",
    }),
  ];
}

function baseInput(): SingleSigSendInput {
  return {
    sourceLock: joyidLock(),
    joyidCellDeps: joyidDeps(),
    recipients: [{ lock: payeeLock(), capacity: 100n * 100_000_000n }],
    availableCells: [cell(200n, 0)],
    feeRateShannonsPerByte: 1200n,
  };
}

describe("buildSingleSigSend", () => {
  it("builds a tx paying the recipient with change back to the source", () => {
    const { tx, change, fee, totalIn } = buildSingleSigSend(baseInput());
    expect(tx.inputs.length).toBe(1);
    expect(tx.outputs.length).toBe(2); // recipient + change
    expect(tx.outputs[1].lock.args).toBe(joyidLock().args); // change to source
    expect(totalIn).toBe(200n * 100_000_000n);
    expect(change).toBeGreaterThan(0n);
    expect(fee).toBeGreaterThan(0n);
  });

  it("uses the JoyID cell deps", () => {
    const { tx } = buildSingleSigSend(baseInput());
    expect(tx.cellDeps.length).toBe(1);
    expect(tx.cellDeps[0].depType).toBe("depGroup");
  });

  it("pre-pads witness[0] for the JoyID lock before fee estimation", () => {
    const { tx } = buildSingleSigSend(baseInput());
    const w0 = tx.witnesses[0];
    // hex string of >= JOYID_WITNESS_PLACEHOLDER_BYTES bytes (2 hex chars/byte + 0x)
    expect(w0.length).toBeGreaterThanOrEqual(2 + JOYID_WITNESS_PLACEHOLDER_BYTES * 2);
  });

  it("rejects a recipient below min cell capacity", () => {
    const input = baseInput();
    const min = minCapacityForLock(payeeLock());
    input.recipients = [{ lock: payeeLock(), capacity: min - 1n }];
    expect(() => buildSingleSigSend(input)).toThrow(/below min capacity/);
  });

  it("throws when balance cannot cover outputs + fee", () => {
    const input = baseInput();
    input.availableCells = [cell(100n, 0)]; // exactly the output, nothing for fee
    expect(() => buildSingleSigSend(input)).toThrow(/insufficient/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/chains/ckb/single-sig-tx-builder.test.ts`
Expected: FAIL — cannot find `./single-sig-tx-builder`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/desktop/src/lib/chains/ckb/single-sig-tx-builder.ts
import {
  Cell,
  CellDep,
  CellInput,
  CellOutput,
  hexFrom,
  Script,
  Transaction,
} from "@ckb-ccc/core";
import { minCapacityForLock } from "./tx-builder";

const SHANNONS_PER_BYTE = 100_000_000n;
const TX_SIZE_OVERHEAD_BYTES = 4n;

/**
 * JoyID's real witness lock (WebAuthn authenticatorData + clientDataJSON + sig)
 * is larger than a bare secp witness. Pre-pad witness[0] so fee estimation
 * accounts for it; JoyID overwrites this slot at sign time. 1000 bytes covers a
 * plain transfer per ~/.claude/rules/ckb-transactions.md (mints need more, but
 * single-sig SMB sends are plain transfers).
 */
export const JOYID_WITNESS_PLACEHOLDER_BYTES = 1000;

export interface SingleSigRecipient {
  lock: Script;
  capacity: bigint;
}

export interface SingleSigSendInput {
  sourceLock: Script;
  joyidCellDeps: CellDep[];
  recipients: SingleSigRecipient[];
  availableCells: Cell[];
  feeRateShannonsPerByte: bigint;
}

export interface SingleSigSendSkeleton {
  tx: Transaction;
  totalIn: bigint;
  totalOut: bigint;
  change: bigint;
  fee: bigint;
}

export function buildSingleSigSend(input: SingleSigSendInput): SingleSigSendSkeleton {
  validate(input);

  const tx = Transaction.from({
    version: 0n,
    cellDeps: input.joyidCellDeps,
    headerDeps: [],
    inputs: [],
    outputs: [],
    outputsData: [],
    witnesses: [],
  });

  for (const r of input.recipients) {
    tx.outputs.push(CellOutput.from({ capacity: r.capacity, lock: r.lock }));
    tx.outputsData.push(hexFrom("0x"));
  }
  const totalOut = input.recipients.reduce((s, r) => s + r.capacity, 0n);

  // JoyID witness placeholder before fee estimation (zeros; JoyID fills it).
  tx.setWitnessAt(0, hexFrom(new Uint8Array(JOYID_WITNESS_PLACEHOLDER_BYTES)));

  const { selected, totalIn } = selectInputs(input.availableCells, totalOut);
  for (const c of selected) {
    tx.inputs.push(CellInput.from({ previousOutput: c.outPoint, since: 0n }));
  }
  while (tx.witnesses.length < tx.inputs.length) tx.witnesses.push(hexFrom("0x"));

  const minChange = minCapacityForLock(input.sourceLock);
  tx.outputs.push(CellOutput.from({ capacity: 0n, lock: input.sourceLock }));
  tx.outputsData.push(hexFrom("0x"));

  const feeWithChange = serialisedSize(tx) * input.feeRateShannonsPerByte;
  const remainder = totalIn - totalOut - feeWithChange;
  if (remainder < 0n) {
    throw new Error(`insufficient capacity: have ${totalIn}, need ${totalOut + feeWithChange}`);
  }
  if (remainder >= minChange) {
    tx.outputs[tx.outputs.length - 1].capacity = remainder;
    return { tx, totalIn, totalOut: totalOut + remainder, change: remainder, fee: feeWithChange };
  }

  // Change can't survive — drop it, donate remainder to fee.
  tx.outputs.pop();
  tx.outputsData.pop();
  const fee = totalIn - totalOut;
  const minFee = serialisedSize(tx) * input.feeRateShannonsPerByte;
  if (fee < minFee) {
    throw new Error(`insufficient capacity after dropping change: fee ${fee} < required ${minFee}`);
  }
  return { tx, totalIn, totalOut, change: 0n, fee };
}

function validate(input: SingleSigSendInput): void {
  if (input.recipients.length === 0) throw new Error("at least one recipient is required");
  for (const [i, r] of input.recipients.entries()) {
    const min = minCapacityForLock(r.lock);
    if (r.capacity < min) {
      throw new Error(`recipient[${i}] capacity ${r.capacity} is below min capacity ${min}`);
    }
  }
  if (input.feeRateShannonsPerByte <= 0n) throw new Error("feeRateShannonsPerByte must be > 0");
}

function selectInputs(cells: Cell[], needed: bigint): { selected: Cell[]; totalIn: bigint } {
  const sorted = [...cells].sort((a, b) => {
    const d = b.cellOutput.capacity - a.cellOutput.capacity;
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });
  const selected: Cell[] = [];
  let totalIn = 0n;
  for (const c of sorted) {
    selected.push(c);
    totalIn += c.cellOutput.capacity;
    if (totalIn >= needed) break;
  }
  if (totalIn < needed) {
    throw new Error(`insufficient capacity: have ${totalIn}, need at least ${needed} (before fee)`);
  }
  return { selected, totalIn };
}

function serialisedSize(tx: Transaction): bigint {
  return BigInt(tx.toBytes().length) + TX_SIZE_OVERHEAD_BYTES;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/lib/chains/ckb/single-sig-tx-builder.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/chains/ckb/single-sig-tx-builder.ts apps/desktop/src/lib/chains/ckb/single-sig-tx-builder.test.ts
git commit -m "feat(send): pure single-sig JoyID tx builder (light-client cells, witness pad)"
```

---

## Task 7: `CkbTxSigner` interface + mock + JoyID implementation

**Files:**
- Create: `apps/desktop/src/lib/signers/ckb-tx-signer.ts`
- Create: `apps/desktop/src/lib/signers/mock-ckb-tx-signer.ts`
- Create: `apps/desktop/src/lib/signers/joyid-ckb-tx-signer.ts`
- Modify: `apps/desktop/package.json` (add `@joyid/ckb`)
- Test: `apps/desktop/src/lib/signers/mock-ckb-tx-signer.test.ts`

**Interfaces:**
- Consumes: `Transaction`, `hexFrom` from `@ckb-ccc/core`.
- Produces:
  - `interface CkbTxSigner { readonly kind: "joyid"; connect(): Promise<{ address: string; lockArgs: string }>; signTransaction(unsigned: Transaction): Promise<Transaction> }`
  - `class MockCkbTxSigner implements CkbTxSigner` — deterministic; `signTransaction` returns the tx with witness[0] replaced by a fixed non-zero marker.
  - `class JoyIdCkbTxSigner implements CkbTxSigner` — real `@joyid/ckb` integration.

> **This is the primary integration-risk task.** The mock + interface are fully unit-tested. The real `JoyIdCkbTxSigner` is verified by manual JoyID smoke (a passkey popup can't run headless), exactly as keystore signing is tested today. Before writing `JoyIdCkbTxSigner`, confirm the current `@joyid/ckb` API via Context7 (`initConfig`, `connect`, `signRawTransaction`) — the snippet below reflects the documented API and may need a version tweak. If the Electron popup/redirect cannot be made to work, fall back to vendoring the `joyid-ckb-connector` redirect-relay (design §3 option C); the interface and all consumers are unchanged.

- [ ] **Step 1: Write the failing mock test**

```typescript
// apps/desktop/src/lib/signers/mock-ckb-tx-signer.test.ts
import { describe, it, expect } from "vitest";
import { Transaction, CellOutput, Script, hexFrom } from "@ckb-ccc/core";
import { MockCkbTxSigner } from "./mock-ckb-tx-signer";

function unsignedTx(): Transaction {
  const tx = Transaction.from({
    version: 0n, cellDeps: [], headerDeps: [], inputs: [], outputs: [], outputsData: [], witnesses: [],
  });
  tx.outputs.push(CellOutput.from({
    capacity: 100n * 100_000_000n,
    lock: Script.from({ codeHash: "0x" + "00".repeat(32), hashType: "type", args: "0x" }),
  }));
  tx.outputsData.push(hexFrom("0x"));
  tx.setWitnessAt(0, hexFrom(new Uint8Array(1000)));
  return tx;
}

describe("MockCkbTxSigner", () => {
  it("connects to a deterministic address", async () => {
    const signer = new MockCkbTxSigner();
    const { address, lockArgs } = await signer.connect();
    expect(address).toMatch(/^ck/);
    expect(lockArgs).toMatch(/^0x/);
  });

  it("replaces the empty witness[0] placeholder with a non-zero signed marker", async () => {
    const signer = new MockCkbTxSigner();
    const signed = await signer.signTransaction(unsignedTx());
    expect(signed.witnesses[0]).not.toBe(hexFrom(new Uint8Array(1000)));
    expect(signed.witnesses[0].length).toBeGreaterThan(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/signers/mock-ckb-tx-signer.test.ts`
Expected: FAIL — cannot find `./mock-ckb-tx-signer`.

- [ ] **Step 3: Write the interface + mock**

```typescript
// apps/desktop/src/lib/signers/ckb-tx-signer.ts
import type { Transaction } from "@ckb-ccc/core";

/**
 * Whole-transaction signer for single-sig CKB sends. Distinct from
 * SignerTransport (digest→65 bytes), which serves the multisig partial-sig flow.
 * JoyID signs the entire tx and returns a broadcast-ready Transaction.
 */
export interface CkbTxSigner {
  readonly kind: "joyid";
  connect(): Promise<{ address: string; lockArgs: string }>;
  signTransaction(unsigned: Transaction): Promise<Transaction>;
}
```

```typescript
// apps/desktop/src/lib/signers/mock-ckb-tx-signer.ts
import { Transaction, hexFrom } from "@ckb-ccc/core";
import type { CkbTxSigner } from "./ckb-tx-signer";

/** Deterministic test signer — no popup, no key. */
export class MockCkbTxSigner implements CkbTxSigner {
  readonly kind = "joyid" as const;

  async connect(): Promise<{ address: string; lockArgs: string }> {
    return { address: "ckt1qmocksource", lockArgs: "0x" + "11".repeat(20) };
  }

  async signTransaction(unsigned: Transaction): Promise<Transaction> {
    const signed = Transaction.from(unsigned);
    // Stand-in for JoyID's filled lock: a fixed non-zero 1000-byte witness.
    signed.setWitnessAt(0, hexFrom(new Uint8Array(1000).fill(7)));
    return signed;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/lib/signers/mock-ckb-tx-signer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add `@joyid/ckb` and write the real signer (verified by smoke)**

Run: `cd apps/desktop && npm install @joyid/ckb`

```typescript
// apps/desktop/src/lib/signers/joyid-ckb-tx-signer.ts
import { Transaction } from "@ckb-ccc/core";
import { initConfig, connect, signRawTransaction } from "@joyid/ckb";
import type { CkbTxSigner } from "./ckb-tx-signer";

/**
 * Real JoyID signer. initConfig sets the app name + redirect URL (must be
 * whitelisted in the JoyID app config and reachable from the Electron renderer).
 * INTEGRATION RISK: JoyID's popup/redirect inside Electron — see plan Task 7
 * note and design §3. Verify the @joyid/ckb API via Context7 before relying on
 * these signatures.
 */
export class JoyIdCkbTxSigner implements CkbTxSigner {
  readonly kind = "joyid" as const;
  private address = "";

  constructor(opts: { name: string; logo: string; joyidAppURL: string }) {
    initConfig({ name: opts.name, logo: opts.logo, joyidAppURL: opts.joyidAppURL });
  }

  async connect(): Promise<{ address: string; lockArgs: string }> {
    const res = await connect();
    this.address = res.address;
    // JoyID returns the address; lock args are derived from it by the orchestrator
    // via Address.fromString. Surface both for the Source record.
    return { address: res.address, lockArgs: res.pubkey ?? "0x" };
  }

  async signTransaction(unsigned: Transaction): Promise<Transaction> {
    // signRawTransaction accepts a CKB raw tx + signer address and returns a
    // signed tx; normalise back into a CCC Transaction.
    const signed = await signRawTransaction(unsigned as unknown as never, this.address);
    return Transaction.from(signed as unknown as never);
  }
}
```

- [ ] **Step 6: Verify typecheck (no new test — real signer is manual-smoke)**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: PASS (no type errors). If `@joyid/ckb` types differ, adjust the `signRawTransaction`/`connect` calls per its `.d.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/lib/signers/ckb-tx-signer.ts apps/desktop/src/lib/signers/mock-ckb-tx-signer.ts apps/desktop/src/lib/signers/mock-ckb-tx-signer.test.ts apps/desktop/src/lib/signers/joyid-ckb-tx-signer.ts apps/desktop/package.json apps/desktop/package-lock.json
git commit -m "feat(send): CkbTxSigner interface + mock + JoyID whole-tx signer"
```

---

## Task 8: Send accounting bridge

**Files:**
- Create: `apps/desktop/src/lib/send/send-journal.ts`
- Create: `apps/desktop/src/lib/send/use-send-confirmation-to-accounting.ts`
- Test: `apps/desktop/src/lib/send/send-journal.test.ts`

**Interfaces:**
- Consumes: `buildBatchJournal`, `PaymentJournalInput`, `AccountingJournalPreview`, `SendRecord` from `@chain-pay/shared`; `DEFAULT_ACCOUNT_MAP`, `AccountMap` from `@/lib/accounting/account-map`; `postJournal` from `@/lib/accounting/ipc`; `useSendsStore` from `@/stores/sends`.
- Produces:
  - `interface SendAccountMap { expense: string; treasury: string; networkFeeExpense: string; fxGainLoss: string }`
  - `const DEFAULT_SEND_ACCOUNT_MAP: SendAccountMap` (defaults to the four seeded ERPNext accounts; `expense` defaults to the seeded salary account — see note).
  - `function buildSendJournal(send: SendRecord, map: SendAccountMap): AccountingJournalPreview`
  - `async function postSendJournal(sendId: string): Promise<void>`
  - `function useSendConfirmationToAccounting(): void`

> **Accounting decisions baked into this task (flag for confirmation):** (1) each `SendOutput.fiat` is the user-entered obligation; zero-FX ⇒ `carryingCost == obligation`, `feeFiat == 0`. (2) The debit account defaults to the only seeded expense account (`"Salary or Wage Expense"`) because adding a vendor/AP account is a backend change (out of slice-1 scope). Making `expense` configurable per send/settings is a Slice E/F follow-up.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/lib/send/send-journal.test.ts
import { describe, it, expect } from "vitest";
import type { SendRecord } from "@chain-pay/shared";
import { buildSendJournal, DEFAULT_SEND_ACCOUNT_MAP } from "./send-journal";

function confirmedSend(): SendRecord {
  return {
    id: "snd1",
    sourceId: "src1",
    chain: "ckb:testnet",
    outputs: [
      {
        payeeId: "vendor-1",
        payeeAddress: "ckt1qpayee",
        amount: { asset: "CKB", value: 7_000_000_000n, decimals: 8 },
        fiat: { currency: "AUD", minor: 10000n },
      },
    ],
    feeShannons: 120000n,
    state: "confirmed",
    txHash: "0xabc123def4567890",
    createdAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z",
  };
}

describe("buildSendJournal", () => {
  it("produces a balanced zero-FX journal (debit expense, credit treasury)", () => {
    const preview = buildSendJournal(confirmedSend(), DEFAULT_SEND_ACCOUNT_MAP);
    expect(preview.batchId).toBe("snd1");
    const debit = preview.entries.find((e) => e.debit && e.account === DEFAULT_SEND_ACCOUNT_MAP.expense);
    const credit = preview.entries.find((e) => e.credit && e.account === DEFAULT_SEND_ACCOUNT_MAP.treasury);
    expect(debit?.debit?.minor).toBe(10000n);
    expect(credit?.credit?.minor).toBe(10000n);
    // zero-FX: no FX gain/loss line
    expect(preview.entries.some((e) => e.account === DEFAULT_SEND_ACCOUNT_MAP.fxGainLoss)).toBe(false);
  });

  it("throws when the send has no txHash", () => {
    const s = confirmedSend();
    delete s.txHash;
    expect(() => buildSendJournal(s, DEFAULT_SEND_ACCOUNT_MAP)).toThrow(/no txHash/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/send/send-journal.test.ts`
Expected: FAIL — cannot find `./send-journal`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/desktop/src/lib/send/send-journal.ts
import {
  buildBatchJournal,
  type AccountingJournalPreview,
  type PaymentJournalInput,
  type SendRecord,
  type TransactionHash,
} from "@chain-pay/shared";
import { useSendsStore } from "@/stores/sends";
import { postJournal } from "@/lib/accounting/ipc";

export interface SendAccountMap {
  expense: string;
  treasury: string;
  networkFeeExpense: string;
  fxGainLoss: string;
}

/**
 * Defaults to the four seeded ERPNext accounts. `expense` is the seeded salary
 * account because that's the only expense account the seed creates; proper
 * vendor/AP accounts are a backend (Slice E/F) follow-up.
 */
export const DEFAULT_SEND_ACCOUNT_MAP: SendAccountMap = {
  expense: "Salary or Wage Expense",
  treasury: "Crypto Treasury Asset",
  networkFeeExpense: "Network Fee Expense",
  fxGainLoss: "FX Gain/Loss",
};

export function buildSendJournal(send: SendRecord, map: SendAccountMap): AccountingJournalPreview {
  if (!send.txHash) throw new Error(`send ${send.id} has no txHash; cannot build journal`);
  const txHash = send.txHash as TransactionHash;
  const payments: PaymentJournalInput[] = send.outputs.map((o) => ({
    payeeId: o.payeeId,
    obligation: { ...o.fiat },
    feeFiat: { currency: o.fiat.currency, minor: 0n },
    carryingCost: { ...o.fiat }, // zero-FX
    crypto: { ...o.amount },
    chain: send.chain,
    txHash,
    salaryAccount: map.expense,
    treasuryAccount: map.treasury,
  }));
  return buildBatchJournal(send.id, payments, {
    networkFeeExpense: map.networkFeeExpense,
    fxGainLoss: map.fxGainLoss,
  });
}

/**
 * Post a confirmed send's JE. Mirrors postBatchJournal: confirmed|post_failed →
 * posting → posted|post_failed. Never throws — failures land as post_failed.
 */
export async function postSendJournal(sendId: string): Promise<void> {
  const store = useSendsStore.getState();
  const send = store.sends.find((s) => s.id === sendId);
  if (!send) return;
  if (send.state !== "confirmed" && send.state !== "post_failed") return; // double-fire guard

  store.markPosting(sendId);
  try {
    const preview = buildSendJournal(send, DEFAULT_SEND_ACCOUNT_MAP);
    const { jeName } = await postJournal(sendId, preview);
    useSendsStore.getState().markPosted(sendId, jeName);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown posting error";
    useSendsStore.getState().markPostFailed(sendId, message);
  }
}
```

```typescript
// apps/desktop/src/lib/send/use-send-confirmation-to-accounting.ts
import { useEffect } from "react";
import { useSendsStore } from "@/stores/sends";
import { postSendJournal } from "./send-journal";

/** Side-effect: post a JE for every send in `confirmed` state. Idempotent via the posting guard. */
export function syncConfirmedSendsToAccounting(): void {
  for (const s of useSendsStore.getState().sends) {
    if (s.state !== "confirmed") continue;
    void postSendJournal(s.id);
  }
}

export function useSendConfirmationToAccounting(): void {
  useEffect(() => {
    syncConfirmedSendsToAccounting();
    const unsub = useSendsStore.subscribe(() => syncConfirmedSendsToAccounting());
    return unsub;
  }, []);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/lib/send/send-journal.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/send/send-journal.ts apps/desktop/src/lib/send/use-send-confirmation-to-accounting.ts apps/desktop/src/lib/send/send-journal.test.ts
git commit -m "feat(send): confirmed-send → balanced JE via Phase-5 accounting bridge"
```

---

## Task 9: Build-and-send orchestrator

**Files:**
- Create: `apps/desktop/src/lib/send/build-and-send.ts`
- Test: `apps/desktop/src/lib/send/build-and-send.test.ts`

**Interfaces:**
- Consumes: `buildSingleSigSend`, `SingleSigRecipient` from `@/lib/chains/ckb/single-sig-tx-builder`; `joyidLockAndDeps`, `resolveJoyIdScriptInfo` from `@/lib/chains/ckb/joyid-lock`; `CkbTxSigner` from `@/lib/signers/ckb-tx-signer`; `Source`, `SendRecord` from `@chain-pay/shared`; `Address`, `Script`, `Cell` from `@ckb-ccc/core`.
- Produces:
  - `interface SendDeps { listCellsForLock(lock: Script): Promise<Cell[]>; broadcast(tx): Promise<string>; resolveRecipientLock(address: string): Promise<Script>; scriptInfo: ScriptInfo; markSigning(id): void; markBroadcasted(id, hash): void; markBackToBuilt(id): void }`
  - `async function buildAndSend(send: SendRecord, source: Source, signer: CkbTxSigner, feeRate: bigint, deps: SendDeps): Promise<{ txHash: string }>`

The orchestrator: resolves the source JoyID lock + deps from `deps.scriptInfo` + `source.joyidLockArgs`; lists cells; resolves each recipient lock; calls `buildSingleSigSend`; `markSigning`; `signer.signTransaction`; `broadcast`; `markBroadcasted`. On signing/broadcast error it calls `markBackToBuilt` and rethrows. Pure dependency-injected so it's unit-testable with a mock signer + fakes (no Electron, no popup).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/lib/send/build-and-send.test.ts
import { describe, it, expect, vi } from "vitest";
import { Cell, CellDep, Script, ScriptInfo, hexFrom } from "@ckb-ccc/core";
import type { SendRecord, Source } from "@chain-pay/shared";
import { MockCkbTxSigner } from "@/lib/signers/mock-ckb-tx-signer";
import { buildAndSend, type SendDeps } from "./build-and-send";

const JOYID = "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac";
const SECP = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

function scriptInfo(): ScriptInfo {
  return ScriptInfo.from({
    codeHash: JOYID, hashType: "type",
    cellDeps: [{ cellDep: { outPoint: { txHash: "0x" + "cd".repeat(32), index: 0 }, depType: "depGroup" } }],
  });
}
function source(): Source {
  return {
    id: "src1", label: "Ops", chain: "ckb:testnet",
    address: "ckt1qsource", joyidLockArgs: "0x" + "11".repeat(20),
    createdAt: "2026-06-25T00:00:00Z", updatedAt: "2026-06-25T00:00:00Z",
  };
}
function send(): SendRecord {
  return {
    id: "snd1", sourceId: "src1", chain: "ckb:testnet",
    outputs: [{ payeeId: "p1", payeeAddress: "ckt1qpayee", amount: { asset: "CKB", value: 100n * 100_000_000n, decimals: 8 }, fiat: { currency: "AUD", minor: 10000n } }],
    feeShannons: 0n, state: "built",
    createdAt: "2026-06-25T00:00:00Z", updatedAt: "2026-06-25T00:00:00Z",
  };
}
function cell(): Cell {
  return Cell.from({
    outPoint: { txHash: "0x" + "ab".repeat(32), index: 0 },
    cellOutput: { capacity: 200n * 100_000_000n, lock: Script.from({ codeHash: JOYID, hashType: "type", args: "0x" + "11".repeat(20) }) },
    outputData: hexFrom("0x"),
  });
}

function deps(over: Partial<SendDeps> = {}): SendDeps {
  return {
    listCellsForLock: vi.fn(async () => [cell()]),
    broadcast: vi.fn(async () => "0xbroadcasthash"),
    resolveRecipientLock: vi.fn(async () => Script.from({ codeHash: SECP, hashType: "type", args: "0x" + "22".repeat(20) })),
    scriptInfo: scriptInfo(),
    markSigning: vi.fn(),
    markBroadcasted: vi.fn(),
    markBackToBuilt: vi.fn(),
    ...over,
  };
}

describe("buildAndSend", () => {
  it("builds, signs, broadcasts and records the tx hash", async () => {
    const d = deps();
    const res = await buildAndSend(send(), source(), new MockCkbTxSigner(), 1200n, d);
    expect(res.txHash).toBe("0xbroadcasthash");
    expect(d.markSigning).toHaveBeenCalledWith("snd1");
    expect(d.markBroadcasted).toHaveBeenCalledWith("snd1", "0xbroadcasthash");
  });

  it("returns the send to built and rethrows on broadcast failure", async () => {
    const d = deps({ broadcast: vi.fn(async () => { throw new Error("pool rejected"); }) });
    await expect(buildAndSend(send(), source(), new MockCkbTxSigner(), 1200n, d)).rejects.toThrow(/pool rejected/);
    expect(d.markBackToBuilt).toHaveBeenCalledWith("snd1");
    expect(d.markBroadcasted).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/lib/send/build-and-send.test.ts`
Expected: FAIL — cannot find `./build-and-send`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/desktop/src/lib/send/build-and-send.ts
import type { Cell, Script, ScriptInfo } from "@ckb-ccc/core";
import type { SendRecord, Source } from "@chain-pay/shared";
import type { CkbTxSigner } from "@/lib/signers/ckb-tx-signer";
import { buildSingleSigSend, type SingleSigRecipient } from "@/lib/chains/ckb/single-sig-tx-builder";
import { joyidLockAndDeps } from "@/lib/chains/ckb/joyid-lock";

export interface SendDeps {
  listCellsForLock(lock: Script): Promise<Cell[]>;
  broadcast(tx: import("@ckb-ccc/core").Transaction): Promise<string>;
  resolveRecipientLock(address: string): Promise<Script>;
  scriptInfo: ScriptInfo;
  markSigning(id: string): void;
  markBroadcasted(id: string, hash: string): void;
  markBackToBuilt(id: string): void;
}

export async function buildAndSend(
  send: SendRecord,
  source: Source,
  signer: CkbTxSigner,
  feeRateShannonsPerByte: bigint,
  deps: SendDeps,
): Promise<{ txHash: string }> {
  const { lock: sourceLock, cellDeps } = joyidLockAndDeps(deps.scriptInfo, source.joyidLockArgs);
  const availableCells = await deps.listCellsForLock(sourceLock);

  const recipients: SingleSigRecipient[] = [];
  for (const o of send.outputs) {
    const lock = await deps.resolveRecipientLock(o.payeeAddress);
    recipients.push({ lock, capacity: o.amount.value });
  }

  const { tx } = buildSingleSigSend({
    sourceLock,
    joyidCellDeps: cellDeps,
    recipients,
    availableCells,
    feeRateShannonsPerByte,
  });

  deps.markSigning(send.id);
  try {
    const signed = await signer.signTransaction(tx);
    const txHash = await deps.broadcast(signed);
    deps.markBroadcasted(send.id, txHash);
    return { txHash };
  } catch (err) {
    deps.markBackToBuilt(send.id);
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/lib/send/build-and-send.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/send/build-and-send.ts apps/desktop/src/lib/send/build-and-send.test.ts
git commit -m "feat(send): build-and-send orchestrator (build→sign→broadcast→state)"
```

---

## Task 10: Send UI + wiring

**Files:**
- Create: `apps/desktop/src/features/send/SourceList.tsx`
- Create: `apps/desktop/src/features/send/SendPanel.tsx`
- Create: `apps/desktop/src/features/send/SendHistory.tsx`
- Modify: `apps/desktop/src/App.tsx` (route `/send` + mount reactor)
- Modify: `apps/desktop/src/components/layout/Sidebar.tsx` (nav entry)
- Test: `apps/desktop/src/features/send/SourceList.test.tsx`

**Interfaces:**
- Consumes: `useSourcesStore` (`@/stores/sources`), `useSendsStore` (`@/stores/sends`), `useSendConfirmationToAccounting` (`@/lib/send/use-send-confirmation-to-accounting`), `JoyIdCkbTxSigner` / `MockCkbTxSigner`, `buildAndSend`, `resolveJoyIdScriptInfo`, `lightClient()` host, `Address` from `@ckb-ccc/core`.
- Produces: three route components and the nav/route/reactor wiring.

> Keep each component <800 lines and focused. `SourceList` manages connect/add/remove of JoyID wallets (on connect, derive `joyidLockArgs` via `Address.fromString(address, client).script.args`, persist a `Source`, and call `lightClient().watchLockScript(lock)`). `SendPanel` builds a draft `SendRecord` (payee address + CKB amount + fiat valuation + currency per line), reviews fee + min-capacity, then runs `buildAndSend`. `SendHistory` lists `SendRecord`s with state, txHash, and a Retry button for `post_failed` (calls `postSendJournal`). The single unit test covers `SourceList` rendering + add; the panels/broadcast are covered by the lib tests above + manual smoke (JoyID popup can't run headless).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/features/send/SourceList.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SourceList } from "./SourceList";
import { useSourcesStore } from "@/stores/sources";

beforeEach(() => {
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(), key: () => null, length: 0,
  } as Storage;
  useSourcesStore.setState({ sources: [], activeSourceId: null });
});

describe("SourceList", () => {
  it("renders an empty state when there are no sources", () => {
    render(<MemoryRouter><SourceList /></MemoryRouter>);
    expect(screen.getByText(/no source wallets/i)).toBeInTheDocument();
  });

  it("renders a persisted source's label", () => {
    useSourcesStore.getState().addSource({
      id: "a", label: "Ops wallet", chain: "ckb:testnet",
      address: "ckt1qsource", joyidLockArgs: "0x" + "11".repeat(20),
      createdAt: "2026-06-25T00:00:00Z", updatedAt: "2026-06-25T00:00:00Z",
    });
    render(<MemoryRouter><SourceList /></MemoryRouter>);
    expect(screen.getByText("Ops wallet")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/features/send/SourceList.test.tsx`
Expected: FAIL — cannot find `./SourceList`.

- [ ] **Step 3: Write `SourceList` (minimal, to pass the test)**

```tsx
// apps/desktop/src/features/send/SourceList.tsx
import { useSourcesStore } from "@/stores/sources";

export function SourceList() {
  const sources = useSourcesStore((s) => s.sources);

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Source wallets</h1>
        {/* Connect button wired in Step 5 */}
      </header>
      {sources.length === 0 ? (
        <p className="text-sm text-muted">No source wallets yet. Connect a JoyID wallet to send.</p>
      ) : (
        <ul className="divide-y divide-border rounded border border-border">
          {sources.map((s) => (
            <li key={s.id} className="flex items-center justify-between px-4 py-3">
              <span className="font-medium">{s.label}</span>
              <span className="text-xs text-muted">{s.address.slice(0, 12)}…</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/features/send/SourceList.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Build `SendPanel`, `SendHistory`, the connect flow, and wiring**

Implement (no new unit test — covered by lib tests + manual smoke):

`SourceList` connect handler:
```tsx
// inside SourceList, add a "Connect JoyID wallet" button calling:
async function handleConnect() {
  const { JoyIdCkbTxSigner } = await import("@/lib/signers/joyid-ckb-tx-signer");
  const { Address, ClientPublicTestnet } = await import("@ckb-ccc/core");
  const signer = new JoyIdCkbTxSigner({
    name: "ChainPay", logo: "https://chainpay.local/logo.png", joyidAppURL: "https://app.joy.id",
  });
  const { address } = await signer.connect();
  const client = new ClientPublicTestnet();
  const parsed = await Address.fromString(address, client);
  useSourcesStore.getState().addSource({
    id: crypto.randomUUID(),
    label: address.slice(0, 10),
    chain: "ckb:testnet",
    address,
    joyidLockArgs: parsed.script.args,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const { lightClient } = await import("@/lib/light-client/client");
  await lightClient().watchLockScript(parsed.script);
}
```

`SendPanel.tsx` — a form with: source selector (from `useSourcesStore`), repeatable payee rows (address, CKB amount, fiat amount, currency), a Review section showing fee + per-line min-capacity validation, and a Send button that:
```tsx
async function handleSend(draft: SendRecord, source: Source) {
  const { useSendsStore } = await import("@/stores/sends");
  useSendsStore.getState().addSend(draft);
  useSendsStore.getState().markBuilt(draft.id, 0n);
  const { resolveJoyIdScriptInfo } = await import("@/lib/chains/ckb/joyid-lock");
  const { JoyIdCkbTxSigner } = await import("@/lib/signers/joyid-ckb-tx-signer");
  const { buildAndSend } = await import("@/lib/send/build-and-send");
  const { lightClient } = await import("@/lib/light-client/client");
  const { Address, ClientPublicTestnet } = await import("@ckb-ccc/core");
  const host = lightClient();
  const client = new ClientPublicTestnet();
  await buildAndSend(draft, source, new JoyIdCkbTxSigner({ name: "ChainPay", logo: "", joyidAppURL: "https://app.joy.id" }), 1200n, {
    listCellsForLock: (lock) => host.listCellsForLock(lock),
    broadcast: (tx) => host.broadcastTransaction(tx),
    resolveRecipientLock: async (addr) => (await Address.fromString(addr, client)).script,
    scriptInfo: await resolveJoyIdScriptInfo("testnet"),
    markSigning: (id) => useSendsStore.getState().markSigning(id),
    markBroadcasted: (id, hash) => useSendsStore.getState().markBroadcasted(id, hash as `0x${string}`),
    markBackToBuilt: (id) => useSendsStore.getState().markBackToBuilt(id),
  });
}
```

`SendHistory.tsx` — list `useSendsStore((s) => s.sends)` showing `state`, `txHash`, and for `post_failed` a Retry button calling `postSendJournal(id)`.

In `App.tsx`:
```tsx
import { SourceList } from "./features/send/SourceList";
import { SendPanel } from "./features/send/SendPanel";
import { useSendConfirmationToAccounting } from "./lib/send/use-send-confirmation-to-accounting";
// near useBatchConfirmationToAccounting():
useSendConfirmationToAccounting();
// in <Routes>:
<Route path="/send" element={<SendPanel />} />
<Route path="/send/sources" element={<SourceList />} />
```

In `components/layout/Sidebar.tsx`, add to `items` (import `Wallet` from `lucide-react`):
```tsx
{ to: "/send", icon: Wallet, label: "Send" },
```

- [ ] **Step 6: Run the whole desktop suite + typecheck**

Run: `cd apps/desktop && npx vitest run && npx tsc --noEmit`
Expected: all tests PASS (existing 607 + the new send tests); no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/features/send apps/desktop/src/App.tsx apps/desktop/src/components/layout/Sidebar.tsx
git commit -m "feat(send): Send UI (sources, send panel, history) + nav + reactor wiring"
```

---

## Manual smoke (post-implementation, not a task)

Real JoyID signing can't run headless. After Task 10, run a manual testnet smoke:
1. Connect a JoyID wallet; confirm a `Source` persists and its lock is watched (balance appears).
2. Send ≥70 CKB to a testnet payee with a fiat valuation; approve in the JoyID popup.
3. Confirm broadcast (tx hash) and on-chain confirmation; verify change returns to the source.
4. With the Frappe stack up, confirm a balanced JE is posted with `crypto_batch_id == send.id`; re-fire → no duplicate; backend down → `post_failed` → Retry.

Document results in `docs/phase-...-send-smoke-playbook.md` (mirror the Slice C playbook).

---

## Self-Review

**Spec coverage:**
- §Data model (FundableAccount, Source, sources store) → Tasks 1, 2. ✓
- §Signing (CkbTxSigner, JoyID transport, mock) → Task 7. ✓
- §Tx building (light-client-first, witness pad, min-capacity, JoyID cellDep) → Tasks 5, 6, 9. ✓
- §Send record + state machine → Tasks 3, 4. ✓
- §Accounting (in scope, zero-FX, Phase-5 bridge, Retry) → Task 8 (+ Retry in Task 10). ✓
- §UI (SourceList, SendPanel, SendHistory) + nav/route/reactor → Task 10. ✓
- §Testing (TDD, mocked signing) → every task. ✓
- §Security review triggers → flagged for the requesting-code-review gate before PR.

**Type consistency:** `Source`/`SendRecord`/`SendOutput`/`SendState` defined in Tasks 1/3 and consumed consistently in Tasks 2/4/8/9/10. `buildSingleSigSend`/`SingleSigRecipient` (Task 6) consumed in Task 9. `CkbTxSigner` (Task 7) consumed in Task 9/10. `joyidLockAndDeps`/`resolveJoyIdScriptInfo` (Task 5) consumed in Task 9/10. `buildSendJournal`/`postSendJournal` (Task 8) consumed in Task 10. Light-client host methods (`listCellsForLock`, `broadcastTransaction`, `watchLockScript`) match `lib/light-client/host.ts`. ✓

**Known non-blocking flags (surface to user):**
- Per-line user-entered fiat valuation + `expense` account defaulting to the seeded salary account (Task 8) — a slice-1 simplification; proper FX (Slice D) and vendor/AP accounts (Slice E/F) follow.
- `@joyid/ckb` exact API + Electron popup behavior is the one unverified external integration (Task 7) — mocked in tests, confirmed by manual smoke, with the redirect-relay fallback.
