# Single-Sig JoyID Sending — Design

**Date:** 2026-06-25
**Status:** Approved (brainstorming)
**Branch:** `feat/single-sig-joyid-send`

## Problem

ChainPay's only working payment path is the **multisig treasury** flow: a co-signer
relay where an operator builds a tx skeleton, encodes a transfer-packet, distributes
it to M-of-N co-signers, each signs a digest, and partial signatures are merged into
a `secp256k1_blake160_multisig_all` witness before broadcast.

Small/medium businesses typically pay from a **single wallet source**, not an M-of-N
treasury. They need standard single-signer sending without the coordination overhead.

## Goals

- Let an SMB pay one or more payees from a single **JoyID-controlled CKB wallet**.
- Honor the project's hard rules: never custody keys (#1), light-client-first (#2),
  adapters stay adapters (#3), every confirmed payment posts a journal entry (#5).
- Build the ad-hoc **Send** feature now; design the data model so payroll/invoice
  flows can adopt a single-sig source **later** with no rework ("design-for, don't
  build").

## Non-Goals (this slice)

- No EVM / MetaMask single-sig (EVM adapter is still a stub).
- No keystore or Ledger single-sig — JoyID only.
- **No changes to payroll or invoice payment flows.** They keep taking a `Treasury`.
  The shared `FundableAccount` type is introduced so they *can* widen later.
- No multi-source batching (a Send draws from exactly one Source).

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Chain + wallet | **CKB + JoyID live wallet** (key never touches ChainPay) |
| Operations | Ad-hoc **Send** feature now; payroll/invoice adoption designed-for, not built |
| Data model | New **`sources`** store, separate from treasuries; shared **`FundableAccount`** seam |
| Accounting | **In scope for this slice** — confirmed sends post a balanced JE via the Phase-5 bridge |
| JoyID transport | **CCC JoyID signer (option A)**; `joyid-ckb-connector` redirect-relay as fallback |

## Architecture

A new parallel payment path — **not** a modification of the multisig pipeline:

```
select Source → add payees+amounts → build unsigned tx
   → JoyID popup signs whole tx → broadcast → confirm → post JE
```

The JoyID lock is its own on-chain lock (WebAuthn-verified), **not**
`secp256k1_blake160`. The Source address comes straight from JoyID's connect call —
ChainPay derives no key material and holds nothing. Because JoyID signs a *whole
transaction* (not a bare digest), single-sig deliberately bypasses the
digest→partial-sig→merge machinery, which exists only to coordinate M parties.

Reused unchanged:
- Embedded light client: `watchLockScript`, `listCellsForLock`, `getLockBalance`,
  `getTransactions`, `broadcastTransaction` (routes through the Settings full-node
  RPC, avoiding the "broadcast into the void" light-client relay issue).
- Phase-5 accounting bridge: `batch-to-journal-inputs` + `post-batch-journal`.

New external dependency: the JoyID CKB signer (connector package; `@ckb-ccc/core`
alone does not include it).

## Components

### 1. Data model

```ts
// packages/shared/src/funding.ts  (new)
export interface FundableAccount {
  id: string;
  label: string;
  chain: ChainId;
  address: string;          // ckb1.../ckt1...
  lockKind: "ckb-multisig" | "ckb-joyid-single";
  capabilities: { coSign: boolean };   // multisig=true, single-sig=false
}

// stores/sources.ts  (new) — kept separate from treasuries
export interface Source extends Identified, Timestamped {
  label: string;
  chain: "ckb:mainnet" | "ckb:testnet";
  address: string;          // JoyID address from connect
  joyidLockArgs: Hex20;     // for watchLockScript + change output
  notes?: string;
}
```

`Treasury` and `Source` both satisfy `FundableAccount` via thin adapters
(`treasuryAsFundable`, `sourceAsFundable`). The Send feature consumes a `Source`.
When payroll/invoice later adopt single-sig, they widen their input from `Treasury`
to `FundableAccount` — no model rework.

The `sources` store mirrors the `treasury` store shape (zustand + persist), persisted
under `chain-pay:sources`. No bigint fields (unlike Treasury's `since`), so plain JSON.

### 2. Signing — JoyID transport

JoyID whole-tx signing does not fit `SignerTransport` (digest → 65 bytes). New
single-purpose interface:

```ts
// lib/signers/ckb-tx-signer.ts (new)
export interface CkbTxSigner {
  readonly kind: "joyid";
  connect(): Promise<{ address: string; lockArgs: Hex20 }>;
  signTransaction(unsigned: Transaction): Promise<Transaction>;  // broadcast-ready
}
```

**Electron mechanism (primary integration risk):**
- **(A — chosen)** CCC JoyID signer via the CCC connector package, popup mode.
  Standard, maintained, handles witness + cellDep. Risk: JoyID popup/redirect must
  work inside an Electron `BrowserWindow` with a whitelisted redirect URL.
- **(C — fallback)** Vendor in the proven `joyid-ckb-connector` redirect-relay
  (from the byterent-ui testnet work) if the Electron popup fights us.

The rest of the design is unchanged regardless of mechanism — only `CkbTxSigner`'s
body differs. The existing `SignerKind` already declares `"joyid"`; this slice
activates it for **single-sig only** (never multisig).

### 3. Transaction building (light-client-first)

`lib/chains/ckb/single-sig-tx-builder.ts` (new), mirroring `buildPaymentSkeleton`
(explicit inputs from the light client, manual change/fee — **not** a public CCC
collector, honoring hard-rule #2):

1. `listCellsForLock(joyidLock)` → candidate inputs.
2. Build payee outputs; **validate each output ≥ min cell capacity** (secp recipients
   need ~61 CKB — the −302 `InsufficientCellCapacity` trap).
3. Change output back to the Source's JoyID lock.
4. Add the **JoyID lock cell_dep** and **pad witness[0]** in the caller *before* fee
   completion (JoyID under-counts ~560 B on transfers; `signer.prepareTransaction` is
   unreliable across CCC's clone path — both lessons from the feedback log).
5. Fee from the Settings fee rate; broadcast via `host.broadcastTransaction`.

Known JoyID traps (all documented in `~/.claude/rules/ckb-transactions.md` feedback
log) are applied here, not rediscovered: witness padding, the lock cell_dep, and the
recipient min-capacity floor.

### 4. Send record + state machine

`stores/sends.ts` (new). A lean cousin of the payroll state machine, minus all
co-signer states:

```
draft → built → signing → broadcasted → confirmed → posted | post_failed
```

A `SendRecord` holds: id, sourceId, outputs (payee + amount), fee, txHash (once
broadcast), state, timestamps, and accounting fields (`journalEntryName`,
`postError`). Persisted under `chain-pay:sends`.

### 5. Accounting (in scope)

On transition to `confirmed`, a confirmation→accounting hook posts a balanced Journal
Entry reusing the Phase-5 bridge (`batch-to-journal-inputs` + `post-batch-journal`),
producing `posted` or `post_failed` (with Retry), mirroring the payroll-batch posting
already shipped in Slice C. The send's `crypto_batch_id` idempotency anchor is the
`SendRecord.id`.

### 6. UI

`features/send/`:
- `SourceList.tsx` — connect/add a JoyID wallet (calls `CkbTxSigner.connect`,
  registers the lock via `watchLockScript`, persists a `Source`), shows balances.
- `SendPanel.tsx` — pick source, add payees + amounts, review (fee + min-capacity
  validation), sign via JoyID, broadcast.
- `SendHistory.tsx` — `SendRecord` list with state, txHash, and posted/Retry.

## Data flow

```
SendPanel
  → single-sig-tx-builder.build(source, outputs, feeRate, lightClient)
  → CkbTxSigner.signTransaction(unsignedTx)         [JoyID popup]
  → host.broadcastTransaction(signedTx)             [full-node RPC]
  → sends store: built → broadcasted
  → light client getTransactions poll → confirmed
  → confirmation→accounting hook → post-batch-journal → posted | post_failed
```

## Error handling

- **Build:** insufficient balance, output below min cell capacity, no spendable cells
  → surfaced in `SendPanel` before signing; no tx leaves draft.
- **Signing:** JoyID popup cancelled / rejected / timeout → return to `built`, no
  broadcast.
- **Broadcast:** RPC error / pool rejection → return to `built` (no `txHash`
  recorded), surface the node error verbatim; never silently swallow.
- **Accounting:** backend-down or balance mismatch → `post_failed` with Retry
  (reuses Slice C behavior).

## Testing (TDD)

Unit tests written first, per task:
- `single-sig-tx-builder`: input selection, change, fee, witness-padding present,
  JoyID cell_dep present, recipient min-capacity rejection.
- `sends` store + state machine: legal/illegal transitions; persistence round-trip.
- `FundableAccount` adapters: `treasuryAsFundable` / `sourceAsFundable` shape parity.
- `sources` store: add/remove/select; persistence.
- Accounting hook: confirmed → post; balance/idempotency via mocked bridge.

JoyID signing is mocked behind `CkbTxSigner` (the real popup is manual-smoke,
consistent with how keystore signing is tested today). A manual testnet smoke
playbook covers the live JoyID round-trip and on-chain confirmation.

## Security review triggers

This slice touches tx construction and JoyID wallet integration. Security review
before merge (per project rules): JoyID redirect-URL whitelisting, no key material in
renderer/main, broadcast RPC trust, and output/amount validation at the boundary.

## Open risk

JoyID popup/redirect behavior inside Electron is the one unproven piece. Mitigation:
option-A CCC signer first; fall back to the proven `joyid-ckb-connector` redirect-relay
if needed. Decision deferred to the first JoyID integration task.
