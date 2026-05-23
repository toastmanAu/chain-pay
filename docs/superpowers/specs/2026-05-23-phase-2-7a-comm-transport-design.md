# Phase 2.7a — Comm Transport Design

**Status:** Design, awaiting plan. Brainstormed 2026-05-23.
**Owner:** Phill.
**Supersedes/relates to:** `docs/comm-channel-design.md` (original PSK-based proposal, mostly obsolete — see addendum). This spec covers the **2.7a** slice only; 2.7b (UI + PayrollBatch wire-up) gets its own spec after 2.7a lands.

## What 2.7a ships

A working CEMP-PQ-backed `CommTransport` for ChainPay: identity keygen + Profile Cell publish + send + receive + smoke-script verification. **No UI changes.** All verbs exposed via main-process IPC so the renderer never touches secret keys or imports `cemp-pq` directly. Verified end-to-end by a manual two-install smoke script.

## What 2.7a explicitly does NOT ship

UI surfaces (Settings ceremony, inbox, PayPanel send button), PayrollBatch auto-merge, ack emission, cell consumption, address rotation, forward secrecy, automated CI smoke. All deferred to 2.7b+ — see Section 7.

## Why this shape

Five decisions locked during brainstorming, each with explicit alternatives considered:

1. **MVP tier:** "+ Inbox/auto-match UI" overall — but split so 2.7a is transport-only, verified by smoke; 2.7b adds UI + auto-merge.
2. **Seam:** `CommTransport` interface in `apps/desktop/src/lib/comm/types.ts`. Mirrors `ChainAdapter` / `SignerTransport` pattern. Honors `CLAUDE.md` hard rule #3 ("adapters stay adapters").
3. **Packaging:** vendor CEMP-PQ as `packages/cemp-pq` in workspaces. Single source of truth for the ChainPay build; upstream `~/ecms/cemp-pq` stays as the protocol's home and we merge from it.
4. **Key storage:** Electron `safeStorage` (OS keychain — libsecret / Keychain / DPAPI). Stolen disk image alone doesn't expose the ML-DSA secret.
5. **Security boundary:** main process owns CEMP-PQ end-to-end. Renderer calls verbs (`sendMessage`, `publishProfile`, `decryptIncoming`) — never sees secret keys, never builds the comm-wallet's CKB transactions. Compromised renderer can dust-spam peers and impersonate; cannot drain funds because no fund-transfer verb exists.

Integration shape: **A — domain-aware transport, lazy watcher, explicit setup gesture.** Generic-bus alternative (B) rejected as YAGNI per `CLAUDE.md` ("don't design for hypothetical future requirements").

## Architecture & file layout

```
chain-pay/
├── packages/
│   └── cemp-pq/                         # NEW. Vendored from ~/ecms/cemp-pq.
│       ├── index.js                     # ML-DSA helpers, serializers
│       ├── tx-builder.js                # MLDSASigner, CEMPTransactionBuilder
│       ├── schemas/                     # .mol files
│       ├── index.d.ts                   # NEW. Hand-written TS surface (~50 lines).
│       └── package.json                 # name: "cemp-pq"
│
├── apps/desktop/
│   ├── electron/main/
│   │   ├── index.ts                     # MODIFIED: register comm-identity + comm-transport IPC
│   │   ├── comm-identity-store.ts       # NEW. safeStorage encrypt/decrypt + atomic disk I/O.
│   │   ├── comm-transport-service.ts    # NEW. Owns CEMPTransactionBuilder + MLDSASigner usage.
│   │   ├── safe-storage.ts              # NEW. SafeStorageProvider abstraction for smoke fallback.
│   │   └── comm-identity-store.test.ts
│   │
│   ├── electron/preload/
│   │   └── index.ts                     # MODIFIED: expose chainpay.commIdentity + chainpay.commTransport
│   │
│   └── src/
│       ├── lib/comm/                    # NEW.
│       │   ├── types.ts                 # CommTransport, PeerProfile, OutgoingPacket, OutgoingSignature
│       │   ├── envelope.ts              # version|kind|sender_hash|payload codec
│       │   ├── envelope.test.ts
│       │   ├── errors.ts                # typed error classes
│       │   ├── refusal-invariant.ts     # assertNotMultisigSigner(pubkeyHash)
│       │   ├── refusal-invariant.test.ts
│       │   ├── cemp-pq/
│       │   │   ├── transport.ts         # CempPqCommTransport — thin wrapper over IPC
│       │   │   ├── transport.test.ts
│       │   │   ├── watcher.ts           # listCellsForLock loop, Notification→Message fetch
│       │   │   └── watcher.test.ts
│       │   └── index.ts                 # createCommTransport() lazy singleton
│       │
│       └── stores/
│           ├── comm-identity.ts         # NEW. Zustand: public half only.
│           ├── comm-identity.test.ts
│           ├── peer-book.ts             # NEW. Zustand persisted.
│           └── peer-book.test.ts
│
└── scripts/
    └── smoke-comm-roundtrip.mjs         # NEW. Two-install end-to-end verification.
```

Six new renderer modules + two new main-process modules + two stores + one smoke script + one vendored workspace package. All TypeScript source files target the existing `<300 line` / `<50-line function` budget.

## Components & interfaces

### `lib/comm/types.ts` — the seam

```ts
export interface PeerProfile {
  address: string;              // ckb-mldsa-lock address
  mlDsaPubKey: Uint8Array;      // 1952 bytes
  mlKemPubKey: Uint8Array;      // 1184 bytes
  metadata?: { displayName?: string };
  fetchedAt: number;            // epoch ms
}

export interface OutgoingPacket {
  txHash: string;               // batch id this packet relates to
  treasuryAddress: string;
  expiresAt: number;            // epoch s
  packet: TransferPacket;       // existing type from packages/shared
}

export interface OutgoingSignature {
  txHash: string;
  slotIndex: number;
  signature: string;            // 0x-prefixed secp65
}

export type CommEnvelopeKind = 'packet' | 'signature' | 'ack';

export interface CommTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;

  publishProfile(metadata?: { displayName?: string }): Promise<string>;
  resolveProfile(address: string): Promise<PeerProfile>;

  sendPacket(peer: PeerProfile, body: OutgoingPacket): Promise<string>;
  sendSignature(peer: PeerProfile, body: OutgoingSignature): Promise<string>;

  onIncomingPacket(handler: (from: string, body: OutgoingPacket) => void): () => void;
  onIncomingSignature(handler: (from: string, body: OutgoingSignature) => void): () => void;
}
```

### `lib/comm/envelope.ts` — on-wire format inside the encrypted box

```
| version (1) | kind (1) | sender_addr_hash (20) | json_payload (variable)
```

`kind` byte stays **inside** the AES-GCM ciphertext — observers can't distinguish packet from signature traffic. Privacy outranks the routing-cost savings of exposing it.

### `lib/comm/refusal-invariant.ts`

```ts
export function assertNotMultisigSigner(pubkeyHash: Uint8Array): void;
```

Called at **three** defense-in-depth sites:

1. **Comm-identity keygen** — refuse to save a freshly-derived ML-DSA blake160 if it collides with any known treasury signer.
2. **`peer-book.addPeer()`** — refuse to add a peer whose address resolves to a known multisig signer.
3. **`treasury.addSignerHash()`** — refuse to add a multisig signer matching the current comm-identity hash (catches the reverse direction).

### Main-process IPC surface (preload bridge)

```ts
window.chainpay.commIdentity = {
  exists(): Promise<boolean>;
  publicInfo(): Promise<{ mlDsaPub, mlKemPub, address, createdAt } | null>;
  generate(): Promise<{ mlDsaPub, mlKemPub, address, createdAt }>;
  delete(): Promise<void>;
};

window.chainpay.commTransport = {
  publishProfile(metadata): Promise<{ txHash, txBytes }>;
  sendMessage(recipientAddress, envelopeBytes): Promise<{ txHash, txBytes }>;
  decryptIncoming(messageOutPoint): Promise<Uint8Array>;
  resolveProfile(address): Promise<PeerProfile>;
};
```

**No method returns a secret key to the renderer.** Main-process `withSecrets<T>(use)` pattern: decrypt → run callback → zero the buffer.

### Persisted stores (renderer)

```ts
// stores/comm-identity.ts — non-secret half only
interface CommIdentityState {
  mlDsaPub: string;
  mlKemPub: string;
  address: string;
  createdAt: number;
  fundedAt: number | null;
  profileTxHash: string | null;
  profilePublishedAt: number | null;
}

// stores/peer-book.ts
interface Peer {
  nickname: string;
  address: string;
  cachedProfile?: PeerProfile;
  pairedAt: number;
}
```

## Data flow

### Send packet (operator → signer)

1. `transport.sendPacket(peer, body)`
2. Ensure `peer.cachedProfile` is fresh (TTL: 1h); refresh via `resolveProfile` if stale.
3. `envelope.encode({ version:1, kind:'packet', sender_addr_hash, payload })` → bytes.
4. `window.chainpay.commTransport.sendMessage(peer.address, envelopeBytes)` — main process: ML-KEM encapsulate → AES-GCM encrypt → CEMPTransactionBuilder.buildSendMessageTx → MLDSASigner.signOnlyTransaction → return `{ txHash, txBytes }`.
5. Renderer calls `lightClientHost.broadcastTransaction(txBytes)` via the full-node RPC override path that landed Phase 2.
6. Transport caches `{ txHash, kind, peer, sentAt }` in local state for future ack matching (2.7b).

### Receive

1. `App.tsx` boot → if `commIdentity` exists → `transport.start()`.
2. On `start()`: if `lastSeenBlock` unset, resolve via `getTransactionStatus(profileTxHash)` to seed from profile-publish block — backfill from there.
3. `watcher`: `lightClientHost.watchLockScript(ownMldsaLock)` (existing API).
4. On poll tick: `listCellsForLock(ownMldsaLock)` → new Notification Cells.
5. For each new cell: decode `MessagePointer` → fetch Message Cell via `getCell(outPoint)` → `commTransport.decryptIncoming(outPoint)` (main process does ML-KEM decap + AES decrypt) → renderer parses envelope.
6. Dispatch by `kind`: `onIncomingPacket` / `onIncomingSignature` handlers (2.7b consumers); unknown kinds logged and dropped.
7. Mark cell as processed in transport state (keyed by outPoint).

### Transport-state persistence

```ts
// localStorage: "chainpay:comm:transport-state"
{
  lastSeenBlock: number,
  processedCells: Record<outPoint, processedAt>,
  sentMessages: Record<txHash, { peer, kind, sentAt, ackedAt? }>,
}
```

Pruned: `processedCells` >30 days, `sentMessages` >7 days or on ack.

## Identity lifecycle & safeStorage

### `electron/main/comm-identity-store.ts`

```ts
import { safeStorage } from 'electron';
// File: <userData>/comm-identity.enc — encrypted blob, never plaintext on disk.

export async function loadCommIdentity(): Promise<EncryptedIdentity | null>;
export async function saveCommIdentity(plaintext: PlainIdentity): Promise<void>;  // atomic temp+rename
export async function deleteCommIdentity(): Promise<void>;

// Hot path:
export async function withSecrets<T>(
  use: (secrets: { mlDsaSec: Uint8Array; mlKemSec: Uint8Array }) => Promise<T>
): Promise<T>;
```

### `electron/main/safe-storage.ts` — abstraction for smoke

```ts
export interface SafeStorageProvider {
  encrypt(s: string): Buffer;
  decrypt(b: Buffer): string;
  isAvailable(): boolean;
}
export function getSafeStorage(): SafeStorageProvider {
  // Returns Electron-backed provider when running inside Electron;
  // PBKDF2+AES file-passphrase provider when SMOKE_PASSPHRASE env is set (smoke only).
}
```

This abstraction is what lets `comm-identity-store` be importable in plain Node for the smoke script — otherwise `import 'electron'` would blow up outside Electron.

### Setup ceremony (verbs land in 2.7a; UI in 2.7b)

```
generate() → safeStorage save → refusal-invariant check → return public info
            ↓
[user manually funds derived address with ~50 CKB from another wallet]
            ↓
publishProfile(metadata) → buildCreateProfileTx + sign + return txBytes
            ↓ renderer broadcasts via lightClientHost
            ↓ on confirmation: persist profileTxHash + profilePublishedAt
            ↓
transport.start() → seed lastSeenBlock from profileTxHash block → watch loop on
```

## Error handling & failure modes

### `lib/comm/errors.ts`

```ts
export class CommNotConfiguredError extends Error {}
export class CommNotFundedError extends Error {}
export class ProfileNotFoundError extends Error {}
export class ProfileStaleError extends Error {}
export class RefusalInvariantError extends Error {}
export class DecryptionFailedError extends Error {}
export class EnvelopeMalformedError extends Error {}
export class CellGoneError extends Error {}
```

### Failure matrix

The "UI: ..." entries describe the downstream contract 2.7b will consume — 2.7a's deliverable is the typed throw + the bubble path, not the UI surface.

| Scenario | Detection | Behavior |
|---|---|---|
| `sendPacket` before identity exists | renderer checks `commIdentity.exists()` first | UI: redirect to setup; no IPC call |
| Identity exists, unfunded (<70 CKB) | main: pre-check balance via LC | throw `CommNotFundedError`; UI surfaces fund-this-address |
| Recipient has no Profile Cell | `fetchRecipientProfile` returns null | throw `ProfileNotFoundError`; surface to UI |
| Profile Cell malformed | molecule unpack throws | throw `ProfileNotFoundError` with cause |
| Notification → Message Cell consumed | `getCell(messageOutPoint)` returns null | throw `CellGoneError`; mark notification dead in transport state; log + skip |
| AES-GCM tag mismatch on incoming | `decryptIncoming` throws | **silently drop**: log + mark `decrypt-failed`; do NOT propagate to UI |
| Envelope version > 1 | `envelope.decode` throws | log + skip |
| LC broadcast fails | existing P2 broadcast returns error | bubble to caller; manual retry in 2.7a |
| Refusal-invariant collision at keygen | `assertNotMultisigSigner` throws | abort generate(); UI: specific reason + remediation |
| Refusal-invariant collision at addPeer | same | refuse peer add; UI: explanation |
| `safeStorage.isEncryptionAvailable()` false | platform check at startup | refuse to generate identity; platform-specific guidance |
| Disk full on save | `fs.writeFile` throws | atomic write via temp+rename means partial state impossible; bubble error |

### Two policy decisions

- **Failed-decrypt cells are silently dropped.** Surfacing every failed decrypt would weaponize them into a notification-spam vector — attackers can write arbitrary cells to your lock. Legitimate failure (peer rotated keys) is rare; "ask sender to resend" is acceptable UX.
- **No automatic retry on broadcast failure in 2.7a.** Caller (renderer) gets the error and decides. 2.7b's PayrollBatch state machine adds retry with backoff.

### Logging

Pubkey hashes only — never plaintext payloads, never secret material. Renderer logs via existing pattern; main logs to Electron main log.

## Testing strategy

### Unit tests (Vitest)

| File | Count | Focus |
|---|---|---|
| `lib/comm/envelope.test.ts` | ~12 | Roundtrip per kind, version/kind validation, truncation, field lengths |
| `lib/comm/refusal-invariant.test.ts` | ~8 | Treasury-collision detection across active/inactive treasuries, byte-equality semantics |
| `lib/comm/cemp-pq/transport.test.ts` | ~15 | publishProfile, sendPacket, sendSignature, resolveProfile caching/invalidation, watcher dispatch/dedup/silent-drop, start()/stop() lifecycle |
| `lib/comm/cemp-pq/watcher.test.ts` | covered above | (merged into transport.test.ts) |
| `stores/comm-identity.test.ts` | ~8 | Persist/rehydrate (public fields only), refuse-overwrite, clear() triggers IPC delete |
| `stores/peer-book.test.ts` | ~10 | CRUD + refusal-invariant + cache TTL + persist |
| `electron/main/comm-identity-store.test.ts` | ~6 | safeStorage roundtrip (mocked), load returns null when absent, withSecrets zeros buffer, refuse-on-exists, atomic write |

**Target:** ~59 new tests. Project total reaches ~226. Coverage ≥80% per global rule.

### Mock patterns

- `vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true, encryptString, decryptString } }))` for main-process tests.
- `LightClientHost` mocked at the interface level for transport tests.
- IPC bridge mocked for renderer-side tests.

### Smoke script (`scripts/smoke-comm-roundtrip.mjs`)

Two-install end-to-end on testnet. Manual-run only. Lives alongside `make-smoke-treasury.mjs`.

```bash
# Role A (operator)
COMM_ROLE=A \
COMM_IDENTITY_DIR=/tmp/chainpay-smoke-a \
COMM_CKB_PRIVKEY=$CKB_TESTNET_FUNDING_KEY_A \
SMOKE_PASSPHRASE=$SMOKE_PASSPHRASE_A \
node scripts/smoke-comm-roundtrip.mjs

# Role B (signer)
COMM_ROLE=B \
COMM_IDENTITY_DIR=/tmp/chainpay-smoke-b \
COMM_CKB_PRIVKEY=$CKB_TESTNET_FUNDING_KEY_B \
SMOKE_PASSPHRASE=$SMOKE_PASSPHRASE_B \
PEER_A_ADDRESS=ckt1q... \
node scripts/smoke-comm-roundtrip.mjs
```

Per role:

1. Load or generate identity (uses `safe-storage.ts` abstraction with `SMOKE_PASSPHRASE` provider).
2. Derive comm address; if balance < 70 CKB, exit with funding instructions.
3. Publish Profile Cell if not yet published.
4. **Role A:** `resolveProfile(B)` → `sendPacket(B, fixturePacket)` → watch for incoming signature → assert payload matches. `fixturePacket` is inline-defined in the smoke script — fixed `txHash`, dummy TransferPacket, deterministic for assertion.
5. **Role B:** watch for incoming packet → assert payload roundtrip → `sendSignature(A, fixtureSignature)`. `fixtureSignature` similarly inline — fixed slot, deterministic 65-byte hex string.
6. **Cleanup phase:** consume any Notification Cells received and surplus comm-wallet capacity, refund to funding-key address. Failures here log but don't fail the smoke; next run picks up.
7. Both sides exit 0 on success.

**Manual verification checkpoints** (tick during 2.7a smoke run):

- [ ] Identity generation refused when `safeStorage.isEncryptionAvailable()` returns false
- [ ] Profile Cell visible on testnet explorer at expected address
- [ ] Notification Cell appears at recipient's lock within ~5s of broadcast
- [ ] Round-trip latency p50 < 30s on testnet
- [ ] Network tap shows ciphertext only — no plaintext envelope kind byte leaks
- [ ] Refusal invariant fires when adding peer = known treasury signer
- [ ] App restart preserves: identity, peer book, lastSeenBlock cursor, processedCells dedup
- [ ] Smoke script idempotent — runs cleanly twice in a row without duplicate profile publish

Canonical regression target for 2.7a, same role `make-smoke-treasury.mjs` plays for Phase 2.

## Out of scope (2.7b and beyond)

### Deferred to 2.7b (next spec, after 2.7a lands)

- Settings UI for comm-channel setup ceremony (button, modals, funding poll, "Publish profile" gesture)
- PayPanel "Send to signers via comm" button + state
- SignPanel inbox surface
- PayrollBatch state machine wire-up — auto-match signatures, merge-ready when M arrive
- Peer book CRUD UI
- `ack` emission + retry/backoff
- Clipboard packet/signature flow demoted to "debug fallback" toggle

### Deferred further

- Notification Cell consumption (capacity recovery) — wait for upstream CEMP-PQ Receipts
- Address rotation (HKDF chain per session) — envelope-level concern, not CEMP-PQ change
- Forward secrecy / double ratchet
- Multi-device sync for one user's comm identity
- Group messaging beyond pairwise
- PQC migration for comm-wallet lock script (already PQC via ckb-mldsa-lock — covered)

### Explicit non-goals for whole 2.7 family

- Anonymity against network observer (no Tor/i2p)
- Coercion resistance
- Cell-level type-script validator for envelope shape

### Adjacent upstream work — invoice ingestion

Phill drafted an Invoice Ingestion plan in the vault on 2026-05-22 (`~/Documents/loacal-vault/Projects/ChainPay/Invoice Ingest — Manual Upload Plan.md`, schema at `schemas/invoice-extraction-v0.schema.json` v0.1.0). It's **upstream** of the comm channel, not parallel — both flows converge at `PayrollBatch`. An invoice-derived batch produces the same `TransferPacket` shape as a manually-built one, so the comm channel's `OutgoingPacket.packet: TransferPacket` typing is forward-compatible without changes. Phase 1 of invoice ingestion triggers at ChainPay Phase 3-ish; no design coupling required for 2.7a.

### Known upstream blockers (track separately, not in 2.7a scope)

- `CEMP_PQ_PROFILE_CODE_HASH = 0x…01` is a placeholder in `~/ecms/cemp-pq/index.js`. Discovery currently falls back to a data-length heuristic (`outputData.length > 3000`). 2.7a ships using this heuristic on testnet only. Before 2.7b touches mainnet, the real Profile Cell type-script must be finalised, deployed, and the constant updated.
- `Receipt` table exists in CEMP-PQ schema but `buildSendMessageTx` doesn't issue them. `ack` emission in 2.7b will need either upstream Receipts or our own ack envelope kind layered on top.

## References

- Original comm-channel design: `docs/comm-channel-design.md`
- CEMP-PQ upstream: `~/ecms/cemp-pq/`
- Phase 2 light-client API: `apps/desktop/src/lib/light-client/host.ts` (`watchLockScript`, `listCellsForLock`, `broadcastTransaction`)
- Phase 2 broadcast routing: Settings → "Transaction broadcast RPC URL" override (full-node RPC at `.134:8114`)
- ML-DSA witness sizing: `~/ecms/cemp-pq/tx-builder.js` (5300-byte WitnessArgs reservation)
- ChainPay hard rules: `~/chain-pay/CLAUDE.md`
- CKB transaction traps: `~/.claude/rules/ckb-transactions.md`
- Invoice ingestion (adjacent upstream): `~/Documents/loacal-vault/Projects/ChainPay/Invoice Ingest — Manual Upload Plan.md`
