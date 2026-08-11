# Consolidation refactor — design

**Date:** 2026-08-11
**Branch:** `feat/consolidation-refactor`
**Status:** approved (brainstorming → spec)

## Problem

Between 2026-07-30 and 2026-08-06 the chain roster went from two (CKB, EVM) to four
(+ BTC, + SOL) across ten commits. The adapter seams held — chain code stayed in
`lib/chains/`, features stayed chain-agnostic, each chain got its own accounting mapper —
but three modules absorbed the growth instead of splitting, and chain knowledge leaked
into places that are supposed to be chain-agnostic.

### 1. Backend chain knowledge is smeared across ~15 branch sites

`apps/backend/apps/crypto_payroll/crypto_payroll/api/__init__.py` is 690 lines.
`_normalise_record` alone spans lines 132–401 and branches on chain at six points:

| Site | Branch |
|---|---|
| `api/__init__.py:150,152` | `chain.startswith("sol:")` / `("btc:")` — tx-hash shape |
| `api/__init__.py:206` | max native units (`_U64_MAX` / `_MAX_BTC_SATS`) |
| `api/__init__.py:213–214` | asset + decimals (`ETH`/18, `SOL`/9, `BTC`/8, `CKB`/8) |
| `api/__init__.py:237,284,334` | per-chain evidence blocks (evm / solana / bitcoin) |
| `api/__init__.py:642,647` | `post_journal` review-digest handling |
| `compliance.py:213,227,243,291,313,316,320` | per-chain compliance rows and fee fields |

Adding chain #5 means locating all fifteen. The supported-chain allowlist at
`api/__init__.py:147` is a separate hardcoded set, so registering a chain and actually
supporting it are two independent edits that can silently disagree.

### 2. Two frontend files past the 800-line rule, for opposite reasons

- **`TreasuryDetail.tsx` (930 lines)** — *accretion*. `CkbTreasuryDetail`,
  `EvmTreasuryDetail`, `BitcoinWatchDetail`, and `SolanaWatchDetail` are already four
  independent components sharing one file, plus ~15 formatters. Nothing is entangled;
  it is four things in one drawer.
- **`PayPanel.tsx` (1181 lines)** — *entanglement*. One component, 15 `useState` atoms,
  three `useEffect`s, a ~630-line body, and **zero test files reference it**. It builds
  CKB multisig payment transactions, including `assertMultisigBytesMatchTreasury`, which
  is a security check with no test coverage.

### 3. Duplicated formatters, one of which disagrees with itself

```
formatCkb()             ×3 — SignPanel:237, PayPanel:1174, TreasuryDetail:900
shannonsToCkbDisplay()  ×1 — PayPanel:977   same conversion, NO thousands separators
Tile()                  ×3 — Dashboard:182, TreasuryDetail:866, SafeApprovalDetail:495
chainBadge()            ×2 — TreasuryList:137, TreasuryDetail:921
```

The three `formatCkb` copies are behaviourally identical. `shannonsToCkbDisplay` is not:
PayPanel renders the same quantity as `1,234.5` or `1234.5` depending on which call site
is hit.

### 4. The backend safety net is wired to the wrong command

```
bench run-tests --module crypto_payroll.test_api  → Ran 28 tests ... OK  (0.98s)
bench run-tests --app crypto_payroll              → Ran 4 tests  ... OK  (0.02s)
```

App-level discovery finds only `crypto_payroll/setup/test_*.py`. The 28 tests guarding
`persist_confirmed_payment`, `post_journal`, and `export_compliance` — precisely the code
this refactor touches — do not run unless the module is named explicitly.

## Goals

- One `CHAIN_RULES[chain]` lookup replaces the ~15 backend branch sites; chain #5 becomes
  one new file plus one registry entry.
- `TreasuryDetail.tsx` becomes a router over four per-chain files.
- `PayPanel.tsx` gains test coverage **before** being split, and ends up below the
  800-line rule.
- One shared formatter module; every private copy deleted.
- `bench run-tests --app crypto_payroll` runs all 32 backend tests.
- **Every commit is behaviour-preserving**, with the single declared exception below.

## Non-goals (YAGNI)

- **Unifying the four accounting mappers.** `bitcoin-accounting.ts` (102),
  `solana-accounting.ts` (119), `evm-safe-accounting.ts` (91), and
  `batch-to-journal-inputs.ts` (89) are each independently tested, and their differences
  are substantive: BTC carries per-output operator mapping, SOL carries nonce authority,
  EVM carries dual-hash (SafeTx + outer) idempotency. A shared interface would add a
  layer without deleting meaningful code.
- **FX / cost-basis work.** The zero-FX policy stays exactly as it is.
- **Any new feature, chain, or endpoint.**
- **Refactoring modules not named in this spec**, even if they are also large.

## Declared behaviour change

Deleting `shannonsToCkbDisplay` and pointing its call sites at `formatCkb` adds thousands
separators at those sites. This is accepted deliberately: it removes an
internal inconsistency in how PayPanel renders CKB amounts. It is the **only** intended
user-visible change in this refactor. Any other observable difference is a defect.

## Workstream 1 — Backend chain registry

```
crypto_payroll/
  chains/
    base.py        ChainRules protocol
    ckb.py evm.py sol.py btc.py
    __init__.py    CHAIN_RULES: dict[str, ChainRules]
  api/__init__.py  orchestration only
  compliance.py    CSV/PDF assembly; per-chain rows delegated to CHAIN_RULES
```

`ChainRules` protocol surface, derived from the branch sites above:

| Member | Replaces |
|---|---|
| `validate_tx_hash(value, path) -> str` | `api:150,152` and the `else` fallback |
| `asset_and_decimals() -> tuple[str, int]` | `api:213–214` |
| `max_native_units() -> int \| None` | `api:206` |
| `normalise_evidence(record, path) -> dict` | `api:237,284,334` |
| `review_digest_field() -> str \| None` | `api:642,647` |
| `compliance_rows(batch) -> dict` | `compliance:213,227,243,291` |
| `fee_field() -> tuple[str, str] \| None` | `compliance:313,316,320` |

The allowlist at `api:147` becomes `CHAIN_RULES.keys()`, collapsing registration and
support into one edit.

**Verification gate:** `bench --site chainpay.localhost run-tests --module
crypto_payroll.test_api` reports 28/28 after **each** extraction, not only at the end.
Then the discovery fix, after which `--app crypto_payroll` reports 32.

## Workstream 2 — TreasuryDetail split and formatter consolidation

```
features/treasury/
  TreasuryDetail.tsx          router only (~60 lines)
  CkbTreasuryDetail.tsx  EvmTreasuryDetail.tsx
  BitcoinWatchDetail.tsx SolanaWatchDetail.tsx
lib/format/
  ckb.ts  btc.ts  sol.ts  evm.ts    formatCkb/formatBtc/formatSol/formatEth + signed variants
  chain-badge.ts                     one chainBadge
components/
  Tile.tsx  ReviewValue.tsx  Section.tsx
```

Consumers updated to import from the shared modules, with their private copies deleted:
`SignPanel.tsx`, `Dashboard.tsx`, `SafeApprovalDetail.tsx`, `TreasuryList.tsx`,
`PayPanel.tsx`.

**Verification gate:** `TreasuryDetail.bitcoin.test.tsx` and `TreasuryDetail.solana.test.tsx`
pass **unmodified**. New unit tests cover each extracted formatter, including the
zero-fraction, trailing-zero, and thousands-separator boundaries.

## Workstream 3 — PayPanel, risk-ordered in three stages

### 3a — Pure helpers out (zero behavioural risk)

Lines 907–1174 are already pure functions. Extract to
`features/payments/payment-draft.ts` and `lib/chains/ckb/`:

`assertMultisigBytesMatchTreasury`, `buildBatchLinesFromRecipients`, `lockFromAddress`,
`ckbToShannons`, `bytesEqual`, `bytesHex`, `autoLabel`, `monthStart`, `monthEnd`.

Each gets unit tests. `assertMultisigBytesMatchTreasury` is a security check currently
covered by nothing; it gets both positive and mismatch cases.

`dumpInputsForInspection` (line 950, called at line 369) is debug tooling: it publishes
`globalThis.__chainpay_debug` and emits a `console.warn` before broadcast. Manual smoke
sessions may read that global, so both side effects must survive the move verbatim. It is
not otherwise part of the public surface.

### 3b — Characterization tests (the safety net)

Written against the **current** component, with mocked stores and IPC, covering:

- draft → build → skeleton totals → packet JSON → signature rows → broadcast
- treasury switching resets dependent state
- the batch-hydration effect (`PayPanel.tsx:181`), including the treasury-switch re-entry path
- the `autoSelectBatchId` mount effect (`PayPanel.tsx:114`)
- FX fetch success and failure (`fxError` surfaces, `fxLoading` clears)
- `activeBatchId` null (manual one-off) vs set (payee-sourced batch lifecycle)

These must be green against unmodified `PayPanel.tsx` before stage 3c begins.

### 3c — Subcomponents and hooks out

Mechanical first: `DraftForm`, `PacketPanel`, `FxSnapshotPanel`, `SignaturePanel`,
`BroadcastResult` become their own files.

Then the 15 state atoms group into three hooks:

| Hook | Owns |
|---|---|
| `usePaymentDraft` | `treasuryId`, `recipients`, `feeRate`, `label` |
| `useFxSnapshot` | `fxSnapshot`, `fxLoading`, `fxError` |
| `usePaymentLifecycle` | `phase`, `skeleton`, `packetJson`, `sigs`, `broadcastedTxHash`, `activeBatchId` |

`error` and `busy` stay in the shell component.

**Verification gate:** 3b's tests pass **unchanged** after 3c. If a characterization test
requires editing to pass, that is a behaviour change: stop and surface it rather than
adjusting the test.

**Declared fallback:** stage 3c is the only part whose safety rests on test quality rather
than on the change being mechanical. If 3b's coverage proves thin in a way that is not
cheap to fix, ship 3a plus the subcomponent extraction and defer the hook split to a
follow-up. Announce this rather than pushing through.

## Testing strategy

| Layer | Net |
|---|---|
| Backend | 28 existing tests, run per-extraction; discovery fix brings `--app` to 32 |
| TreasuryDetail | 2 existing test files unmodified + new formatter unit tests |
| PayPanel 3a | New unit tests per extracted pure function |
| PayPanel 3b/3c | New characterization tests, unchanged across the split |
| Whole repo | 1077 desktop tests + `npm run typecheck` green at every commit boundary |

## Delivery

Branch `feat/consolidation-refactor`, three commits:

1. `refactor(backend): split chain rules into a registry`
2. `refactor(desktop): split TreasuryDetail and consolidate formatters`
3. `refactor(payments): cover and split PayPanel` (3a–3c squashed)

One PR against `main`. Full desktop suite, typecheck, and the 28 backend tests green at
each commit boundary — not just at the tip.

## Risks

| Risk | Mitigation |
|---|---|
| PayPanel hook split changes behaviour silently | 3b characterization tests, written and green first; tests must not change in 3c |
| Backend registry drops a validation branch | 28 tests run after each extraction, so the breaking step is identifiable |
| Formatter consolidation changes rendered values | Declared and bounded to the `shannonsToCkbDisplay` sites; formatter unit tests pin the rest |
| Refactor scope creeps into the untouched large files | Non-goals list is explicit; anything else stays out |
