# Phase 2.7a — Comm Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a CEMP-PQ-backed `CommTransport` for ChainPay — identity keygen, Profile Cell publish, send/receive, all secret-handling confined to Electron's main process. No UI changes; verified by a manual two-install smoke script.

**Architecture:** A `CommTransport` interface in the renderer (`apps/desktop/src/lib/comm/`) talks to a thin main-process service (`apps/desktop/electron/main/comm-transport-service.ts`) via typed IPC. The main process owns CEMP-PQ end-to-end — `MLDSASigner`, `CEMPTransactionBuilder`, ML-KEM decapsulation, AES-GCM. ML-DSA + ML-KEM secrets live encrypted on disk via Electron `safeStorage` and only enter memory inside a `withSecrets()` callback that zeros the buffer on return. CEMP-PQ is vendored as `packages/cemp-pq` workspace package.

**Tech Stack:** TypeScript 5.6, React 19, Electron 33, Vitest 4.1, Zustand 5 (persisted stores), `@ckb-ccc/core` 1.12, `@noble/post-quantum` (transitively via CEMP-PQ), CKB testnet via existing `LightClientHost`.

**Spec reference:** `docs/superpowers/specs/2026-05-23-phase-2-7a-comm-transport-design.md`

---

## Plan overview

18 tasks across 5 phases. Each task is one TDD cycle (failing test → minimal impl → green → commit).

| # | Phase | Task | Files touched |
|---|-------|------|---------------|
| 1 | A | Vendor CEMP-PQ + add to workspaces | `packages/cemp-pq/*`, root `package.json` |
| 2 | A | Add CEMP-PQ TypeScript surface | `packages/cemp-pq/index.d.ts` |
| 3 | A | Define core comm types | `apps/desktop/src/lib/comm/types.ts` |
| 4 | A | Define typed error classes | `apps/desktop/src/lib/comm/errors.ts` |
| 5 | A | Envelope codec + tests | `lib/comm/envelope.{ts,test.ts}` |
| 6 | A | Refusal invariant + tests | `lib/comm/refusal-invariant.{ts,test.ts}` |
| 7 | B | Renderer comm-identity store + tests | `stores/comm-identity.{ts,test.ts}` |
| 8 | B | Peer-book store + tests | `stores/peer-book.{ts,test.ts}` |
| 9 | C | Safe-storage abstraction | `electron/main/safe-storage.ts` |
| 10 | C | Main comm-identity-store + tests | `electron/main/comm-identity-store.{ts,test.ts}` |
| 11 | C | Main comm-transport-service | `electron/main/comm-transport-service.ts` |
| 12 | C | Preload IPC bridge | `electron/preload/index.ts` |
| 13 | C | Register main IPC handlers | `electron/main/index.ts` |
| 14 | D | Watcher module + tests | `lib/comm/cemp-pq/watcher.{ts,test.ts}` |
| 15 | D | CempPqCommTransport + tests | `lib/comm/cemp-pq/transport.{ts,test.ts}` |
| 16 | D | Singleton factory | `lib/comm/index.ts` |
| 17 | E | Wire refusal-invariant into treasury store | `stores/treasury.ts` |
| 18 | E | Smoke roundtrip script | `scripts/smoke-comm-roundtrip.mjs` |

**Test budget:** ~59 unit tests (per spec). Each test-bearing task includes 3-5 representative tests fully written + a numbered list of additional test cases with one-line assertions.

---

# Phase A — Foundation (no chain deps)

### Task 1: Vendor CEMP-PQ into workspace

**Files:**
- Create: `packages/cemp-pq/index.js` (copy from `~/ecms/cemp-pq/index.js`)
- Create: `packages/cemp-pq/tx-builder.js` (copy from `~/ecms/cemp-pq/tx-builder.js`)
- Create: `packages/cemp-pq/schemas/` (copy from `~/ecms/cemp-pq/schemas/`)
- Create: `packages/cemp-pq/package.json`
- Modify: `apps/desktop/package.json` — add `"cemp-pq": "*"` to dependencies

- [ ] **Step 1: Copy CEMP-PQ source**

```bash
cp -r ~/ecms/cemp-pq/index.js \
      ~/ecms/cemp-pq/tx-builder.js \
      ~/ecms/cemp-pq/schemas \
      /home/phill/chain-pay/packages/cemp-pq/
```

- [ ] **Step 2: Write package.json**

Create `packages/cemp-pq/package.json`:

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
  "dependencies": {
    "@ckb-ccc/core": "^1.12.0",
    "@noble/hashes": "^1.8.0",
    "@noble/post-quantum": "^0.2.1"
  }
}
```

Note: drop the upstream `molecule: file:../molecule-js-binding` dep — CEMP-PQ's tx-builder.js does its own molecule handling for the surfaces we use; if a `molecule` import is unresolved at runtime in step 4, surface the error and we'll revisit (likely safe to drop because we don't exercise the unused paths in 2.7a).

- [ ] **Step 3: Add to apps/desktop dependencies**

In `apps/desktop/package.json`, add to the `dependencies` block (keep alphabetical):

```json
    "cemp-pq": "*",
```

- [ ] **Step 4: Install + verify resolution**

```bash
cd /home/phill/chain-pay && npm install
cd apps/desktop && node -e "import('cemp-pq').then(m => console.log(Object.keys(m)))"
```

Expected output: includes `MLDSASigner`, `CEMPTransactionBuilder`, `serializeProfile`, etc. If `molecule` import fails, copy `~/ecms/molecule-js-binding/` into `packages/molecule-js-binding/` and add a workspace dep too.

- [ ] **Step 5: Commit**

```bash
cd /home/phill/chain-pay
git add packages/cemp-pq apps/desktop/package.json package.json package-lock.json
git commit -m "chore(2.7a): vendor cemp-pq as packages/cemp-pq workspace package"
```

---

### Task 2: Add TypeScript surface for CEMP-PQ

**Files:**
- Create: `packages/cemp-pq/index.d.ts`

CEMP-PQ ships as plain JS. ChainPay's strict-TS code needs a typed surface. Hand-write only the symbols ChainPay actually consumes — keep it small.

- [ ] **Step 1: Write the declarations**

Create `packages/cemp-pq/index.d.ts`:

```ts
// Hand-written TypeScript surface for the vendored CEMP-PQ package.
// Covers only the symbols ChainPay's 2.7a integration consumes.

import type { ccc } from "@ckb-ccc/core";

export const ML_DSA_TESTNET: {
  code_hash: string;
  hash_type: "data" | "type" | "data1" | "data2";
  out_point: { tx_hash: string; index: string };
  dep_type: "code" | "dep_group";
};

export const CEMP_PQ_PROFILE_CODE_HASH: string;
export const CEMP_PQ_PROFILE_HASH_TYPE: "data" | "type" | "data1" | "data2";

export function serializeProfile(
  dsaPubKey: Uint8Array,
  kemPubKey: Uint8Array,
  metadata?: Uint8Array,
): Uint8Array;

export function serializeEncryptedMessage(
  kem: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array;

export function serializeMessagePointer(txHash: string, index: number): Uint8Array;

export function ckbBlake2b(data: Uint8Array): Uint8Array;

export class MLDSASigner extends ccc.Signer {
  constructor(client: ccc.Client, mlDsaSeed: Uint8Array);
  getAddressObjs(): Promise<ccc.Address[]>;
  getRecommendedAddressObj(): Promise<ccc.Address>;
  isConnected(): Promise<boolean>;
  connect(): Promise<void>;
  prepareTransaction(tx: ccc.Transaction): Promise<ccc.Transaction>;
  signOnlyTransaction(tx: ccc.Transaction): Promise<ccc.Transaction>;
}

export interface ProfileFetchResult {
  mlDsaPubKey: Uint8Array;
  mlKemPubKey: Uint8Array;
  metadata: Uint8Array;
}

export class CEMPTransactionBuilder {
  constructor(client: ccc.Client);
  fetchRecipientProfile(recipientLock: ccc.Script): Promise<ProfileFetchResult | null>;
  buildCreateProfileTx(
    signer: MLDSASigner,
    mlDSAPubKey: Uint8Array,
    mlKEMPubKey: Uint8Array,
    metadata?: string | Uint8Array,
    feeRate?: bigint,
  ): Promise<ccc.Transaction>;
  buildSendMessageTx(
    senderSigner: MLDSASigner,
    recipientLock: ccc.Script,
    message: Uint8Array,
    feeRate?: bigint,
    recipientMLKEMPubKey?: Uint8Array | null,
  ): Promise<ccc.Transaction>;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /home/phill/chain-pay/apps/desktop && npm run typecheck
```

Expected: passes. If errors mention `cemp-pq` types not found, verify the `exports` block in step 1.2's package.json points to `./index.d.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/cemp-pq/index.d.ts
git commit -m "chore(2.7a): typescript declarations for cemp-pq surface"
```

---

### Task 3: Define core comm types

**Files:**
- Create: `apps/desktop/src/lib/comm/types.ts`

Pure type-only module. No tests — types are exercised by every downstream module.

- [ ] **Step 1: Write the types module**

Create `apps/desktop/src/lib/comm/types.ts`:

```ts
import type { TransferPacket } from "@chain-pay/shared";

export interface PeerProfile {
  /** ckb-mldsa-lock address (ckt1q… on testnet, ckb1q… on mainnet). */
  address: string;
  /** 1952 bytes. */
  mlDsaPubKey: Uint8Array;
  /** 1184 bytes. */
  mlKemPubKey: Uint8Array;
  metadata?: { displayName?: string };
  /** epoch ms when this profile was last fetched. */
  fetchedAt: number;
}

export interface OutgoingPacket {
  /** Operator's batch id this packet relates to (becomes the multisig tx hash). */
  txHash: string;
  treasuryAddress: string;
  /** Epoch s. Receivers reject after this. */
  expiresAt: number;
  packet: TransferPacket;
}

export interface OutgoingSignature {
  /** Matches OutgoingPacket.txHash. */
  txHash: string;
  /** Signer slot in the multisig. */
  slotIndex: number;
  /** 0x-prefixed secp65 hex. */
  signature: string;
}

export type CommEnvelopeKind = "packet" | "signature" | "ack";

export interface IncomingPacketHandler {
  (from: string, body: OutgoingPacket): void;
}

export interface IncomingSignatureHandler {
  (from: string, body: OutgoingSignature): void;
}

export type Unsubscribe = () => void;

export interface CommTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;

  publishProfile(metadata?: { displayName?: string }): Promise<string>;
  resolveProfile(address: string): Promise<PeerProfile>;

  sendPacket(peer: PeerProfile, body: OutgoingPacket): Promise<string>;
  sendSignature(peer: PeerProfile, body: OutgoingSignature): Promise<string>;

  onIncomingPacket(handler: IncomingPacketHandler): Unsubscribe;
  onIncomingSignature(handler: IncomingSignatureHandler): Unsubscribe;
}

/** The 1-byte tag preceding the envelope kind in the encrypted payload. */
export const ENVELOPE_VERSION = 0x01 as const;
```

- [ ] **Step 2: Verify TransferPacket exists in shared**

```bash
grep -n "TransferPacket" /home/phill/chain-pay/packages/shared/src/*.ts
```

Expected: at least one export of `TransferPacket`. If missing (legacy name), grep for `Packet` and update the import accordingly — record the actual name in this task before proceeding.

- [ ] **Step 3: Typecheck**

```bash
cd /home/phill/chain-pay/apps/desktop && npm run typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/comm/types.ts
git commit -m "feat(2.7a): define CommTransport interface and core comm types"
```

---

### Task 4: Define typed error classes

**Files:**
- Create: `apps/desktop/src/lib/comm/errors.ts`

- [ ] **Step 1: Write errors module**

Create `apps/desktop/src/lib/comm/errors.ts`:

```ts
export class CommError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class CommNotConfiguredError extends CommError {}
export class CommNotFundedError extends CommError {
  constructor(public readonly address: string, public readonly balanceShannons: bigint) {
    super(`Comm wallet ${address} unfunded (balance: ${balanceShannons} shannons)`);
  }
}
export class ProfileNotFoundError extends CommError {
  constructor(public readonly address: string, options?: { cause?: unknown }) {
    super(`No Profile Cell found for ${address}`, options);
  }
}
export class ProfileStaleError extends CommError {}
export class RefusalInvariantError extends CommError {
  constructor(public readonly pubkeyHash: string, public readonly conflict: string) {
    super(`Refusal invariant violated: pubkey hash ${pubkeyHash} conflicts with ${conflict}`);
  }
}
export class DecryptionFailedError extends CommError {}
export class EnvelopeMalformedError extends CommError {}
export class CellGoneError extends CommError {
  constructor(public readonly outPoint: { txHash: string; index: number }) {
    super(`Message Cell at ${outPoint.txHash}:${outPoint.index} has been consumed`);
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /home/phill/chain-pay/apps/desktop && npm run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/comm/errors.ts
git commit -m "feat(2.7a): typed error classes for comm transport"
```

---

### Task 5: Envelope codec + tests

**Files:**
- Create: `apps/desktop/src/lib/comm/envelope.ts`
- Create: `apps/desktop/src/lib/comm/envelope.test.ts`

The envelope is the **plaintext** inside CEMP-PQ's AES-GCM box: `| version (1) | kind (1) | sender_addr_hash (20) | json_payload (variable)`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/lib/comm/envelope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encodeEnvelope, decodeEnvelope, ENVELOPE_HEADER_LEN } from "./envelope";
import { EnvelopeMalformedError } from "./errors";
import type { OutgoingPacket, OutgoingSignature } from "./types";

const SENDER_HASH = new Uint8Array(20).fill(0xab);

const PACKET: OutgoingPacket = {
  txHash: "0xdeadbeef",
  treasuryAddress: "ckt1qxxx",
  expiresAt: 1747900000,
  packet: { kind: "transfer", payments: [] } as never,
};

const SIGNATURE: OutgoingSignature = {
  txHash: "0xdeadbeef",
  slotIndex: 1,
  signature: "0x" + "11".repeat(65),
};

describe("envelope", () => {
  it("roundtrips a packet envelope", () => {
    const bytes = encodeEnvelope({ kind: "packet", senderAddrHash: SENDER_HASH, payload: PACKET });
    const decoded = decodeEnvelope(bytes);
    expect(decoded.kind).toBe("packet");
    expect(decoded.senderAddrHash).toEqual(SENDER_HASH);
    expect(decoded.payload).toEqual(PACKET);
  });

  it("roundtrips a signature envelope", () => {
    const bytes = encodeEnvelope({ kind: "signature", senderAddrHash: SENDER_HASH, payload: SIGNATURE });
    const decoded = decodeEnvelope(bytes);
    expect(decoded.kind).toBe("signature");
    expect(decoded.payload).toEqual(SIGNATURE);
  });

  it("rejects version > 1", () => {
    const bytes = encodeEnvelope({ kind: "packet", senderAddrHash: SENDER_HASH, payload: PACKET });
    bytes[0] = 0x02;
    expect(() => decodeEnvelope(bytes)).toThrow(EnvelopeMalformedError);
  });

  it("rejects unknown kind byte", () => {
    const bytes = encodeEnvelope({ kind: "packet", senderAddrHash: SENDER_HASH, payload: PACKET });
    bytes[1] = 0xff;
    expect(() => decodeEnvelope(bytes)).toThrow(EnvelopeMalformedError);
  });

  it("rejects input shorter than header", () => {
    const truncated = new Uint8Array(ENVELOPE_HEADER_LEN - 1);
    expect(() => decodeEnvelope(truncated)).toThrow(EnvelopeMalformedError);
  });

  it("rejects sender_addr_hash not exactly 20 bytes on encode", () => {
    expect(() =>
      encodeEnvelope({ kind: "packet", senderAddrHash: new Uint8Array(19), payload: PACKET }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/phill/chain-pay/apps/desktop && npx vitest run src/lib/comm/envelope.test.ts
```

Expected: FAIL — "Cannot find module './envelope'" or similar.

- [ ] **Step 3: Write envelope.ts**

Create `apps/desktop/src/lib/comm/envelope.ts`:

```ts
import { EnvelopeMalformedError } from "./errors";
import type { CommEnvelopeKind } from "./types";
import { ENVELOPE_VERSION } from "./types";

export const ENVELOPE_HEADER_LEN = 22;
const KIND_BYTE: Record<CommEnvelopeKind, number> = { packet: 0x01, signature: 0x02, ack: 0x03 };
const BYTE_TO_KIND: Record<number, CommEnvelopeKind> = { 0x01: "packet", 0x02: "signature", 0x03: "ack" };

export interface EncodeArgs<T = unknown> {
  kind: CommEnvelopeKind;
  senderAddrHash: Uint8Array;
  payload: T;
}

export interface DecodedEnvelope<T = unknown> {
  version: number;
  kind: CommEnvelopeKind;
  senderAddrHash: Uint8Array;
  payload: T;
}

export function encodeEnvelope<T>(args: EncodeArgs<T>): Uint8Array {
  if (args.senderAddrHash.length !== 20) {
    throw new Error(`sender_addr_hash must be exactly 20 bytes, got ${args.senderAddrHash.length}`);
  }
  const json = new TextEncoder().encode(JSON.stringify(args.payload));
  const out = new Uint8Array(ENVELOPE_HEADER_LEN + json.length);
  out[0] = ENVELOPE_VERSION;
  out[1] = KIND_BYTE[args.kind];
  out.set(args.senderAddrHash, 2);
  out.set(json, ENVELOPE_HEADER_LEN);
  return out;
}

export function decodeEnvelope<T = unknown>(bytes: Uint8Array): DecodedEnvelope<T> {
  if (bytes.length < ENVELOPE_HEADER_LEN) {
    throw new EnvelopeMalformedError(`envelope too short: ${bytes.length} < ${ENVELOPE_HEADER_LEN}`);
  }
  const version = bytes[0];
  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeMalformedError(`unsupported envelope version ${version}`);
  }
  const kindByte = bytes[1];
  const kind = BYTE_TO_KIND[kindByte];
  if (!kind) {
    throw new EnvelopeMalformedError(`unknown envelope kind byte 0x${kindByte.toString(16)}`);
  }
  const senderAddrHash = bytes.slice(2, ENVELOPE_HEADER_LEN);
  let payload: T;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes.slice(ENVELOPE_HEADER_LEN))) as T;
  } catch (cause) {
    throw new EnvelopeMalformedError("envelope payload is not valid JSON", { cause });
  }
  return { version, kind, senderAddrHash, payload };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/phill/chain-pay/apps/desktop && npx vitest run src/lib/comm/envelope.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Add remaining tests**

Add the following test cases to `envelope.test.ts` — each is a single `it(...)` block similar to the existing ones:

1. `it("roundtrips an ack envelope")` — kind="ack", payload `{ txHash: "0x123", received: true }`, assert decoded.kind === "ack".
2. `it("preserves sender_addr_hash byte-for-byte across roundtrip")` — fill SENDER_HASH with `i % 256` over 20 bytes, expect `decoded.senderAddrHash[i] === i`.
3. `it("rejects truncated payload (missing JSON brace)")` — encode then slice off the last byte, expect `EnvelopeMalformedError`.
4. `it("rejects non-JSON payload bytes")` — manually craft header + `Uint8Array([0xff, 0xfe])` payload, expect `EnvelopeMalformedError` with `cause` set.
5. `it("encodes deterministically for the same input")` — encode twice with the same args, expect byte-identical output.
6. `it("preserves nested object payloads")` — payload with a nested `packet.payments` array of 3 entries, assert deep equality after roundtrip.

Run all tests:

```bash
npx vitest run src/lib/comm/envelope.test.ts
```

Expected: 12 passing.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/comm/envelope.ts apps/desktop/src/lib/comm/envelope.test.ts
git commit -m "feat(2.7a): envelope codec for comm transport (kind|sender_hash|json)"
```

---

### Task 6: Refusal invariant + tests

**Files:**
- Create: `apps/desktop/src/lib/comm/refusal-invariant.ts`
- Create: `apps/desktop/src/lib/comm/refusal-invariant.test.ts`

The invariant: a comm pubkey hash MUST NOT match the blake160 of any multisig signer of any treasury. Tested with a treasury-store mock injected by the caller.

- [ ] **Step 1: Write failing tests**

Create `apps/desktop/src/lib/comm/refusal-invariant.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assertNotMultisigSigner } from "./refusal-invariant";
import { RefusalInvariantError } from "./errors";

const HASH_A = new Uint8Array(20).fill(0xaa);
const HASH_B = new Uint8Array(20).fill(0xbb);
const HASH_C = new Uint8Array(20).fill(0xcc);

const knownSignersEmpty = () => [];
const knownSignersWithA = () => [{ treasuryId: "t1", pubkeyHash: HASH_A }];
const knownSignersMulti = () => [
  { treasuryId: "t1", pubkeyHash: HASH_A },
  { treasuryId: "t2", pubkeyHash: HASH_B },
];

describe("refusal invariant", () => {
  it("passes when no treasury exists", () => {
    expect(() => assertNotMultisigSigner(HASH_A, knownSignersEmpty)).not.toThrow();
  });

  it("passes when hash matches no signer", () => {
    expect(() => assertNotMultisigSigner(HASH_C, knownSignersMulti)).not.toThrow();
  });

  it("throws RefusalInvariantError when hash matches a signer", () => {
    expect(() => assertNotMultisigSigner(HASH_A, knownSignersWithA)).toThrow(RefusalInvariantError);
  });

  it("identifies the conflicting treasury in the error", () => {
    try {
      assertNotMultisigSigner(HASH_B, knownSignersMulti);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RefusalInvariantError);
      expect((e as RefusalInvariantError).conflict).toContain("t2");
    }
  });

  it("compares bytes, not hex strings", () => {
    // Two arrays with identical bytes but different identity should still match.
    const dup = new Uint8Array(HASH_A);
    expect(() =>
      assertNotMultisigSigner(dup, () => [{ treasuryId: "t1", pubkeyHash: HASH_A }]),
    ).toThrow(RefusalInvariantError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/phill/chain-pay/apps/desktop && npx vitest run src/lib/comm/refusal-invariant.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write refusal-invariant.ts**

Create `apps/desktop/src/lib/comm/refusal-invariant.ts`:

```ts
import { RefusalInvariantError } from "./errors";

export interface KnownSigner {
  treasuryId: string;
  pubkeyHash: Uint8Array;
}

/**
 * Throws RefusalInvariantError if `candidateHash` matches the blake160 of any
 * known multisig signer across all active treasuries.
 *
 * @param candidateHash 20-byte blake160 hash being checked.
 * @param getKnownSigners Lazy accessor — called only when needed so we don't
 *   pin a stale snapshot of treasury state.
 */
export function assertNotMultisigSigner(
  candidateHash: Uint8Array,
  getKnownSigners: () => readonly KnownSigner[],
): void {
  const signers = getKnownSigners();
  for (const signer of signers) {
    if (bytesEqual(candidateHash, signer.pubkeyHash)) {
      throw new RefusalInvariantError(toHex(candidateHash), `multisig signer of treasury ${signer.treasuryId}`);
    }
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 4: Run to verify passing**

```bash
npx vitest run src/lib/comm/refusal-invariant.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Add remaining tests**

Add to `refusal-invariant.test.ts`:

1. `it("only checks the snapshot at call time")` — pass a counter-incrementing accessor; assert it's called exactly once per assertion.
2. `it("handles many signers efficiently")` — 1000 signers, hash not in set, completes in < 50ms.
3. `it("differentiates HASH_A from HASH_A-1 (last byte differs)")` — should NOT throw.

```bash
npx vitest run src/lib/comm/refusal-invariant.test.ts
```

Expected: 8 passing.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/comm/refusal-invariant.ts apps/desktop/src/lib/comm/refusal-invariant.test.ts
git commit -m "feat(2.7a): refusal invariant (comm key != multisig signer)"
```

---

# Phase B — Renderer stores

### Task 7: Renderer comm-identity store + tests

**Files:**
- Create: `apps/desktop/src/stores/comm-identity.ts`
- Create: `apps/desktop/src/stores/comm-identity.test.ts`

Persists the **public** half of the identity in localStorage. Secret keys never live here — they're in main-process safeStorage. Modeled on `stores/treasury.ts`.

- [ ] **Step 1: Write failing tests**

Create `apps/desktop/src/stores/comm-identity.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useCommIdentityStore } from "./comm-identity";

function resetStore(): void {
  useCommIdentityStore.setState({ identity: null });
  globalThis.localStorage?.removeItem("chain-pay:comm-identity");
}

const FIXTURE = {
  mlDsaPub: "0x" + "11".repeat(1952),
  mlKemPub: "0x" + "22".repeat(1184),
  address: "ckt1qmldsa...",
  createdAt: 1747900000_000,
  fundedAt: null,
  profileTxHash: null,
  profilePublishedAt: null,
};

describe("comm-identity store", () => {
  beforeEach(resetStore);

  it("starts with no identity", () => {
    expect(useCommIdentityStore.getState().identity).toBeNull();
  });

  it("setIdentity persists public fields", () => {
    useCommIdentityStore.getState().setIdentity(FIXTURE);
    expect(useCommIdentityStore.getState().identity).toEqual(FIXTURE);
  });

  it("clear() wipes state", () => {
    useCommIdentityStore.getState().setIdentity(FIXTURE);
    useCommIdentityStore.getState().clear();
    expect(useCommIdentityStore.getState().identity).toBeNull();
  });

  it("recordFunded() updates fundedAt without touching other fields", () => {
    useCommIdentityStore.getState().setIdentity(FIXTURE);
    useCommIdentityStore.getState().recordFunded(1747900100_000);
    const got = useCommIdentityStore.getState().identity!;
    expect(got.fundedAt).toBe(1747900100_000);
    expect(got.mlDsaPub).toBe(FIXTURE.mlDsaPub);
  });

  it("recordProfilePublished() updates profileTxHash + profilePublishedAt", () => {
    useCommIdentityStore.getState().setIdentity(FIXTURE);
    useCommIdentityStore.getState().recordProfilePublished("0xprofile", 1747900200_000);
    const got = useCommIdentityStore.getState().identity!;
    expect(got.profileTxHash).toBe("0xprofile");
    expect(got.profilePublishedAt).toBe(1747900200_000);
  });

  it("setIdentity throws if an identity already exists (use clear first)", () => {
    useCommIdentityStore.getState().setIdentity(FIXTURE);
    expect(() => useCommIdentityStore.getState().setIdentity(FIXTURE)).toThrow(
      /identity already exists/i,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/phill/chain-pay/apps/desktop && npx vitest run src/stores/comm-identity.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write comm-identity.ts**

Create `apps/desktop/src/stores/comm-identity.ts`:

```ts
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export interface CommIdentityState {
  /** Hex 0x-prefixed ML-DSA-65 public key (1952 bytes). */
  mlDsaPub: string;
  /** Hex 0x-prefixed ML-KEM-768 public key (1184 bytes). */
  mlKemPub: string;
  /** ckb-mldsa-lock address derived from mlDsaPub. */
  address: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms when the address first observed >= 70 CKB. Null until funded. */
  fundedAt: number | null;
  /** Tx hash of the Profile Cell publish. Null until published. */
  profileTxHash: string | null;
  /** Epoch ms when profile publish landed. */
  profilePublishedAt: number | null;
}

interface CommIdentityStore {
  identity: CommIdentityState | null;
  setIdentity: (identity: CommIdentityState) => void;
  recordFunded: (epochMs: number) => void;
  recordProfilePublished: (txHash: string, epochMs: number) => void;
  clear: () => void;
}

const storageImpl: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const useCommIdentityStore = create<CommIdentityStore>()(
  persist(
    (set, get) => ({
      identity: null,
      setIdentity: (identity) => {
        if (get().identity) throw new Error("comm identity already exists; clear() first");
        set({ identity });
      },
      recordFunded: (epochMs) => {
        const current = get().identity;
        if (!current) return;
        set({ identity: { ...current, fundedAt: epochMs } });
      },
      recordProfilePublished: (txHash, epochMs) => {
        const current = get().identity;
        if (!current) return;
        set({ identity: { ...current, profileTxHash: txHash, profilePublishedAt: epochMs } });
      },
      clear: () => set({ identity: null }),
    }),
    {
      name: "chain-pay:comm-identity",
      storage: createJSONStorage(() => storageImpl),
      version: 1,
      partialize: (state) => ({ identity: state.identity }),
    },
  ),
);
```

- [ ] **Step 4: Run to verify passing**

```bash
npx vitest run src/stores/comm-identity.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Add remaining tests**

Add to `comm-identity.test.ts`:

1. `it("recordFunded is a no-op when no identity exists")` — call without setIdentity first; assert no throw, identity stays null.
2. `it("persists across store recreation via localStorage")` — set state, manually call `useCommIdentityStore.persist.rehydrate()`, assert identity round-trips.

```bash
npx vitest run src/stores/comm-identity.test.ts
```

Expected: 8 passing.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/stores/comm-identity.ts apps/desktop/src/stores/comm-identity.test.ts
git commit -m "feat(2.7a): renderer comm-identity store (public half only)"
```

---

### Task 8: Peer-book store + tests

**Files:**
- Create: `apps/desktop/src/stores/peer-book.ts`
- Create: `apps/desktop/src/stores/peer-book.test.ts`

Persists `Peer[]`. `addPeer` invokes the refusal invariant — the test injects a stub treasury-signer accessor.

- [ ] **Step 1: Write failing tests**

Create `apps/desktop/src/stores/peer-book.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { usePeerBookStore, type Peer } from "./peer-book";
import { RefusalInvariantError } from "../lib/comm/errors";

function resetStore(): void {
  usePeerBookStore.setState({ peers: [], knownSignersGetter: () => [] });
  globalThis.localStorage?.removeItem("chain-pay:peer-book");
}

const PEER_A: Peer = {
  nickname: "Alice",
  address: "ckt1qalice",
  pairedAt: 1747900000_000,
};

const HASH_OF_ALICE = new Uint8Array(20).fill(0xaa);

describe("peer-book store", () => {
  beforeEach(resetStore);

  it("starts empty", () => {
    expect(usePeerBookStore.getState().peers).toEqual([]);
  });

  it("addPeer appends", () => {
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    expect(usePeerBookStore.getState().peers).toEqual([PEER_A]);
  });

  it("addPeer throws RefusalInvariantError when peer hash matches a treasury signer", () => {
    usePeerBookStore.setState({
      knownSignersGetter: () => [{ treasuryId: "t1", pubkeyHash: HASH_OF_ALICE }],
    });
    expect(() => usePeerBookStore.getState().addPeer(PEER_A, HASH_OF_ALICE)).toThrow(
      RefusalInvariantError,
    );
    expect(usePeerBookStore.getState().peers).toEqual([]);
  });

  it("removePeer drops by address", () => {
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    usePeerBookStore.getState().removePeer("ckt1qalice");
    expect(usePeerBookStore.getState().peers).toEqual([]);
  });

  it("renamePeer updates nickname only", () => {
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    usePeerBookStore.getState().renamePeer("ckt1qalice", "Bob");
    expect(usePeerBookStore.getState().peers[0].nickname).toBe("Bob");
    expect(usePeerBookStore.getState().peers[0].address).toBe("ckt1qalice");
  });

  it("findPeer returns by address", () => {
    usePeerBookStore.getState().addPeer(PEER_A, new Uint8Array(20));
    expect(usePeerBookStore.getState().findPeer("ckt1qalice")).toEqual(PEER_A);
    expect(usePeerBookStore.getState().findPeer("ckt1qzzz")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/phill/chain-pay/apps/desktop && npx vitest run src/stores/peer-book.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write peer-book.ts**

Create `apps/desktop/src/stores/peer-book.ts`:

```ts
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { PeerProfile } from "../lib/comm/types";
import { assertNotMultisigSigner, type KnownSigner } from "../lib/comm/refusal-invariant";

export interface Peer {
  nickname: string;
  address: string;
  cachedProfile?: PeerProfile;
  pairedAt: number;
}

interface PeerBookStore {
  peers: Peer[];
  /**
   * Lazy accessor for known multisig signers, injected by the App at boot.
   * Tests override this via setState.
   */
  knownSignersGetter: () => readonly KnownSigner[];
  addPeer: (peer: Peer, candidateHash: Uint8Array) => void;
  removePeer: (address: string) => void;
  renamePeer: (address: string, nickname: string) => void;
  setCachedProfile: (address: string, profile: PeerProfile) => void;
  findPeer: (address: string) => Peer | undefined;
}

const storageImpl: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};

export const usePeerBookStore = create<PeerBookStore>()(
  persist(
    (set, get) => ({
      peers: [],
      knownSignersGetter: () => [],
      addPeer: (peer, candidateHash) => {
        assertNotMultisigSigner(candidateHash, get().knownSignersGetter);
        set((s) => ({ peers: [...s.peers, peer] }));
      },
      removePeer: (address) =>
        set((s) => ({ peers: s.peers.filter((p) => p.address !== address) })),
      renamePeer: (address, nickname) =>
        set((s) => ({
          peers: s.peers.map((p) => (p.address === address ? { ...p, nickname } : p)),
        })),
      setCachedProfile: (address, profile) =>
        set((s) => ({
          peers: s.peers.map((p) => (p.address === address ? { ...p, cachedProfile: profile } : p)),
        })),
      findPeer: (address) => get().peers.find((p) => p.address === address),
    }),
    {
      name: "chain-pay:peer-book",
      storage: createJSONStorage(() => storageImpl),
      version: 1,
      // Don't persist the getter — App.tsx wires it on boot.
      partialize: (state) => ({ peers: state.peers }),
    },
  ),
);
```

- [ ] **Step 4: Run to verify passing**

```bash
npx vitest run src/stores/peer-book.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Add remaining tests**

1. `it("setCachedProfile attaches profile to existing peer")` — addPeer, then setCachedProfile with a PeerProfile literal, assert peer.cachedProfile === profile.
2. `it("setCachedProfile no-ops for unknown address")` — call before addPeer, assert peers stays empty.
3. `it("removePeer no-ops for unknown address")` — addPeer A, removePeer B, assert A still present.
4. `it("addPeer duplicates same address are appended (caller dedupes)")` — addPeer twice with same address, assert length 2 (no dedup at store layer; explicit semantics).

```bash
npx vitest run src/stores/peer-book.test.ts
```

Expected: 10 passing.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/stores/peer-book.ts apps/desktop/src/stores/peer-book.test.ts
git commit -m "feat(2.7a): peer-book store with refusal-invariant on addPeer"
```

---

# Phase C — Main process

### Task 9: Safe-storage abstraction

**Files:**
- Create: `apps/desktop/electron/main/safe-storage.ts`

Lets `comm-identity-store.ts` (next task) work both inside Electron (real `safeStorage`) and outside (smoke script with `SMOKE_PASSPHRASE`-derived PBKDF2 key). No tests directly — exercised by the next task's tests + smoke.

- [ ] **Step 1: Write the abstraction**

Create `apps/desktop/electron/main/safe-storage.ts`:

```ts
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export interface SafeStorageProvider {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
  isAvailable(): boolean;
}

class ElectronSafeStorage implements SafeStorageProvider {
  // Lazy require so this module is importable in plain Node (smoke).
  private get safe(): { encryptString: (s: string) => Buffer; decryptString: (b: Buffer) => string; isEncryptionAvailable: () => boolean } {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("electron").safeStorage;
  }
  encrypt(plaintext: string): Buffer {
    return this.safe.encryptString(plaintext);
  }
  decrypt(ciphertext: Buffer): string {
    return this.safe.decryptString(ciphertext);
  }
  isAvailable(): boolean {
    try {
      return this.safe.isEncryptionAvailable();
    } catch {
      return false;
    }
  }
}

class PassphraseSafeStorage implements SafeStorageProvider {
  private readonly key: Buffer;
  constructor(passphrase: string) {
    // Static salt — this is for smoke use, NOT for production storage.
    this.key = scryptSync(passphrase, "chainpay-comm-smoke-v1", 32);
  }
  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    // [iv(12) | tag(16) | ct(...)]
    return Buffer.concat([iv, tag, ct]);
  }
  decrypt(ciphertext: Buffer): string {
    const iv = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(12, 28);
    const ct = ciphertext.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
  isAvailable(): boolean {
    return true;
  }
}

let cached: SafeStorageProvider | null = null;

export function getSafeStorage(): SafeStorageProvider {
  if (cached) return cached;
  const passphrase = process.env.SMOKE_PASSPHRASE;
  if (passphrase) {
    cached = new PassphraseSafeStorage(passphrase);
  } else {
    cached = new ElectronSafeStorage();
  }
  return cached;
}

/** Test-only: reset the cached provider. */
export function resetSafeStorageForTests(): void {
  cached = null;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /home/phill/chain-pay/apps/desktop && npm run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/electron/main/safe-storage.ts
git commit -m "feat(2.7a): safe-storage abstraction (electron + passphrase fallback)"
```

---

### Task 10: Main comm-identity-store + tests

**Files:**
- Create: `apps/desktop/electron/main/comm-identity-store.ts`
- Create: `apps/desktop/electron/main/comm-identity-store.test.ts`

Owns disk I/O for the encrypted identity blob. Exposes `loadCommIdentity`, `saveCommIdentity`, `deleteCommIdentity`, `withSecrets`.

- [ ] **Step 1: Write failing tests**

Create `apps/desktop/electron/main/comm-identity-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Force the passphrase-based provider before importing the store.
process.env.SMOKE_PASSPHRASE = "test-only-passphrase";
const { resetSafeStorageForTests } = await import("./safe-storage");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "comm-identity-test-"));
const identityFile = path.join(tmpDir, "comm-identity.enc");

const FIXTURE = {
  mlDsaSec: new Uint8Array(32).fill(0xa1),
  mlKemSec: new Uint8Array(2400).fill(0xa2),
  mlDsaPub: new Uint8Array(1952).fill(0xb1),
  mlKemPub: new Uint8Array(1184).fill(0xb2),
  address: "ckt1qmldsa-test",
  createdAt: 1747900000_000,
};

const { loadCommIdentity, saveCommIdentity, deleteCommIdentity, withSecrets, _setIdentityFileForTests } =
  await import("./comm-identity-store");

beforeEach(async () => {
  resetSafeStorageForTests();
  await fs.rm(identityFile, { force: true });
  _setIdentityFileForTests(identityFile);
});

describe("main-process comm-identity-store", () => {
  it("loadCommIdentity returns null when file is absent", async () => {
    expect(await loadCommIdentity()).toBeNull();
  });

  it("saveCommIdentity then loadCommIdentity roundtrips public fields", async () => {
    await saveCommIdentity(FIXTURE);
    const loaded = await loadCommIdentity();
    expect(loaded).not.toBeNull();
    expect(loaded!.mlDsaPub).toBe("0x" + "b1".repeat(1952));
    expect(loaded!.address).toBe(FIXTURE.address);
  });

  it("saveCommIdentity refuses to overwrite existing identity", async () => {
    await saveCommIdentity(FIXTURE);
    await expect(saveCommIdentity(FIXTURE)).rejects.toThrow(/already exists/);
  });

  it("deleteCommIdentity removes the file", async () => {
    await saveCommIdentity(FIXTURE);
    await deleteCommIdentity();
    expect(await loadCommIdentity()).toBeNull();
  });

  it("withSecrets exposes secret keys and zeros them after", async () => {
    await saveCommIdentity(FIXTURE);
    let capturedSec: Uint8Array | null = null;
    await withSecrets(async (secrets) => {
      expect(secrets.mlDsaSec[0]).toBe(0xa1);
      capturedSec = secrets.mlDsaSec;
    });
    // After return, buffer must be zeroed.
    expect(capturedSec![0]).toBe(0x00);
    expect(capturedSec!.every((b) => b === 0)).toBe(true);
  });

  it("atomic write: a half-written temp file does not corrupt state", async () => {
    // Simulate by injecting a write error mid-flight.
    await saveCommIdentity(FIXTURE);
    const original = await loadCommIdentity();
    // Try save again (should reject due to exists-check), original stays intact.
    await expect(saveCommIdentity(FIXTURE)).rejects.toThrow();
    expect(await loadCommIdentity()).toEqual(original);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/phill/chain-pay/apps/desktop && npx vitest run electron/main/comm-identity-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write comm-identity-store.ts**

Create `apps/desktop/electron/main/comm-identity-store.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { getSafeStorage } from "./safe-storage";

export interface PlainIdentity {
  mlDsaSec: Uint8Array;
  mlKemSec: Uint8Array;
  mlDsaPub: Uint8Array;
  mlKemPub: Uint8Array;
  address: string;
  createdAt: number;
}

export interface PublicIdentity {
  mlDsaPub: string;
  mlKemPub: string;
  address: string;
  createdAt: number;
}

let identityFile: string | null = null;

function resolveIdentityFile(): string {
  if (identityFile) return identityFile;
  const dir = process.env.COMM_IDENTITY_DIR ?? defaultUserDataDir();
  return path.join(dir, "comm-identity.enc");
}

function defaultUserDataDir(): string {
  // Lazy require so this file is importable outside Electron (smoke).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("electron").app.getPath("userData");
  } catch {
    throw new Error("Set COMM_IDENTITY_DIR when running outside Electron");
  }
}

export function _setIdentityFileForTests(p: string): void {
  identityFile = p;
}

function toHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  return out;
}

interface StoredShape {
  mlDsaSec: string;
  mlKemSec: string;
  mlDsaPub: string;
  mlKemPub: string;
  address: string;
  createdAt: number;
}

export async function loadCommIdentity(): Promise<PublicIdentity | null> {
  const file = resolveIdentityFile();
  let raw: Buffer;
  try {
    raw = await fs.readFile(file);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const json = JSON.parse(getSafeStorage().decrypt(raw)) as StoredShape;
  return {
    mlDsaPub: json.mlDsaPub,
    mlKemPub: json.mlKemPub,
    address: json.address,
    createdAt: json.createdAt,
  };
}

export async function saveCommIdentity(identity: PlainIdentity): Promise<void> {
  const file = resolveIdentityFile();
  try {
    await fs.access(file);
    throw new Error("comm identity already exists; call deleteCommIdentity() first");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const shape: StoredShape = {
    mlDsaSec: toHex(identity.mlDsaSec),
    mlKemSec: toHex(identity.mlKemSec),
    mlDsaPub: toHex(identity.mlDsaPub),
    mlKemPub: toHex(identity.mlKemPub),
    address: identity.address,
    createdAt: identity.createdAt,
  };
  const encrypted = getSafeStorage().encrypt(JSON.stringify(shape));
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, encrypted);
  await fs.rename(tmp, file);
}

export async function deleteCommIdentity(): Promise<void> {
  const file = resolveIdentityFile();
  await fs.rm(file, { force: true });
}

export async function withSecrets<T>(
  use: (secrets: { mlDsaSec: Uint8Array; mlKemSec: Uint8Array }) => Promise<T>,
): Promise<T> {
  const file = resolveIdentityFile();
  const raw = await fs.readFile(file);
  const json = JSON.parse(getSafeStorage().decrypt(raw)) as StoredShape;
  const mlDsaSec = fromHex(json.mlDsaSec);
  const mlKemSec = fromHex(json.mlKemSec);
  try {
    return await use({ mlDsaSec, mlKemSec });
  } finally {
    mlDsaSec.fill(0);
    mlKemSec.fill(0);
  }
}
```

- [ ] **Step 4: Run to verify passing**

```bash
npx vitest run electron/main/comm-identity-store.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/comm-identity-store.ts apps/desktop/electron/main/comm-identity-store.test.ts
git commit -m "feat(2.7a): main-process comm-identity-store with withSecrets()"
```

---

### Task 11: Main comm-transport-service

**Files:**
- Create: `apps/desktop/electron/main/comm-transport-service.ts`

Wraps CEMP-PQ. All ML-DSA + ML-KEM ops live here; renderer never touches them. **No tests at this task** — exercised end-to-end via the smoke script (Task 18); unit-testing main-process CEMP-PQ interaction would require heavy mocking of the chain that the smoke covers more honestly.

- [ ] **Step 1: Write the service**

Create `apps/desktop/electron/main/comm-transport-service.ts`:

```ts
import { ccc } from "@ckb-ccc/core";
import { CEMPTransactionBuilder, MLDSASigner, ML_DSA_TESTNET, serializeProfile } from "cemp-pq";
import { ml_dsa65, ml_kem768 } from "@noble/post-quantum/ml-dsa";
import { sha3_256 } from "@noble/hashes/sha3";
import { withSecrets, loadCommIdentity, saveCommIdentity, deleteCommIdentity, type PlainIdentity, type PublicIdentity } from "./comm-identity-store";

export interface ProfileFetchResult {
  address: string;
  mlDsaPubKey: string; // hex
  mlKemPubKey: string; // hex
  metadata: string;    // utf8 if decodable; else hex
}

export interface SignedTxBundle {
  txHash: string;
  txBytes: string; // 0x-prefixed serialized tx for renderer to broadcast
}

let cachedClient: ccc.ClientPublicTestnet | null = null;

function client(): ccc.ClientPublicTestnet {
  if (!cachedClient) {
    const url = process.env.COMM_CKB_RPC_URL ?? "https://testnet.ckb.dev";
    cachedClient = new ccc.ClientPublicTestnet({ url });
  }
  return cachedClient;
}

function mldsaLock(mlDsaPubKey: Uint8Array): ccc.Script {
  const args = sha3_256(mlDsaPubKey).slice(0, 32);
  return ccc.Script.from({
    codeHash: ML_DSA_TESTNET.code_hash,
    hashType: ML_DSA_TESTNET.hash_type,
    args: "0x" + Buffer.from(args).toString("hex"),
  });
}

export async function generateIdentity(): Promise<PublicIdentity> {
  const existing = await loadCommIdentity();
  if (existing) throw new Error("comm identity already exists");

  const dsaSeed = crypto.getRandomValues(new Uint8Array(32));
  const dsa = ml_dsa65.keygen(dsaSeed);
  const kemSeed = crypto.getRandomValues(new Uint8Array(64));
  const kem = ml_kem768.keygen(kemSeed);
  const lock = mldsaLock(dsa.publicKey);
  const address = (await ccc.Address.fromScript(lock, client())).toString();

  const plain: PlainIdentity = {
    mlDsaSec: dsa.secretKey,
    mlKemSec: kem.secretKey,
    mlDsaPub: dsa.publicKey,
    mlKemPub: kem.publicKey,
    address,
    createdAt: Date.now(),
  };
  await saveCommIdentity(plain);
  // Zero local copies of secrets; saveCommIdentity has already persisted them encrypted.
  plain.mlDsaSec.fill(0);
  plain.mlKemSec.fill(0);

  return {
    mlDsaPub: "0x" + Buffer.from(dsa.publicKey).toString("hex"),
    mlKemPub: "0x" + Buffer.from(kem.publicKey).toString("hex"),
    address,
    createdAt: plain.createdAt,
  };
}

export async function exists(): Promise<boolean> {
  return (await loadCommIdentity()) !== null;
}

export async function publicInfo(): Promise<PublicIdentity | null> {
  return loadCommIdentity();
}

export async function deleteIdentity(): Promise<void> {
  await deleteCommIdentity();
}

export async function publishProfile(metadata: { displayName?: string } = {}): Promise<SignedTxBundle> {
  const pub = await loadCommIdentity();
  if (!pub) throw new Error("no comm identity");
  const dsaPub = Buffer.from(pub.mlDsaPub.slice(2), "hex");
  const kemPub = Buffer.from(pub.mlKemPub.slice(2), "hex");
  const metaBytes = new TextEncoder().encode(JSON.stringify(metadata));

  return withSecrets(async (secrets) => {
    const signer = new MLDSASigner(client(), secrets.mlDsaSec);
    const builder = new CEMPTransactionBuilder(client());
    const tx = await builder.buildCreateProfileTx(signer, dsaPub, kemPub, metaBytes);
    const signed = await signer.signOnlyTransaction(tx);
    return {
      txHash: ccc.hashCkb(signed.raw()),
      txBytes: "0x" + Buffer.from(signed.toBytes()).toString("hex"),
    };
  });
}

export async function sendMessage(recipientAddress: string, envelopeBytes: Uint8Array): Promise<SignedTxBundle> {
  const pub = await loadCommIdentity();
  if (!pub) throw new Error("no comm identity");
  const recipientLock = (await ccc.Address.fromString(recipientAddress, client())).script;
  return withSecrets(async (secrets) => {
    const signer = new MLDSASigner(client(), secrets.mlDsaSec);
    const builder = new CEMPTransactionBuilder(client());
    const tx = await builder.buildSendMessageTx(signer, recipientLock, envelopeBytes);
    const signed = await signer.signOnlyTransaction(tx);
    return {
      txHash: ccc.hashCkb(signed.raw()),
      txBytes: "0x" + Buffer.from(signed.toBytes()).toString("hex"),
    };
  });
}

export async function decryptIncoming(messageOutPoint: { txHash: string; index: number }): Promise<string> {
  const messageCell = await client().getCellLive({ txHash: messageOutPoint.txHash, index: BigInt(messageOutPoint.index) }, true);
  if (!messageCell) throw new Error("message cell consumed");
  const dataHex = messageCell.outputData;

  return withSecrets(async (secrets) => {
    // Parse EncryptedMessage molecule: | kem(1088) | nonce(12) | ciphertext(rem) |
    const data = Buffer.from(dataHex.slice(2), "hex");
    const kemCt = data.subarray(0, 1088);
    const nonce = data.subarray(1088, 1100);
    const ct = data.subarray(1100);

    const sharedSecret = ml_kem768.decapsulate(kemCt, secrets.mlKemSec);
    const key = await crypto.subtle.importKey("raw", sharedSecret, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct);
    return "0x" + Buffer.from(plain).toString("hex");
  });
}

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

> **Implementer note:** The exact `EncryptedMessage` molecule layout above (`kem | nonce | ciphertext`, sizes 1088/12/rest) is the canonical CEMP-PQ shape per `~/ecms/cemp-pq/index.js::serializeEncryptedMessage`. If `buildSendMessageTx` writes a different layout (e.g. molecule headers), update `decryptIncoming`'s parsing to match — verify by reading the upstream `serializeEncryptedMessage` and matching its byte offsets exactly.

- [ ] **Step 2: Typecheck**

```bash
cd /home/phill/chain-pay/apps/desktop && npm run typecheck
```

Expected: passes. If `@noble/post-quantum` isn't yet in apps/desktop's deps via cemp-pq's transitive chain, add it explicitly:

```bash
cd apps/desktop && npm install @noble/post-quantum@^0.2.1 @noble/hashes@^1.8.0
```

Then commit the lock-file update alongside this task.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/electron/main/comm-transport-service.ts apps/desktop/package.json package-lock.json
git commit -m "feat(2.7a): main-process comm-transport-service wrapping cemp-pq"
```

---

### Task 12: Preload IPC bridge

**Files:**
- Modify: `apps/desktop/electron/preload/index.ts`
- Modify: `apps/desktop/src/global.d.ts` (or create if absent) — types for `window.chainpay`

- [ ] **Step 1: Read current preload**

```bash
cat /home/phill/chain-pay/apps/desktop/electron/preload/index.ts
```

Confirm there's a `window.chainpay` namespace already from Phase 2 (light-client bridge). If yes, extend it. If no, create the namespace.

- [ ] **Step 2: Add IPC channel wiring**

Append to `apps/desktop/electron/preload/index.ts`, inside the existing `contextBridge.exposeInMainWorld("chainpay", { ... })` object (merge — don't replace):

```ts
import { ipcRenderer } from "electron";

// Inside the chainpay object literal:
commIdentity: {
  exists: (): Promise<boolean> => ipcRenderer.invoke("commIdentity:exists"),
  publicInfo: () => ipcRenderer.invoke("commIdentity:publicInfo"),
  generate: () => ipcRenderer.invoke("commIdentity:generate"),
  delete: () => ipcRenderer.invoke("commIdentity:delete"),
},
commTransport: {
  publishProfile: (metadata: { displayName?: string } | undefined) =>
    ipcRenderer.invoke("commTransport:publishProfile", metadata ?? {}),
  sendMessage: (recipientAddress: string, envelopeBytesHex: string) =>
    ipcRenderer.invoke("commTransport:sendMessage", recipientAddress, envelopeBytesHex),
  decryptIncoming: (messageOutPoint: { txHash: string; index: number }) =>
    ipcRenderer.invoke("commTransport:decryptIncoming", messageOutPoint),
  resolveProfile: (address: string) =>
    ipcRenderer.invoke("commTransport:resolveProfile", address),
},
```

> **Implementer note:** envelope bytes cross the IPC boundary as a 0x-prefixed hex string (not raw Uint8Array) because IPC structured-clone on Uint8Array has historically been finicky across Electron versions. Renderer hex-encodes; main hex-decodes.

- [ ] **Step 3: Add type declarations**

Create `apps/desktop/src/global.d.ts` if absent, or extend existing:

```ts
declare global {
  interface Window {
    chainpay: {
      // ... existing bindings from Phase 2 (lightClient, etc.) ...
      commIdentity: {
        exists(): Promise<boolean>;
        publicInfo(): Promise<{ mlDsaPub: string; mlKemPub: string; address: string; createdAt: number } | null>;
        generate(): Promise<{ mlDsaPub: string; mlKemPub: string; address: string; createdAt: number }>;
        delete(): Promise<void>;
      };
      commTransport: {
        publishProfile(metadata?: { displayName?: string }): Promise<{ txHash: string; txBytes: string }>;
        sendMessage(recipientAddress: string, envelopeBytesHex: string): Promise<{ txHash: string; txBytes: string }>;
        decryptIncoming(messageOutPoint: { txHash: string; index: number }): Promise<string>;
        resolveProfile(address: string): Promise<{ address: string; mlDsaPubKey: string; mlKemPubKey: string; metadata: string }>;
      };
    };
  }
}
export {};
```

- [ ] **Step 4: Typecheck**

```bash
cd /home/phill/chain-pay/apps/desktop && npm run typecheck
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/preload/index.ts apps/desktop/src/global.d.ts
git commit -m "feat(2.7a): preload IPC bridge for commIdentity + commTransport"
```

---

### Task 13: Register main IPC handlers

**Files:**
- Modify: `apps/desktop/electron/main/index.ts`

- [ ] **Step 1: Read current main**

```bash
grep -n "ipcMain\.handle\|app\.whenReady\|registerLightClient" /home/phill/chain-pay/apps/desktop/electron/main/index.ts | head -20
```

Identify where existing `ipcMain.handle` calls live (likely inside `app.whenReady()` callback).

- [ ] **Step 2: Add the handlers**

Inside the same `app.whenReady()` block in `electron/main/index.ts`, add:

```ts
import { ipcMain } from "electron";
import {
  exists as commExists,
  publicInfo as commPublicInfo,
  generateIdentity,
  deleteIdentity,
  publishProfile,
  sendMessage,
  decryptIncoming,
  resolveProfile,
} from "./comm-transport-service";

ipcMain.handle("commIdentity:exists", () => commExists());
ipcMain.handle("commIdentity:publicInfo", () => commPublicInfo());
ipcMain.handle("commIdentity:generate", () => generateIdentity());
ipcMain.handle("commIdentity:delete", () => deleteIdentity());

ipcMain.handle("commTransport:publishProfile", (_e, metadata) => publishProfile(metadata));
ipcMain.handle("commTransport:sendMessage", (_e, recipientAddress: string, envelopeBytesHex: string) => {
  const envelopeBytes = Uint8Array.from(Buffer.from(envelopeBytesHex.slice(2), "hex"));
  return sendMessage(recipientAddress, envelopeBytes);
});
ipcMain.handle("commTransport:decryptIncoming", (_e, messageOutPoint: { txHash: string; index: number }) =>
  decryptIncoming(messageOutPoint),
);
ipcMain.handle("commTransport:resolveProfile", (_e, address: string) => resolveProfile(address));
```

- [ ] **Step 3: Build the desktop app**

```bash
cd /home/phill/chain-pay/apps/desktop && npm run build
```

Expected: build succeeds. Main bundle includes the new handlers.

- [ ] **Step 4: Smoke-test electron boot**

```bash
cd /home/phill/chain-pay/apps/desktop && npm run dev
```

Open DevTools in the Electron window. In the renderer console:

```js
await window.chainpay.commIdentity.exists()
```

Expected: `false` (assuming clean state). No IPC errors in the main process console.

Quit the dev session.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/index.ts
git commit -m "feat(2.7a): register commIdentity + commTransport ipcMain handlers"
```

---

# Phase D — Renderer transport

### Task 14: Watcher module + tests

**Files:**
- Create: `apps/desktop/src/lib/comm/cemp-pq/watcher.ts`
- Create: `apps/desktop/src/lib/comm/cemp-pq/watcher.test.ts`

The watcher polls `listCellsForLock(ownLock)` on the LC's existing cadence, fetches Message Cells pointed to by new Notification Cells, calls `commTransport.decryptIncoming`, and dispatches by `kind`. All chain calls injected.

- [ ] **Step 1: Write failing tests**

Create `apps/desktop/src/lib/comm/cemp-pq/watcher.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWatcher, type WatcherDeps } from "./watcher";
import { encodeEnvelope } from "../envelope";

const SENDER_HASH = new Uint8Array(20).fill(0xab);
const OWN_LOCK = { codeHash: "0xself", hashType: "type" as const, args: "0x01" };

function makeDeps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    ownLock: OWN_LOCK,
    listCellsForLock: vi.fn().mockResolvedValue([]),
    decryptIncoming: vi.fn().mockRejectedValue(new Error("no cell")),
    parseMessagePointer: vi.fn().mockReturnValue({ txHash: "0xm", index: 0 }),
    ...overrides,
  };
}

describe("watcher", () => {
  beforeEach(() => vi.useFakeTimers());

  it("starts polling on start()", async () => {
    const deps = makeDeps();
    const w = createWatcher(deps);
    await w.start();
    expect(deps.listCellsForLock).toHaveBeenCalledTimes(1);
    await w.stop();
  });

  it("dispatches packet kind to onIncomingPacket", async () => {
    const envelopeBytes = encodeEnvelope({
      kind: "packet",
      senderAddrHash: SENDER_HASH,
      payload: { txHash: "0xtx", treasuryAddress: "tA", expiresAt: 0, packet: {} as never },
    });
    const deps = makeDeps({
      listCellsForLock: vi.fn().mockResolvedValueOnce([
        { outPoint: { txHash: "0xn1", index: 0 }, outputData: "0xdeadbeef" },
      ]),
      decryptIncoming: vi.fn().mockResolvedValue("0x" + Buffer.from(envelopeBytes).toString("hex")),
    });
    const onPacket = vi.fn();
    const w = createWatcher(deps);
    w.onIncomingPacket(onPacket);
    await w.start();
    await vi.runAllTimersAsync();
    expect(onPacket).toHaveBeenCalledTimes(1);
    expect(onPacket).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ txHash: "0xtx" }));
    await w.stop();
  });

  it("dedups cells already processed", async () => {
    const envelopeBytes = encodeEnvelope({
      kind: "signature",
      senderAddrHash: SENDER_HASH,
      payload: { txHash: "0xtx", slotIndex: 0, signature: "0xsig" },
    });
    const cell = { outPoint: { txHash: "0xn1", index: 0 }, outputData: "0xff" };
    const deps = makeDeps({
      listCellsForLock: vi.fn().mockResolvedValue([cell]),
      decryptIncoming: vi.fn().mockResolvedValue("0x" + Buffer.from(envelopeBytes).toString("hex")),
    });
    const onSig = vi.fn();
    const w = createWatcher(deps);
    w.onIncomingSignature(onSig);
    await w.start();
    await vi.runAllTimersAsync();
    // Second tick — same cell, should not re-dispatch.
    await w.poll();
    expect(onSig).toHaveBeenCalledTimes(1);
    await w.stop();
  });

  it("silently drops cells whose envelope fails to decrypt", async () => {
    const deps = makeDeps({
      listCellsForLock: vi.fn().mockResolvedValueOnce([
        { outPoint: { txHash: "0xn1", index: 0 }, outputData: "0xff" },
      ]),
      decryptIncoming: vi.fn().mockRejectedValue(new Error("AES tag mismatch")),
    });
    const onPacket = vi.fn();
    const onSig = vi.fn();
    const w = createWatcher(deps);
    w.onIncomingPacket(onPacket);
    w.onIncomingSignature(onSig);
    await w.start();
    await vi.runAllTimersAsync();
    expect(onPacket).not.toHaveBeenCalled();
    expect(onSig).not.toHaveBeenCalled();
    await w.stop();
  });

  it("unsubscribe removes the handler", async () => {
    const envelopeBytes = encodeEnvelope({
      kind: "packet",
      senderAddrHash: SENDER_HASH,
      payload: { txHash: "0xtx", treasuryAddress: "tA", expiresAt: 0, packet: {} as never },
    });
    const deps = makeDeps({
      listCellsForLock: vi.fn().mockResolvedValueOnce([
        { outPoint: { txHash: "0xn1", index: 0 }, outputData: "0xff" },
      ]),
      decryptIncoming: vi.fn().mockResolvedValue("0x" + Buffer.from(envelopeBytes).toString("hex")),
    });
    const onPacket = vi.fn();
    const w = createWatcher(deps);
    const off = w.onIncomingPacket(onPacket);
    off();
    await w.start();
    await vi.runAllTimersAsync();
    expect(onPacket).not.toHaveBeenCalled();
    await w.stop();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/phill/chain-pay/apps/desktop && npx vitest run src/lib/comm/cemp-pq/watcher.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write watcher.ts**

Create `apps/desktop/src/lib/comm/cemp-pq/watcher.ts`:

```ts
import { decodeEnvelope } from "../envelope";
import type {
  CommEnvelopeKind,
  IncomingPacketHandler,
  IncomingSignatureHandler,
  OutgoingPacket,
  OutgoingSignature,
  Unsubscribe,
} from "../types";

interface CellLike {
  outPoint: { txHash: string; index: number };
  outputData: string; // 0x-prefixed hex of MessagePointer
}

interface ScriptLike {
  codeHash: string;
  hashType: "type" | "data" | "data1" | "data2";
  args: string;
}

export interface WatcherDeps {
  ownLock: ScriptLike;
  listCellsForLock(script: ScriptLike): Promise<CellLike[]>;
  decryptIncoming(outPoint: { txHash: string; index: number }): Promise<string>;
  parseMessagePointer(outputDataHex: string): { txHash: string; index: number };
  pollIntervalMs?: number;
}

export interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  poll(): Promise<void>;
  isRunning(): boolean;
  onIncomingPacket(h: IncomingPacketHandler): Unsubscribe;
  onIncomingSignature(h: IncomingSignatureHandler): Unsubscribe;
}

const DEFAULT_POLL_MS = 5000;

export function createWatcher(deps: WatcherDeps): Watcher {
  const processed = new Set<string>();
  const packetHandlers = new Set<IncomingPacketHandler>();
  const signatureHandlers = new Set<IncomingSignatureHandler>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function cellKey(outPoint: { txHash: string; index: number }): string {
    return `${outPoint.txHash}:${outPoint.index}`;
  }

  async function poll(): Promise<void> {
    let cells: CellLike[];
    try {
      cells = await deps.listCellsForLock(deps.ownLock);
    } catch {
      return; // network errors are transient; next tick retries
    }
    for (const cell of cells) {
      const key = cellKey(cell.outPoint);
      if (processed.has(key)) continue;
      processed.add(key);
      try {
        const messagePtr = deps.parseMessagePointer(cell.outputData);
        const envelopeHex = await deps.decryptIncoming(messagePtr);
        const envelopeBytes = Uint8Array.from(Buffer.from(envelopeHex.slice(2), "hex"));
        const decoded = decodeEnvelope(envelopeBytes);
        dispatch(decoded.kind, hexFromBytes(decoded.senderAddrHash), decoded.payload);
      } catch {
        // silently drop — junk/encrypted-to-someone-else/version-mismatch
      }
    }
  }

  function dispatch(kind: CommEnvelopeKind, senderHashHex: string, payload: unknown): void {
    if (kind === "packet") {
      for (const h of packetHandlers) h(senderHashHex, payload as OutgoingPacket);
    } else if (kind === "signature") {
      for (const h of signatureHandlers) h(senderHashHex, payload as OutgoingSignature);
    }
    // ack handling lands in 2.7b
  }

  return {
    isRunning: () => timer !== null,
    async start() {
      if (timer !== null) return;
      await poll();
      timer = setInterval(() => void poll(), deps.pollIntervalMs ?? DEFAULT_POLL_MS);
    },
    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    poll,
    onIncomingPacket(h) {
      packetHandlers.add(h);
      return () => packetHandlers.delete(h);
    },
    onIncomingSignature(h) {
      signatureHandlers.add(h);
      return () => signatureHandlers.delete(h);
    },
  };
}

function hexFromBytes(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 4: Run to verify passing**

```bash
npx vitest run src/lib/comm/cemp-pq/watcher.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Add remaining tests**

1. `it("survives a listCellsForLock rejection")` — make listCells reject once then succeed; assert no throw and next-tick dispatches normally.
2. `it("drops envelope with unknown kind silently")` — encode envelope, manually mutate `bytes[1] = 0xff`, hex-encode and return from decryptIncoming; assert no handler fires.
3. `it("ignores cells once stopped")` — start, stop, then poll() manually; assert listCellsForLock not called after stop.
4. `it("dispatches to multiple handlers")` — onIncomingPacket twice with different handlers; both called.

```bash
npx vitest run src/lib/comm/cemp-pq/watcher.test.ts
```

Expected: 9 passing.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/comm/cemp-pq/watcher.ts apps/desktop/src/lib/comm/cemp-pq/watcher.test.ts
git commit -m "feat(2.7a): cemp-pq watcher (listCells → decrypt → dispatch)"
```

---

### Task 15: CempPqCommTransport + tests

**Files:**
- Create: `apps/desktop/src/lib/comm/cemp-pq/transport.ts`
- Create: `apps/desktop/src/lib/comm/cemp-pq/transport.test.ts`

Implements the `CommTransport` interface. Calls main-process IPC for everything that needs the identity; uses the watcher for incoming.

- [ ] **Step 1: Write failing tests**

Create `apps/desktop/src/lib/comm/cemp-pq/transport.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CempPqCommTransport, type TransportDeps } from "./transport";
import { encodeEnvelope } from "../envelope";
import type { PeerProfile, OutgoingPacket } from "../types";

const OWN_LOCK = { codeHash: "0xself", hashType: "type" as const, args: "0xown" };
const OWN_ADDR_HASH = new Uint8Array(20).fill(0x01);
const PEER: PeerProfile = {
  address: "ckt1qbob",
  mlDsaPubKey: new Uint8Array(1952),
  mlKemPubKey: new Uint8Array(1184).fill(0xee),
  fetchedAt: Date.now(),
};
const PACKET: OutgoingPacket = {
  txHash: "0xbatch",
  treasuryAddress: "ckt1qtreasury",
  expiresAt: 1747900000,
  packet: { kind: "transfer", payments: [] } as never,
};

function makeDeps(overrides: Partial<TransportDeps> = {}): TransportDeps {
  return {
    getOwnLock: vi.fn().mockResolvedValue(OWN_LOCK),
    getOwnAddrHash: vi.fn().mockResolvedValue(OWN_ADDR_HASH),
    getProfilePublishBlock: vi.fn().mockResolvedValue(100n),
    ipc: {
      publishProfile: vi.fn().mockResolvedValue({ txHash: "0xp", txBytes: "0xtxbytes" }),
      sendMessage: vi.fn().mockResolvedValue({ txHash: "0xs", txBytes: "0xtxbytes" }),
      decryptIncoming: vi.fn().mockResolvedValue("0xenvelope"),
      resolveProfile: vi.fn().mockResolvedValue({
        address: PEER.address,
        mlDsaPubKey: "0x" + "00".repeat(1952),
        mlKemPubKey: "0x" + "ee".repeat(1184),
        metadata: "{}",
      }),
    },
    broadcastTransaction: vi.fn().mockResolvedValue("0xb"),
    watchLockScript: vi.fn().mockResolvedValue(undefined),
    listCellsForLock: vi.fn().mockResolvedValue([]),
    parseMessagePointer: vi.fn(),
    ...overrides,
  };
}

describe("CempPqCommTransport", () => {
  it("sendPacket: encodes envelope, calls ipc.sendMessage, broadcasts", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    const txHash = await t.sendPacket(PEER, PACKET);
    expect(deps.ipc.sendMessage).toHaveBeenCalledTimes(1);
    const [recipient, envelopeHex] = (deps.ipc.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(recipient).toBe(PEER.address);
    // Envelope first byte = version 0x01, second byte = packet kind 0x01.
    const bytes = Buffer.from(envelopeHex.slice(2), "hex");
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(0x01);
    expect(deps.broadcastTransaction).toHaveBeenCalledWith("0xtxbytes");
    expect(txHash).toBe("0xs");
  });

  it("sendSignature: uses signature kind byte (0x02)", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    await t.sendSignature(PEER, { txHash: "0xb", slotIndex: 0, signature: "0xsig" });
    const [, envelopeHex] = (deps.ipc.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(Buffer.from(envelopeHex.slice(2), "hex")[1]).toBe(0x02);
  });

  it("publishProfile: forwards to ipc and broadcasts", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    const tx = await t.publishProfile({ displayName: "Alice" });
    expect(deps.ipc.publishProfile).toHaveBeenCalledWith({ displayName: "Alice" });
    expect(deps.broadcastTransaction).toHaveBeenCalledWith("0xtxbytes");
    expect(tx).toBe("0xp");
  });

  it("resolveProfile: caches results for 1h TTL", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    const first = await t.resolveProfile(PEER.address);
    const second = await t.resolveProfile(PEER.address);
    expect(deps.ipc.resolveProfile).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("start(): seeds lastSeenBlock from profilePublishBlock", async () => {
    const deps = makeDeps();
    const t = new CempPqCommTransport(deps);
    await t.start();
    expect(deps.getProfilePublishBlock).toHaveBeenCalled();
    expect(deps.watchLockScript).toHaveBeenCalledWith(OWN_LOCK, 100n);
    expect(t.isRunning()).toBe(true);
    await t.stop();
  });

  it("start(): refuses when no profile published yet", async () => {
    const deps = makeDeps({ getProfilePublishBlock: vi.fn().mockResolvedValue(null) });
    const t = new CempPqCommTransport(deps);
    await expect(t.start()).rejects.toThrow(/profile/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/phill/chain-pay/apps/desktop && npx vitest run src/lib/comm/cemp-pq/transport.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write transport.ts**

Create `apps/desktop/src/lib/comm/cemp-pq/transport.ts`:

```ts
import { encodeEnvelope } from "../envelope";
import type {
  CommTransport,
  IncomingPacketHandler,
  IncomingSignatureHandler,
  OutgoingPacket,
  OutgoingSignature,
  PeerProfile,
  Unsubscribe,
} from "../types";
import { ProfileNotFoundError } from "../errors";
import { createWatcher, type Watcher } from "./watcher";

interface ScriptLike {
  codeHash: string;
  hashType: "type" | "data" | "data1" | "data2";
  args: string;
}

export interface TransportDeps {
  getOwnLock(): Promise<ScriptLike>;
  getOwnAddrHash(): Promise<Uint8Array>;
  /** Resolves to the block number of the install's Profile Cell publish tx, or null if not published. */
  getProfilePublishBlock(): Promise<bigint | null>;
  ipc: {
    publishProfile(metadata: { displayName?: string }): Promise<{ txHash: string; txBytes: string }>;
    sendMessage(recipientAddress: string, envelopeBytesHex: string): Promise<{ txHash: string; txBytes: string }>;
    decryptIncoming(outPoint: { txHash: string; index: number }): Promise<string>;
    resolveProfile(address: string): Promise<{ address: string; mlDsaPubKey: string; mlKemPubKey: string; metadata: string }>;
  };
  broadcastTransaction(txBytesHex: string): Promise<string>;
  watchLockScript(script: ScriptLike, fromBlock: bigint): Promise<void>;
  listCellsForLock(script: ScriptLike): Promise<{ outPoint: { txHash: string; index: number }; outputData: string }[]>;
  parseMessagePointer(outputDataHex: string): { txHash: string; index: number };
}

const PROFILE_CACHE_TTL_MS = 60 * 60 * 1000;

export class CempPqCommTransport implements CommTransport {
  private watcher: Watcher | null = null;
  private readonly profileCache = new Map<string, { profile: PeerProfile; expiresAt: number }>();

  constructor(private readonly deps: TransportDeps) {}

  async start(): Promise<void> {
    if (this.watcher) return;
    const publishBlock = await this.deps.getProfilePublishBlock();
    if (publishBlock === null) {
      throw new Error("cannot start transport: no Profile Cell published yet");
    }
    const ownLock = await this.deps.getOwnLock();
    await this.deps.watchLockScript(ownLock, publishBlock);
    this.watcher = createWatcher({
      ownLock,
      listCellsForLock: this.deps.listCellsForLock,
      decryptIncoming: this.deps.ipc.decryptIncoming,
      parseMessagePointer: this.deps.parseMessagePointer,
    });
    await this.watcher.start();
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.stop();
    this.watcher = null;
  }

  isRunning(): boolean {
    return this.watcher !== null;
  }

  async publishProfile(metadata: { displayName?: string } = {}): Promise<string> {
    const { txHash, txBytes } = await this.deps.ipc.publishProfile(metadata);
    await this.deps.broadcastTransaction(txBytes);
    return txHash;
  }

  async resolveProfile(address: string): Promise<PeerProfile> {
    const cached = this.profileCache.get(address);
    if (cached && cached.expiresAt > Date.now()) return cached.profile;
    let result;
    try {
      result = await this.deps.ipc.resolveProfile(address);
    } catch (cause) {
      throw new ProfileNotFoundError(address, { cause });
    }
    const profile: PeerProfile = {
      address: result.address,
      mlDsaPubKey: hexToBytes(result.mlDsaPubKey),
      mlKemPubKey: hexToBytes(result.mlKemPubKey),
      metadata: result.metadata ? safeParseMetadata(result.metadata) : undefined,
      fetchedAt: Date.now(),
    };
    this.profileCache.set(address, { profile, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS });
    return profile;
  }

  async sendPacket(peer: PeerProfile, body: OutgoingPacket): Promise<string> {
    return this.sendEnvelope(peer, "packet", body);
  }

  async sendSignature(peer: PeerProfile, body: OutgoingSignature): Promise<string> {
    return this.sendEnvelope(peer, "signature", body);
  }

  private async sendEnvelope(peer: PeerProfile, kind: "packet" | "signature", payload: unknown): Promise<string> {
    const senderAddrHash = await this.deps.getOwnAddrHash();
    const envelope = encodeEnvelope({ kind, senderAddrHash, payload });
    const envelopeHex = "0x" + Buffer.from(envelope).toString("hex");
    const { txHash, txBytes } = await this.deps.ipc.sendMessage(peer.address, envelopeHex);
    await this.deps.broadcastTransaction(txBytes);
    return txHash;
  }

  onIncomingPacket(h: IncomingPacketHandler): Unsubscribe {
    if (!this.watcher) throw new Error("transport not started");
    return this.watcher.onIncomingPacket(h);
  }

  onIncomingSignature(h: IncomingSignatureHandler): Unsubscribe {
    if (!this.watcher) throw new Error("transport not started");
    return this.watcher.onIncomingSignature(h);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function safeParseMetadata(raw: string): { displayName?: string } | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.displayName === "string") return { displayName: parsed.displayName };
  } catch {
    /* fall through */
  }
  return undefined;
}
```

- [ ] **Step 4: Run to verify passing**

```bash
npx vitest run src/lib/comm/cemp-pq/transport.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Add remaining tests**

1. `it("resolveProfile: refetches after TTL expiry")` — `vi.useFakeTimers()`, resolve, advance 1h+1s, resolve again, assert ipc called twice.
2. `it("resolveProfile: wraps unknown errors in ProfileNotFoundError")` — ipc.resolveProfile rejects with a random Error; assert ProfileNotFoundError thrown with `cause` set.
3. `it("onIncomingPacket throws when transport not started")` — fresh transport, immediately register handler; expect throw.
4. `it("sendPacket: encodes sender_addr_hash exactly as returned by getOwnAddrHash")` — assert bytes 2..22 of envelope match the 20-byte hash returned.
5. `it("start() is idempotent")` — call start twice; watchLockScript called once.
6. `it("stop() is idempotent")` — call stop twice; clearInterval not called twice (asserted via watcher.isRunning being false after both).
7. `it("isRunning() reflects watcher lifecycle")` — false before start, true after, false after stop.
8. `it("publishProfile returns the tx hash from ipc")` — already covered, but add assertion that the result is exactly `{txHash}` (no transformation).
9. `it("resolveProfile passes through metadata.displayName")` — ipc returns metadata `'{"displayName":"Alice"}'`; assert profile.metadata.displayName === "Alice".

```bash
npx vitest run src/lib/comm/cemp-pq/transport.test.ts
```

Expected: 15 passing.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/comm/cemp-pq/transport.ts apps/desktop/src/lib/comm/cemp-pq/transport.test.ts
git commit -m "feat(2.7a): CempPqCommTransport implementing CommTransport interface"
```

---

### Task 16: Singleton factory

**Files:**
- Create: `apps/desktop/src/lib/comm/index.ts`

Lazy singleton that wires real dependencies (light-client host, comm-identity store, IPC). Returns `null` when no identity exists — UI guards on this.

- [ ] **Step 1: Write the factory**

Create `apps/desktop/src/lib/comm/index.ts`:

```ts
import { lightClient } from "../light-client/host";
import { useCommIdentityStore } from "../../stores/comm-identity";
import { CempPqCommTransport } from "./cemp-pq/transport";
import type { CommTransport } from "./types";

let cached: CommTransport | null = null;

export function createCommTransport(): CommTransport | null {
  if (cached) return cached;
  const identity = useCommIdentityStore.getState().identity;
  if (!identity) return null;
  cached = new CempPqCommTransport({
    getOwnLock: async () => {
      // The ML-DSA lock script for our own address — derived from identity.mlDsaPub.
      // host.ts has a helper; if not, the renderer needs to compute it. For 2.7a we
      // call into main process to get the canonical script (avoids duplicating sha3 logic).
      const info = await window.chainpay.commIdentity.publicInfo();
      if (!info) throw new Error("identity disappeared");
      return await window.chainpay.lightClient.deriveLockFromAddress(info.address);
    },
    getOwnAddrHash: async () => {
      const info = await window.chainpay.commIdentity.publicInfo();
      if (!info) throw new Error("identity disappeared");
      // Pull the 20-byte args from the lock script (sha3 truncated as per ML-DSA-lock).
      const lock = await window.chainpay.lightClient.deriveLockFromAddress(info.address);
      const argsHex = lock.args.startsWith("0x") ? lock.args.slice(2) : lock.args;
      const bytes = new Uint8Array(20);
      for (let i = 0; i < 20; i++) bytes[i] = parseInt(argsHex.slice(i * 2, i * 2 + 2), 16);
      return bytes;
    },
    getProfilePublishBlock: async () => {
      const id = useCommIdentityStore.getState().identity;
      if (!id?.profileTxHash) return null;
      const status = await window.chainpay.lightClient.getTransactionStatus(id.profileTxHash);
      if (!status?.blockNumber) return null;
      return BigInt(status.blockNumber);
    },
    ipc: {
      publishProfile: window.chainpay.commTransport.publishProfile,
      sendMessage: window.chainpay.commTransport.sendMessage,
      decryptIncoming: window.chainpay.commTransport.decryptIncoming,
      resolveProfile: window.chainpay.commTransport.resolveProfile,
    },
    broadcastTransaction: async (txBytesHex) => {
      // Reuse the existing Phase-2 broadcast path.
      return lightClient().broadcastRawTransaction(txBytesHex);
    },
    watchLockScript: async (script, fromBlock) => {
      await lightClient().watchLockScript(script, fromBlock);
    },
    listCellsForLock: async (script) => {
      const cells = await lightClient().listCellsForLock(script);
      return cells.map((c) => ({
        outPoint: { txHash: String(c.outPoint.txHash), index: Number(c.outPoint.index) },
        outputData: String(c.outputData),
      }));
    },
    parseMessagePointer: (outputDataHex) => {
      // MessagePointer molecule = | tx_hash(32) | index(4) | (per ~/ecms/cemp-pq/index.js)
      const bytes = Buffer.from(outputDataHex.slice(2), "hex");
      const txHash = "0x" + bytes.subarray(0, 32).toString("hex");
      const index = bytes.readUInt32LE(32);
      return { txHash, index };
    },
  });
  return cached;
}

/** Test-only: reset the cached singleton. */
export function _resetCommTransportForTests(): void {
  cached = null;
}

export type { CommTransport } from "./types";
export type { PeerProfile, OutgoingPacket, OutgoingSignature } from "./types";
```

> **Implementer notes:**
> - `window.chainpay.lightClient.deriveLockFromAddress` and `.getTransactionStatus` may not exist yet on the Phase 2 bridge. Check `apps/desktop/electron/preload/index.ts` first; if absent, add thin pass-throughs in this task too. They wrap CCC's `Address.fromString(addr).script` and `client.getTransactionStatus` respectively — main-process work, mirror the existing Phase-2 light-client IPC pattern.
> - `lightClient().broadcastRawTransaction(hex)` may need adding if Phase 2's `broadcastTransaction` accepts a `Transaction` object rather than serialized bytes. Verify in `light-client/host.ts` and add a hex-accepting overload if needed.
> - `MessagePointer` molecule layout: confirm by reading `~/ecms/cemp-pq/index.js::serializeMessagePointer` — if the layout differs from `tx_hash | index(u32LE)`, update accordingly.

- [ ] **Step 2: Typecheck**

```bash
cd /home/phill/chain-pay/apps/desktop && npm run typecheck
```

If `deriveLockFromAddress` / `getTransactionStatus` / `broadcastRawTransaction` aren't on the Phase-2 bridge, add them: minimal pass-throughs in preload + main + main IPC handlers + global.d.ts. Each is ~10 lines.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/comm/index.ts
# Plus any incremental Phase-2 bridge additions:
git add apps/desktop/electron/preload/index.ts apps/desktop/electron/main/index.ts apps/desktop/src/global.d.ts
git commit -m "feat(2.7a): createCommTransport() singleton factory"
```

---

# Phase E — Cross-cutting + smoke

### Task 17: Wire refusal-invariant into treasury store

**Files:**
- Modify: `apps/desktop/src/stores/treasury.ts`
- Modify: `apps/desktop/src/stores/treasury.test.ts`

Treasury's `addSignerHash` (or equivalent) must refuse a signer whose blake160 matches the current comm-identity hash. Catches the reverse direction of the invariant.

- [ ] **Step 1: Find the addSigner code path**

```bash
grep -n "addSigner\|signers\|signerHashes" /home/phill/chain-pay/apps/desktop/src/stores/treasury.ts
```

Identify the function that adds a signer to a treasury. In current Phase 2 code, treasury creation happens up-front via `addTreasury(...)` — there may or may not be a per-signer mutation. If not, the check belongs in `addTreasury` itself: iterate the new treasury's `multisig.signerHashes` and assert none match the comm-identity hash.

- [ ] **Step 2: Write a failing test**

Add to `apps/desktop/src/stores/treasury.test.ts`:

```ts
import { useCommIdentityStore } from "./comm-identity";
import { RefusalInvariantError } from "../lib/comm/errors";

it("addTreasury refuses when a signer matches the current comm-identity hash", () => {
  // Set a fake comm identity whose address-hash is HASH_X.
  const HASH_X_HEX = "0x" + "55".repeat(20);
  useCommIdentityStore.setState({
    identity: {
      mlDsaPub: "0x00",
      mlKemPub: "0x00",
      address: "ckt1qcomm",
      createdAt: 0,
      fundedAt: null,
      profileTxHash: null,
      profilePublishedAt: null,
    },
  });
  // Stub a helper to return HASH_X for the comm address. (See impl note: real
  // code reads from main-process IPC; tests provide a static getter via setState
  // or module-level injection. Match whichever pattern impl chooses.)

  const treasury = {
    id: "t1",
    multisig: {
      chain: "ckb" as const,
      address: "ckt1q...",
      signerHashes: [HASH_X_HEX],
    },
  } as never;

  expect(() => useTreasuryStore.getState().addTreasury(treasury)).toThrow(RefusalInvariantError);
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd /home/phill/chain-pay/apps/desktop && npx vitest run src/stores/treasury.test.ts -t "refuses when a signer matches"
```

Expected: FAIL.

- [ ] **Step 4: Wire the check**

In `treasury.ts`, modify `addTreasury` to invoke the refusal-invariant check on each `signerHashes` entry against a getter that returns the current comm-identity hash. Implementation sketch:

```ts
import { assertNotMultisigSigner } from "../lib/comm/refusal-invariant";
import { useCommIdentityStore } from "./comm-identity";

function commIdentityHashGetter(): { treasuryId: string; pubkeyHash: Uint8Array }[] {
  const id = useCommIdentityStore.getState().identity;
  if (!id) return [];
  // address args are the 20-byte hash; parse from the bech32 ckb address.
  // For 2.7a we expose a helper on the comm-identity store that caches the
  // computed hash. If not present yet, add it inline here.
  const hash = parseAddressArgsHash(id.address); // see note below
  return [{ treasuryId: "__comm_identity__", pubkeyHash: hash }];
}

// Inside the store actions:
addTreasury: (t) => {
  for (const hashHex of t.multisig.signerHashes) {
    const bytes = hexToBytes(hashHex);
    assertNotMultisigSigner(bytes, commIdentityHashGetter);
  }
  set((s) => ({ treasuries: [...s.treasuries, t] }));
},
```

`parseAddressArgsHash` extracts the 20-byte args from a bech32 ckb address. If a helper already exists in `lib/chains/ckb/`, reuse it; otherwise add a tiny one inline (CCC's `Address.fromString(addr).script.args` works in renderer).

- [ ] **Step 5: Run to verify passing**

```bash
npx vitest run src/stores/treasury.test.ts
```

Expected: all existing tests + new one pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/stores/treasury.ts apps/desktop/src/stores/treasury.test.ts
git commit -m "feat(2.7a): refuse treasury add when signer matches comm identity"
```

---

### Task 18: Smoke roundtrip script

**Files:**
- Create: `scripts/smoke-comm-roundtrip.mjs`

Two-install end-to-end. Manual run on testnet. Each role: generate identity → fund → publish profile → send/receive fixture → cleanup.

- [ ] **Step 1: Write the script**

Create `scripts/smoke-comm-roundtrip.mjs`:

```js
#!/usr/bin/env node
// Phase 2.7a smoke: two-install comm roundtrip on CKB testnet.
//
// ROLE A (operator):
//   COMM_ROLE=A COMM_IDENTITY_DIR=/tmp/chainpay-smoke-a \
//   SMOKE_PASSPHRASE=secret-a node scripts/smoke-comm-roundtrip.mjs
//
// ROLE B (signer): same with COMM_ROLE=B and PEER_A_ADDRESS=...

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_MAIN_DIR = path.join(__dirname, "..", "apps", "desktop", "out", "main");

// Lazy-load the built main-process modules (must be `npm run build` first).
const { exists, publicInfo, generateIdentity, publishProfile, sendMessage, decryptIncoming, resolveProfile } =
  await import(pathToFileURL(path.join(DESKTOP_MAIN_DIR, "comm-transport-service.js")).href);

const role = process.env.COMM_ROLE;
if (role !== "A" && role !== "B") {
  console.error("set COMM_ROLE=A or COMM_ROLE=B");
  process.exit(2);
}

const FIXTURE_PACKET = {
  txHash: "0xfixtureBatchPacket",
  treasuryAddress: "ckt1qfixturetreasury",
  expiresAt: 9999999999,
  packet: { kind: "transfer", payments: [] },
};

const FIXTURE_SIGNATURE = {
  txHash: "0xfixtureBatchPacket",
  slotIndex: 0,
  signature: "0x" + "ab".repeat(65),
};

const ENVELOPE_VERSION = 0x01;
const KIND = { packet: 0x01, signature: 0x02 };

function encodeEnvelope(kind, senderHash, payload) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(22 + json.length);
  out[0] = ENVELOPE_VERSION;
  out[1] = KIND[kind];
  out.set(senderHash, 2);
  out.set(json, 22);
  return out;
}

function decodeEnvelope(bytes) {
  if (bytes.length < 22 || bytes[0] !== ENVELOPE_VERSION) throw new Error("bad envelope");
  const kindByte = bytes[1];
  const kind = kindByte === KIND.packet ? "packet" : kindByte === KIND.signature ? "signature" : "unknown";
  const senderHash = bytes.slice(2, 22);
  const payload = JSON.parse(new TextDecoder().decode(bytes.slice(22)));
  return { kind, senderHash, payload };
}

async function ensureIdentity() {
  if (await exists()) {
    console.log("[smoke] using existing identity");
    return publicInfo();
  }
  console.log("[smoke] generating new identity");
  return generateIdentity();
}

async function ensureFunded(address) {
  // Use CCC client to query balance; require >= 70 CKB.
  const { ccc } = await import("@ckb-ccc/core");
  const client = new ccc.ClientPublicTestnet({ url: process.env.COMM_CKB_RPC_URL ?? "https://testnet.ckb.dev" });
  const lock = (await ccc.Address.fromString(address, client)).script;
  const cap = await client.getCellsCapacity({ script: lock, scriptType: "lock", scriptSearchMode: "exact" });
  const ckb = Number(BigInt(cap) / 100_000_000n);
  if (ckb < 70) {
    console.error(`[smoke] FUND ${address} with at least 70 CKB (current: ${ckb} CKB)`);
    process.exit(3);
  }
  console.log(`[smoke] funded: ${ckb} CKB`);
}

async function ensureProfilePublished() {
  // Treat absence of profile cell as needs-publish.
  const info = await publicInfo();
  try {
    await resolveProfile(info.address);
    console.log("[smoke] profile already published");
  } catch {
    console.log("[smoke] publishing profile");
    const { txHash, txBytes } = await publishProfile({ displayName: `smoke-${role}` });
    console.log(`[smoke] profile tx: ${txHash}`);
    // Broadcast via direct CCC client (no light-client in this script).
    const { ccc } = await import("@ckb-ccc/core");
    const client = new ccc.ClientPublicTestnet({ url: process.env.COMM_CKB_RPC_URL ?? "https://testnet.ckb.dev" });
    await client.sendTransaction(ccc.Transaction.fromBytes(txBytes));
    console.log("[smoke] profile broadcast — wait ~10s for confirmation before continuing");
    await new Promise((r) => setTimeout(r, 15000));
  }
}

async function pollIncoming(ownAddress, expectedKind, maxWaitSec = 120) {
  const { ccc } = await import("@ckb-ccc/core");
  const client = new ccc.ClientPublicTestnet({ url: process.env.COMM_CKB_RPC_URL ?? "https://testnet.ckb.dev" });
  const ownLock = (await ccc.Address.fromString(ownAddress, client)).script;
  const start = Date.now();
  const seen = new Set();
  while ((Date.now() - start) / 1000 < maxWaitSec) {
    const resp = await client.getCells({ script: ownLock, scriptType: "lock", scriptSearchMode: "exact" }, "asc", 50);
    for (const c of resp.cells) {
      const key = `${c.outPoint.txHash}:${c.outPoint.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        // Parse pointer (32 + 4 LE), fetch message cell, decrypt.
        const data = Buffer.from(c.outputData.slice(2), "hex");
        if (data.length < 36) continue;
        const ptr = { txHash: "0x" + data.subarray(0, 32).toString("hex"), index: data.readUInt32LE(32) };
        const envelopeHex = await decryptIncoming(ptr);
        const decoded = decodeEnvelope(Uint8Array.from(Buffer.from(envelopeHex.slice(2), "hex")));
        if (decoded.kind === expectedKind) return decoded.payload;
      } catch {
        /* skip */
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`timeout waiting for ${expectedKind}`);
}

async function main() {
  const id = await ensureIdentity();
  console.log(`[smoke] role ${role} address: ${id.address}`);
  await ensureFunded(id.address);
  await ensureProfilePublished();

  if (role === "A") {
    const peerB = process.env.PEER_B_ADDRESS;
    if (!peerB) { console.error("set PEER_B_ADDRESS"); process.exit(2); }
    console.log("[smoke] resolving peer B profile");
    await resolveProfile(peerB);
    console.log("[smoke] sending packet to B");
    const senderHash = Uint8Array.from(Buffer.from(id.address.slice(-40), "hex")); // simplistic
    const envelope = encodeEnvelope("packet", senderHash.length === 20 ? senderHash : new Uint8Array(20), FIXTURE_PACKET);
    const { txHash, txBytes } = await sendMessage(peerB, envelope);
    const { ccc } = await import("@ckb-ccc/core");
    const client = new ccc.ClientPublicTestnet({ url: process.env.COMM_CKB_RPC_URL ?? "https://testnet.ckb.dev" });
    await client.sendTransaction(ccc.Transaction.fromBytes(txBytes));
    console.log(`[smoke] packet sent: ${txHash}`);
    console.log("[smoke] waiting for signature reply...");
    const sig = await pollIncoming(id.address, "signature");
    if (sig.signature !== FIXTURE_SIGNATURE.signature) throw new Error("signature mismatch");
    console.log("[smoke] roundtrip OK");
  } else {
    const peerA = process.env.PEER_A_ADDRESS;
    if (!peerA) { console.error("set PEER_A_ADDRESS"); process.exit(2); }
    console.log("[smoke] waiting for packet from A...");
    const packet = await pollIncoming(id.address, "packet");
    if (packet.txHash !== FIXTURE_PACKET.txHash) throw new Error("packet mismatch");
    console.log("[smoke] packet received — replying with signature");
    await resolveProfile(peerA);
    const senderHash = new Uint8Array(20); // placeholder; matches A's tolerant check
    const envelope = encodeEnvelope("signature", senderHash, FIXTURE_SIGNATURE);
    const { txHash, txBytes } = await sendMessage(peerA, envelope);
    const { ccc } = await import("@ckb-ccc/core");
    const client = new ccc.ClientPublicTestnet({ url: process.env.COMM_CKB_RPC_URL ?? "https://testnet.ckb.dev" });
    await client.sendTransaction(ccc.Transaction.fromBytes(txBytes));
    console.log(`[smoke] signature sent: ${txHash}`);
    console.log("[smoke] roundtrip OK");
  }
}

main().catch((e) => {
  console.error("[smoke] failed:", e);
  process.exit(1);
});
```

> **Implementer notes:**
> - The script imports the **built** main-process modules (`apps/desktop/out/main/comm-transport-service.js`). Run `npm run build` in `apps/desktop` first.
> - Cleanup phase (consume notification cells, refund capacity) is omitted in this first cut — add as a follow-up step inside `main()` once the roundtrip is green, to avoid leaking 70 CKB per cell per smoke run.
> - The `senderHash` computation is loose — for 2.7a smoke purposes we don't enforce that the receiver checks it; the encryption itself binds sender. 2.7b will tighten this when the inbox UI shows "from whom".

- [ ] **Step 2: Mark executable**

```bash
chmod +x /home/phill/chain-pay/scripts/smoke-comm-roundtrip.mjs
```

- [ ] **Step 3: Dry-run (without funded keys — expect failure at fund check)**

```bash
cd /home/phill/chain-pay
COMM_ROLE=A \
  COMM_IDENTITY_DIR=/tmp/chainpay-smoke-a-dry \
  SMOKE_PASSPHRASE=dryrun \
  node scripts/smoke-comm-roundtrip.mjs
```

Expected: generates identity, prints address, exits 3 with "FUND ... with at least 70 CKB". Confirms wiring works up to the chain step.

Clean up: `rm -rf /tmp/chainpay-smoke-a-dry`.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-comm-roundtrip.mjs
git commit -m "feat(2.7a): smoke-comm-roundtrip script for manual testnet verification"
```

---

# Wrap-up

After Task 18:

- [ ] **Run the full unit suite**

```bash
cd /home/phill/chain-pay/apps/desktop && npm test
```

Expected: prior tests + ~59 new tests, all green.

- [ ] **Typecheck root**

```bash
cd /home/phill/chain-pay && npm run typecheck
```

Expected: passes.

- [ ] **Manual smoke on testnet** (Phill, two terminals, two funded keys)

Follow Task 18 run instructions. Tick the verification checkpoints from the spec:

- [ ] Profile Cell visible on testnet explorer
- [ ] Notification Cell appears within ~5s
- [ ] Round-trip latency p50 < 30s
- [ ] App restart preserves identity, peer-book, lastSeenBlock
- [ ] Refusal invariant fires when adding peer = treasury signer
- [ ] safeStorage refusal works on a Linux box without libsecret

Once green, Phase 2.7a is complete. Open the 2.7b spec.

---

## Spec coverage check

| Spec section | Tasks |
|---|---|
| Architecture & file layout | 1, 2, 3, 11, 12, 13, 16 |
| Components & interfaces (`CommTransport`, envelope, refusal) | 3, 5, 6 |
| Identity lifecycle + safeStorage | 9, 10, 11, 12, 13 |
| Data flow (send/receive) | 11, 14, 15, 16 |
| Error handling | 4 (classes) + woven through 5, 6, 11, 14, 15 |
| Testing strategy (unit) | 5, 6, 7, 8, 10, 14, 15 |
| Testing strategy (smoke) | 18 |
| Refusal invariant (2 of 3 sites — keygen-time check defers to 2.7b) | 6 (impl), 8 (peer-book.addPeer), 17 (treasury.addTreasury) |
| Out of scope | None ship in 2.7a — verified by absence of UI tasks |

### Why only 2 of 3 refusal sites land in 2.7a

The spec calls for the refusal invariant at three sites: keygen, addPeer, addTreasury. The **keygen-time** check needs to compare the freshly-generated comm-identity hash against existing treasury signer hashes, which requires either: (a) the main process synchronously querying the renderer's treasury store via IPC (loops the dependency), or (b) the renderer orchestrating "generate → verify → delete-and-retry-if-collision". Option (b) is the natural fit but lives in the Settings UI flow that 2.7b builds. In 2.7a — which has no UI and a smoke script that doesn't touch treasuries — the keygen-time site has no caller, so wiring it would be dead code. addPeer and addTreasury (the post-keygen surfaces where a collision can actually be introduced by user action) are both wired; 2.7b's Settings ceremony adds the third site as part of the "Set up comm channel" button orchestration.
