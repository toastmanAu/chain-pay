# ChainPay Consolidation Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse ~15 scattered per-chain branch sites in the Frappe backend into one registry, split two oversized React files, de-duplicate four formatters, and put test coverage under the untested 1181-line CKB payment builder — without changing behaviour.

**Architecture:** Three independent workstreams. (1) Backend gains `crypto_payroll/chains/` where each chain module owns *both* directions of its evidence — validating inbound records and rebuilding them for digest verification — behind a `ChainRules` protocol resolved through `CHAIN_RULES[chain]`. (2) `TreasuryDetail.tsx` becomes a router over four per-chain files; formatters move to `lib/format/` and shared presentational atoms to `components/ui/`. (3) `PayPanel.tsx` is covered by characterization tests before being split into pure helpers, subcomponents, and three state hooks.

**Tech Stack:** Python 3 / Frappe v15 (`FrappeTestCase`, unittest-style) · TypeScript / React 19 / Vitest 4 / Testing Library / Zustand · `@ckb-ccc/core` for CKB primitives.

## Global Constraints

- **Every commit is behaviour-preserving.** The single declared exception is deleting `shannonsToCkbDisplay` in favour of `formatCkb`, which adds thousands separators at those call sites. Any other observable change is a defect.
- **Do not modify existing tests to make them pass.** If an existing test fails, the refactor broke something — revert and re-approach. This applies especially to `TreasuryDetail.bitcoin.test.tsx`, `TreasuryDetail.solana.test.tsx`, and the 28 tests in `test_api.py`.
  - **One carve-out (ruled 2026-08-11):** assertions on CKB *display strings* affected by the `shannonsToCkbDisplay` deletion in Task 9 may be updated, because that change is intended. Every such edit must be named individually in the commit message. No other test edit is permitted under any justification.
  - **One tracked deviation (ruled 2026-08-11):** Task 1 Step 6 narrows `test_chain_registry_covers_every_supported_chain` to the two CKB keys so each intermediate commit stays green; Task 4 Step 1 widens it back to all seven. The controller verifies the widening before Task 4 is marked complete.
  - **Pure-move tasks (ruled 2026-08-11):** Tasks 2–4 add no dedicated unit tests for `chains/{evm,sol,btc}.py`. Their coverage is the existing 28 end-to-end tests, and Task 5's round-trip test is the structural gate. This is a deliberate choice, not an oversight.
- **Backend test command is `bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`** until Task 16 changes it. `--app crypto_payroll` finds only 4 tests and is NOT a valid gate.
- Run backend tests inside the container: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`. Expected: `Ran 28 tests ... OK`.
- Desktop suite: `npm --workspace apps/desktop run test`. Expected baseline: `154 files, 1077 passed | 4 skipped`.
- Typecheck: `npm run typecheck` from the repo root. Must be clean at every commit.
- Python: PEP 8, type annotations on all signatures, `from __future__ import annotations` at the top of every new module (matches `api/__init__.py`).
- TypeScript: explicit types on exported functions, `interface` for object shapes, no `any`, immutable updates.
- Branch is `feat/consolidation-refactor`, already created, spec committed at `55aff91`.
- **Commit after every task.** Task 16 squashes the per-task commits into the three delivery commits.
- Do NOT touch: the four accounting mappers in `src/lib/accounting/`, any FX or cost-basis logic, any file not named in this plan.

---

## File Structure

**Workstream 1 — backend (created):**

| File | Responsibility |
|---|---|
| `apps/backend/apps/crypto_payroll/crypto_payroll/chains/__init__.py` | `CHAIN_RULES` registry; `rules_for(chain)` |
| `.../chains/base.py` | `ChainRules` protocol + shared validation helpers |
| `.../chains/ckb.py` | CKB: 0x-hash, CKB/8, no evidence block |
| `.../chains/evm.py` | Sepolia: SafeTx evidence, gas metadata |
| `.../chains/sol.py` | Solana: nonce evidence, base58 addresses |
| `.../chains/btc.py` | Bitcoin: per-output evidence, address validation |

**Workstream 1 — backend (modified):** `api/__init__.py` (orchestration only), `compliance.py` (delegates per-chain rows).

**Workstream 2 — frontend (created):** `lib/format/{ckb,btc,sol,evm,thousands,chain-badge}.ts` + tests · `components/ui/{Tile,ReviewValue,Section}.tsx` · `features/treasury/{Ckb,Evm}TreasuryDetail.tsx`, `{BitcoinWatch,SolanaWatch}Detail.tsx`.

**Workstream 3 — frontend (created):** `lib/chains/ckb/{bytes,address-lock,units,multisig-assert}.ts` + tests · `features/payments/payment-draft.ts` + test · `features/payments/PayPanel.test.tsx` (characterization) · `features/payments/{DraftForm,PacketPanel,FxSnapshotPanel,SignaturePanel,BroadcastResult}.tsx` · `features/payments/hooks/{usePaymentDraft,useFxSnapshot,usePaymentLifecycle}.ts`.

---

# Workstream 1 — Backend chain registry

**Deviation from the spec, deliberate:** the spec sketched `ChainRules` with
`asset_and_decimals()`, `review_digest_field()`, `compliance_rows()`, and `fee_field()`.
Reading the call sites showed a better split. `asset`/`decimals`/`max_native_units` are
constants, not computations, so they are dataclass attributes. `review_digest_field` only
ever fed the journal remark, so it becomes `journal_remark(batch)` returning the finished
string. `compliance_rows` splits into `rebuild_evidence(batch)` — which must mirror
`normalise_evidence` key-for-key — and `network_fee(batch)`. Same coverage, names that say
what the members do.

### Task 1: ChainRules protocol, registry, and CKB rules

**Files:**
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/chains/__init__.py`
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/chains/base.py`
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/chains/ckb.py`
- Modify: `apps/backend/apps/crypto_payroll/crypto_payroll/api/__init__.py` (lines 147–148, 150–157, 206, 212–215)
- Test: `apps/backend/apps/crypto_payroll/crypto_payroll/test_api.py` (append)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `crypto_payroll.chains.rules_for(chain: str) -> ChainRules` — raises via `frappe.throw` on unknown chain.
  - `crypto_payroll.chains.CHAIN_RULES: dict[str, ChainRules]` — keys are the seven supported chain strings.
  - `ChainRules` attributes: `chain: str`, `asset: str`, `decimals: int`, `max_native_units: int | None`, `evidence_key: str | None`.
  - `ChainRules.validate_tx_hash(value: object, path: str) -> str`.
  - `ChainRules.normalise_evidence(record: dict, lines: list[dict], tx_hash: str) -> dict | None`.
  - `ChainRules.rebuild_evidence(batch) -> dict | None`.
  - `ChainRules.journal_remark(batch) -> str` — returns `""` when the chain adds no remark.
  - `ChainRules.network_fee(batch) -> tuple[str, str, str] | None`.

- [ ] **Step 1: Write the failing test**

Append to `test_api.py`, inside the existing test class (find the class with `def test_` methods and add there; if there are multiple, use the one holding `test_persist_confirmed_payment`-style cases):

```python
    def test_chain_registry_covers_every_supported_chain(self):
        from crypto_payroll.chains import CHAIN_RULES, rules_for

        self.assertEqual(
            set(CHAIN_RULES),
            {
                "ckb:mainnet",
                "ckb:testnet",
                "evm:11155111",
                "sol:devnet",
                "sol:mainnet",
                "btc:testnet",
                "btc:mainnet",
            },
        )
        ckb = rules_for("ckb:testnet")
        self.assertEqual((ckb.asset, ckb.decimals), ("CKB", 8))
        self.assertIsNone(ckb.max_native_units)
        self.assertIsNone(ckb.evidence_key)
        self.assertEqual(
            ckb.validate_tx_hash("0x" + "AB" * 32, "record.txHash"),
            "0x" + "ab" * 32,
        )

    def test_chain_registry_rejects_unknown_chain(self):
        from crypto_payroll.chains import rules_for

        with self.assertRaises(frappe.ValidationError):
            rules_for("doge:mainnet")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`
Expected: FAIL with `ModuleNotFoundError: No module named 'crypto_payroll.chains'`

- [ ] **Step 3: Write `chains/base.py`**

```python
"""Per-chain rules for confirmed-payment evidence, in both directions.

Each chain module owns the inbound validation (`normalise_evidence`) AND the
outbound reconstruction used for digest verification (`rebuild_evidence`).
They MUST produce identical key sets — a drift between them breaks
`_source_digests` and makes persisted records unverifiable. Keeping both in one
class is the point of this module.
"""
from __future__ import annotations

import re
from typing import Protocol, runtime_checkable

import frappe

TX_HASH = re.compile(r"^0x[0-9a-fA-F]{64}$")
EVM_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
HEX_DIGEST = re.compile(r"^[0-9a-f]{64}$")
U64_MAX = 18_446_744_073_709_551_615
MAX_BTC_SATS = 2_100_000_000_000_000


@runtime_checkable
class ChainRules(Protocol):
    chain: str
    asset: str
    decimals: int
    max_native_units: int | None
    evidence_key: str | None

    def validate_tx_hash(self, value: object, path: str) -> str: ...

    def normalise_evidence(
        self, record: dict, lines: list[dict], tx_hash: str
    ) -> dict | None: ...

    def rebuild_evidence(self, batch) -> dict | None: ...

    def journal_remark(self, batch) -> str: ...

    def network_fee(self, batch) -> tuple[str, str, str] | None: ...


def hex_tx_hash(value: object, path: str) -> str:
    """0x-prefixed 32-byte hash, lowercased. Used by CKB and EVM."""
    text = str(value or "").lower()
    if not TX_HASH.fullmatch(text):
        frappe.throw(f"{path} must be a 0x-prefixed 32-byte transaction hash")
    return text
```

- [ ] **Step 4: Write `chains/ckb.py`**

```python
"""CKB rules: plain 0x transaction hash, CKB/8, no chain-specific evidence."""
from __future__ import annotations

from dataclasses import dataclass

from crypto_payroll.chains.base import hex_tx_hash


@dataclass(frozen=True)
class CkbRules:
    chain: str
    asset: str = "CKB"
    decimals: int = 8
    max_native_units: int | None = None
    evidence_key: str | None = None

    def validate_tx_hash(self, value: object, path: str) -> str:
        return hex_tx_hash(value, path)

    def normalise_evidence(
        self, record: dict, lines: list[dict], tx_hash: str
    ) -> dict | None:
        return None

    def rebuild_evidence(self, batch) -> dict | None:
        return None

    def journal_remark(self, batch) -> str:
        return ""

    def network_fee(self, batch) -> tuple[str, str, str] | None:
        return None
```

- [ ] **Step 5: Write `chains/__init__.py`**

Only CKB is registered so far; the other three land in Tasks 2–4. Registering a placeholder for them now would let an unsupported chain through, so they are added as their modules appear.

```python
"""Chain registry. Adding a chain = one module here plus one entry below."""
from __future__ import annotations

import frappe

from crypto_payroll.chains.base import ChainRules
from crypto_payroll.chains.ckb import CkbRules

CHAIN_RULES: dict[str, ChainRules] = {
    "ckb:mainnet": CkbRules(chain="ckb:mainnet"),
    "ckb:testnet": CkbRules(chain="ckb:testnet"),
}


def rules_for(chain: str) -> ChainRules:
    rules = CHAIN_RULES.get(chain)
    if rules is None:
        frappe.throw("record.chain is unsupported")
    return rules
```

- [ ] **Step 6: Run the registry tests only**

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`
Expected: `test_chain_registry_covers_every_supported_chain` FAILS (only 2 of 7 keys registered), `test_chain_registry_rejects_unknown_chain` PASSES.

This failure is expected and is resolved by Tasks 2–4. To keep the suite green at each commit, temporarily narrow the first test's expected set to `{"ckb:mainnet", "ckb:testnet"}` now, and widen it back in Task 4 Step 1. Note the narrowing in the commit message so it cannot be forgotten.

- [ ] **Step 7: Run the full backend suite**

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`
Expected: `Ran 30 tests ... OK` (28 existing + 2 new)

- [ ] **Step 8: Commit**

```bash
git add apps/backend/apps/crypto_payroll/crypto_payroll/chains/ \
        apps/backend/apps/crypto_payroll/crypto_payroll/test_api.py
git commit -m "refactor(backend): add ChainRules protocol and CKB rules

Registry starts with CKB only; evm/sol/btc land in following commits.
test_chain_registry_covers_every_supported_chain is temporarily narrowed
to the CKB keys and widened again when btc.py lands."
```

---

### Task 2: EVM rules

**Files:**
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/chains/evm.py`
- Modify: `.../chains/__init__.py` (add the `evm:11155111` entry)
- Modify: `.../api/__init__.py` (delete lines 236–281, call through the registry)
- Modify: `.../compliance.py` (delete lines 212–225, call `rebuild_evidence`)

**Interfaces:**
- Consumes: `ChainRules` protocol, `hex_tx_hash`, `EVM_ADDRESS`, `TX_HASH` from Task 1's `base.py`.
- Produces: `EvmRules` with `evidence_key = "evm"`, `asset = "ETH"`, `decimals = 18`, `max_native_units = None`.

- [ ] **Step 1: Confirm the existing EVM tests are the safety net**

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`
Expected: `Ran 30 tests ... OK`. The EVM cases (`secure-EVM-A`, `secure-EVM-B`, `secure-EXPORT-EVM`) already cover safeTxHash validation, gas-fee arithmetic, `gasPayer` enforcement, and outer-hash matching. No new test is written here — this is a pure move, and inventing parallel tests for moved code adds maintenance without adding signal.

- [ ] **Step 2: Write `chains/evm.py`**

Move the body of `api/__init__.py` lines 237–279 into `normalise_evidence` verbatim, and `compliance.py` lines 214–225 into `rebuild_evidence` verbatim. Only the surrounding function signature and the `raw_evm`/`batch` accessors change.

```python
"""Sepolia Safe rules: SafeTx evidence plus executor-paid gas metadata."""
from __future__ import annotations

from dataclasses import dataclass

import frappe

from crypto_payroll.chains.base import EVM_ADDRESS, TX_HASH, hex_tx_hash
from crypto_payroll.compliance import format_units


@dataclass(frozen=True)
class EvmRules:
    chain: str
    asset: str = "ETH"
    decimals: int = 18
    max_native_units: int | None = None
    evidence_key: str | None = "evm"

    def validate_tx_hash(self, value: object, path: str) -> str:
        return hex_tx_hash(value, path)

    def normalise_evidence(
        self, record: dict, lines: list[dict], tx_hash: str
    ) -> dict | None:
        from crypto_payroll.api import _strict_keys

        raw_evm = record.get("evm")
        if not isinstance(raw_evm, dict):
            frappe.throw("record.evm is required for a Sepolia payment")
        _strict_keys(
            raw_evm,
            {
                "safeAddress", "safeTxHash", "outerTxHash", "executorAddress",
                "recipientAddress", "confirmedBlockNumber", "gasUsed",
                "effectiveGasPriceWei", "gasFeeWei", "gasPayer",
            },
            "record.evm",
        )
        addresses = {}
        for field in ("safeAddress", "executorAddress", "recipientAddress"):
            value = str(raw_evm.get(field) or "").lower()
            if not EVM_ADDRESS.fullmatch(value):
                frappe.throw(f"record.evm.{field} must be a 20-byte EVM address")
            addresses[field] = value
        safe_tx_hash = str(raw_evm.get("safeTxHash") or "").lower()
        outer_tx_hash = str(raw_evm.get("outerTxHash") or "").lower()
        if not TX_HASH.fullmatch(safe_tx_hash):
            frappe.throw("record.evm.safeTxHash must be a 32-byte hash")
        if outer_tx_hash != tx_hash:
            frappe.throw("record.evm.outerTxHash must match record.txHash")
        try:
            confirmed_block = int(str(raw_evm.get("confirmedBlockNumber")))
            gas_used = int(str(raw_evm.get("gasUsed")))
            gas_price = int(str(raw_evm.get("effectiveGasPriceWei")))
            gas_fee = int(str(raw_evm.get("gasFeeWei")))
        except (TypeError, ValueError):
            frappe.throw("record.evm receipt values must be decimal integers")
        if confirmed_block <= 0 or gas_used <= 0 or gas_price <= 0:
            frappe.throw("record.evm block and gas values must be positive")
        if gas_fee != gas_used * gas_price:
            frappe.throw("record.evm.gasFeeWei must equal gasUsed × effectiveGasPriceWei")
        if raw_evm.get("gasPayer") != "executor":
            frappe.throw("record.evm.gasPayer must be executor")
        return {
            "safe_address": addresses["safeAddress"],
            "safe_tx_hash": safe_tx_hash,
            "outer_tx_hash": outer_tx_hash,
            "executor_address": addresses["executorAddress"],
            "recipient_address": addresses["recipientAddress"],
            "confirmed_block_number": str(confirmed_block),
            "gas_used": str(gas_used),
            "effective_gas_price_wei": str(gas_price),
            "gas_fee_wei": str(gas_fee),
            "gas_payer": "executor",
        }

    def rebuild_evidence(self, batch) -> dict | None:
        return {
            "safe_address": batch.safe_address,
            "safe_tx_hash": batch.safe_tx_hash,
            "outer_tx_hash": batch.tx_hash,
            "executor_address": batch.executor_address,
            "recipient_address": batch.recipient_address,
            "confirmed_block_number": str(batch.confirmed_block_number),
            "gas_used": str(batch.gas_used),
            "effective_gas_price_wei": str(batch.effective_gas_price_wei),
            "gas_fee_wei": str(batch.gas_fee_wei),
            "gas_payer": batch.gas_payer,
        }

    def journal_remark(self, batch) -> str:
        if not batch.safe_tx_hash:
            return ""
        return (
            f" · SafeTx {batch.safe_tx_hash}"
            f" · gas paid by executor {batch.executor_address}"
        )

    def network_fee(self, batch) -> tuple[str, str, str] | None:
        if not batch.gas_fee_wei:
            return None
        value = str(batch.gas_fee_wei)
        return value, f"{format_units(value, 18)} ETH", batch.gas_payer or "executor"
```

- [ ] **Step 3: Register EVM**

In `chains/__init__.py`, add the import and the entry:

```python
from crypto_payroll.chains.evm import EvmRules
```

```python
    "evm:11155111": EvmRules(chain="evm:11155111"),
```

- [ ] **Step 4: Delete the inline EVM block from `api/__init__.py`**

Replace lines 236–281 (from `evm = None` through the `elif record.get("evm") is not None:` guard and its throw) with a single registry-driven block. Insert immediately after the `for index, raw in enumerate(raw_lines):` loop ends (after line 234):

```python
    rules = rules_for(chain)
    evidence = {"evm": None, "solana": None, "bitcoin": None}
    if rules.evidence_key:
        evidence[rules.evidence_key] = rules.normalise_evidence(record, lines, tx_hash)
    for key in ("evm", "solana", "bitcoin"):
        if key != rules.evidence_key and record.get(key) is not None:
            frappe.throw(f"record.{key} is only valid for {key.upper()} payments")
```

The final `return` at lines 385–398 changes its last three entries to read from `evidence`:

```python
        "evm": evidence["evm"],
        "solana": evidence["solana"],
        "bitcoin": evidence["bitcoin"],
```

**Preserve the exact throw messages.** The wrong-chain guards currently read
`"record.evm is only valid for EVM payments"`, `"record.solana is only valid for Solana payments"`,
and `"record.bitcoin is only valid for Bitcoin payments"`. The loop above produces
`EVM`/`SOLANA`/`BITCOIN`, which does not match Solana and Bitcoin. Use an explicit label map
instead:

```python
    _EVIDENCE_LABEL = {"evm": "EVM", "solana": "Solana", "bitcoin": "Bitcoin"}
```

and throw `f"record.{key} is only valid for {_EVIDENCE_LABEL[key]} payments"`.

Note: Steps 4's block references `rules_for`, so add `from crypto_payroll.chains import rules_for` to the imports at the top of `api/__init__.py`. Delete the now-unused `_EVM_ADDRESS` constant (line 24) only once no reference remains — grep first.

- [ ] **Step 5: Delegate in `compliance.py`**

Replace lines 212–225 (`evm = None` / `if batch.chain == "evm:11155111":` / the dict) with:

```python
    rules = rules_for(batch.chain)
    evm = rules.rebuild_evidence(batch) if rules.evidence_key == "evm" else None
```

Add `from crypto_payroll.chains import rules_for` to `compliance.py` imports.

**Import-cycle warning:** `chains/evm.py` imports `format_units` from `compliance`, and `compliance` imports `rules_for` from `chains`. Python resolves this only if one side defers. `format_units` is used inside a method body, so move that import inside `network_fee`:

```python
    def network_fee(self, batch) -> tuple[str, str, str] | None:
        from crypto_payroll.compliance import format_units
```

and delete the module-level `from crypto_payroll.compliance import format_units`. Apply the same pattern in `sol.py` and `btc.py`.

- [ ] **Step 6: Run the full backend suite**

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`
Expected: `Ran 30 tests ... OK`

If any EVM test fails, the move dropped or reordered a validation — diff the moved block against `git show HEAD:apps/backend/apps/crypto_payroll/crypto_payroll/api/__init__.py | sed -n '236,281p'` rather than patching forward.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/apps/crypto_payroll/crypto_payroll/
git commit -m "refactor(backend): move EVM evidence rules into chains/evm.py"
```

---

### Task 3: Solana rules

**Files:**
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/chains/sol.py`
- Modify: `.../chains/__init__.py`, `.../chains/base.py` (move `_base58_bytes`), `.../api/__init__.py`, `.../compliance.py`

**Interfaces:**
- Consumes: `ChainRules`, `HEX_DIGEST`, `U64_MAX` from `base.py`; the `evidence` dispatch block added in Task 2 Step 4.
- Produces: `SolRules` with `evidence_key = "solana"`, `asset = "SOL"`, `decimals = 9`, `max_native_units = U64_MAX`; `base58_bytes(value, size, path) -> str` moved into `base.py`.

- [ ] **Step 1: Move `_base58_bytes` into `base.py`**

Move `api/__init__.py` lines 50–68 verbatim into `chains/base.py`, renamed to `base58_bytes` (public — `sol.py` and the SOL tx-hash validator both need it). In `api/__init__.py`, delete the original and import it: `from crypto_payroll.chains.base import base58_bytes`. Keep a module-level alias `_base58_bytes = base58_bytes` only if grep shows other callers; otherwise update call sites.

- [ ] **Step 2: Write `chains/sol.py`**

`validate_tx_hash` replaces `api/__init__.py:151`; `normalise_evidence` is lines 285–329 verbatim; `rebuild_evidence` is `compliance.py:228–241`; `journal_remark` is `api/__init__.py:641–643`; `network_fee` is `compliance.py:316–319`.

```python
"""Solana rules: durable-nonce evidence, base58 addresses, 64-byte signature."""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass

import frappe

from crypto_payroll.chains.base import HEX_DIGEST, U64_MAX, base58_bytes


@dataclass(frozen=True)
class SolRules:
    chain: str
    asset: str = "SOL"
    decimals: int = 9
    max_native_units: int | None = U64_MAX
    evidence_key: str | None = "solana"

    def validate_tx_hash(self, value: object, path: str) -> str:
        return base58_bytes(value, 64, path)

    def normalise_evidence(
        self, record: dict, lines: list[dict], tx_hash: str
    ) -> dict | None:
        from crypto_payroll.api import _canonical_uint, _strict_keys

        raw_solana = record.get("solana")
        if not isinstance(raw_solana, dict):
            frappe.throw("record.solana is required for a Solana payment")
        _strict_keys(
            raw_solana,
            {
                "reviewDigest", "sourceAddress", "recipientAddress",
                "feePayerAddress", "nonceAccount", "nonceAuthority",
                "durableNonce", "finalizedSlot", "amountLamports",
                "feeLamports", "feePayerPolicy", "messageBase64",
            },
            "record.solana",
        )
        review_digest = str(raw_solana.get("reviewDigest") or "")
        if not HEX_DIGEST.fullmatch(review_digest):
            frappe.throw("record.solana.reviewDigest must be a lowercase 32-byte hex digest")
        addresses = {
            field: base58_bytes(raw_solana.get(field), 32, f"record.solana.{field}")
            for field in (
                "sourceAddress", "recipientAddress", "feePayerAddress",
                "nonceAccount", "nonceAuthority", "durableNonce",
            )
        }
        if addresses["sourceAddress"] == addresses["recipientAddress"]:
            frappe.throw("record.solana source and recipient must be different")
        if addresses["nonceAccount"] in {
            addresses["sourceAddress"],
            addresses["recipientAddress"],
            addresses["feePayerAddress"],
        }:
            frappe.throw("record.solana nonce account must be distinct from payment accounts")
        finalized_slot = _canonical_uint(
            raw_solana.get("finalizedSlot"), "record.solana.finalizedSlot",
            positive=True, maximum=U64_MAX,
        )
        amount_lamports = _canonical_uint(
            raw_solana.get("amountLamports"), "record.solana.amountLamports",
            positive=True, maximum=U64_MAX,
        )
        fee_lamports = _canonical_uint(
            raw_solana.get("feeLamports"), "record.solana.feeLamports", maximum=U64_MAX,
        )
        if len(lines) != 1 or int(lines[0]["crypto_value"]) != amount_lamports:
            frappe.throw("record.solana.amountLamports must match the single SOL payment line")
        if raw_solana.get("feePayerPolicy") != "transaction_fee_payer":
            frappe.throw("record.solana.feePayerPolicy must be transaction_fee_payer")
        message_base64 = str(raw_solana.get("messageBase64") or "")
        if len(message_base64) > 4096:
            frappe.throw("record.solana.messageBase64 is too large")
        try:
            decoded_message = base64.b64decode(message_base64, validate=True)
        except (binascii.Error, ValueError):
            frappe.throw("record.solana.messageBase64 must be canonical base64")
        if not decoded_message or base64.b64encode(decoded_message).decode("ascii") != message_base64:
            frappe.throw("record.solana.messageBase64 must be canonical base64")
        return {
            "review_digest": review_digest,
            "source_address": addresses["sourceAddress"],
            "recipient_address": addresses["recipientAddress"],
            "fee_payer_address": addresses["feePayerAddress"],
            "nonce_account": addresses["nonceAccount"],
            "nonce_authority": addresses["nonceAuthority"],
            "durable_nonce": addresses["durableNonce"],
            "finalized_slot": str(finalized_slot),
            "amount_lamports": str(amount_lamports),
            "fee_lamports": str(fee_lamports),
            "fee_payer_policy": "transaction_fee_payer",
            "solana_message_base64": message_base64,
        }

    def rebuild_evidence(self, batch) -> dict | None:
        return {
            "review_digest": batch.review_digest,
            "source_address": batch.source_address,
            "recipient_address": batch.recipient_address,
            "fee_payer_address": batch.fee_payer_address,
            "nonce_account": batch.nonce_account,
            "nonce_authority": batch.nonce_authority,
            "durable_nonce": batch.durable_nonce,
            "finalized_slot": str(batch.finalized_slot),
            "amount_lamports": str(batch.amount_lamports),
            "fee_lamports": str(batch.fee_lamports),
            "fee_payer_policy": batch.fee_payer_policy,
            "solana_message_base64": batch.solana_message_base64,
        }

    def journal_remark(self, batch) -> str:
        if not batch.review_digest:
            return ""
        return (
            f" · Solana review {batch.review_digest}"
            f" · finalized slot {batch.finalized_slot}"
            f" · fee {batch.fee_lamports} lamports paid by {batch.fee_payer_address}"
        )

    def network_fee(self, batch) -> tuple[str, str, str] | None:
        from crypto_payroll.compliance import format_units

        if batch.fee_lamports is None:
            return None
        value = str(batch.fee_lamports)
        payer = f"{batch.fee_payer_policy}:{batch.fee_payer_address}"
        return value, f"{format_units(value, 9)} SOL", payer
```

- [ ] **Step 3: Register both Solana clusters and delete the inline blocks**

`chains/__init__.py`: add `from crypto_payroll.chains.sol import SolRules` plus entries `"sol:devnet": SolRules(chain="sol:devnet")` and `"sol:mainnet": SolRules(chain="sol:mainnet")`.

Delete `api/__init__.py` lines 283–331 (the `solana = None` block) — the Task 2 dispatch already covers it. Delete `compliance.py` lines 226–241, replacing with `solana = rules.rebuild_evidence(batch) if rules.evidence_key == "solana" else None`.

- [ ] **Step 4: Run the full backend suite**

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`
Expected: `Ran 30 tests ... OK`

- [ ] **Step 5: Commit**

```bash
git add apps/backend/apps/crypto_payroll/crypto_payroll/
git commit -m "refactor(backend): move Solana evidence rules into chains/sol.py"
```

---

### Task 4: Bitcoin rules and the max-native-units / asset dispatch

**Files:**
- Create: `apps/backend/apps/crypto_payroll/crypto_payroll/chains/btc.py`
- Modify: `.../chains/__init__.py`, `.../chains/base.py` (move `_bitcoin_address`), `.../api/__init__.py` (lines 206, 212–215, 147–157, 642–649), `.../compliance.py`
- Test: `.../test_api.py` (widen the registry test)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `BtcRules` with `evidence_key = "bitcoin"`, `asset = "BTC"`, `decimals = 8`, `max_native_units = MAX_BTC_SATS`; `bitcoin_address(value, chain, path) -> str` in `base.py`.

- [ ] **Step 1: Widen the registry test back to all seven chains**

In `test_api.py`, restore `test_chain_registry_covers_every_supported_chain` to the full seven-key set exactly as written in Task 1 Step 1.

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`
Expected: FAIL — the assertion reports the set is missing `btc:mainnet` and `btc:testnet`.

- [ ] **Step 3: Move `_bitcoin_address` into `base.py`**

Move `api/__init__.py` lines 71–114 verbatim into `chains/base.py` as `bitcoin_address(value: object, chain: str, path: str) -> str`. It needs `hashlib` and the base58 alphabet — `base58_bytes` (moved in Task 3) already brought `_BASE58_INDEX`; make that a module constant in `base.py` named `BASE58_INDEX` and update both functions.

- [ ] **Step 4: Write `chains/btc.py`**

`normalise_evidence` is `api/__init__.py` lines 334–381 verbatim; `rebuild_evidence` is `compliance.py:243–261`; `journal_remark` is `api/__init__.py:645–649`; `network_fee` is `compliance.py:320–322`. `validate_tx_hash` replaces lines 152–155.

```python
"""Bitcoin rules: per-output operator mapping, six-confirmation evidence."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

import frappe

from crypto_payroll.chains.base import (
    HEX_DIGEST,
    MAX_BTC_SATS,
    U64_MAX,
    bitcoin_address,
)

_TXID = re.compile(r"^[0-9a-f]{64}$")
_FEE_RATE = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$")


@dataclass(frozen=True)
class BtcRules:
    chain: str
    asset: str = "BTC"
    decimals: int = 8
    max_native_units: int | None = MAX_BTC_SATS
    evidence_key: str | None = "bitcoin"

    def validate_tx_hash(self, value: object, path: str) -> str:
        text = str(value or "")
        if not _TXID.fullmatch(text):
            frappe.throw("record.txHash must be a lowercase Bitcoin transaction id")
        return text

    def normalise_evidence(
        self, record: dict, lines: list[dict], tx_hash: str
    ) -> dict | None:
        from crypto_payroll.api import _canonical_uint, _strict_keys

        raw_bitcoin = record.get("bitcoin")
        if not isinstance(raw_bitcoin, dict):
            frappe.throw("record.bitcoin is required for a Bitcoin payment")
        _strict_keys(
            raw_bitcoin,
            {
                "reviewDigest", "wtxid", "rawTransactionHash", "blockHeight",
                "blockHash", "confirmations", "inputValueSats", "outputValueSats",
                "feeSats", "feeRateSatsPerVbyte", "feePayerPolicy", "outputs",
            },
            "record.bitcoin",
        )
        hex_values = {}
        for field in ("reviewDigest", "wtxid", "rawTransactionHash", "blockHash"):
            value = str(raw_bitcoin.get(field) or "")
            if not HEX_DIGEST.fullmatch(value):
                frappe.throw(f"record.bitcoin.{field} must be lowercase 32-byte hex")
            hex_values[field] = value
        block_height = _canonical_uint(
            raw_bitcoin.get("blockHeight"), "record.bitcoin.blockHeight",
            positive=True, maximum=U64_MAX,
        )
        confirmations = _canonical_uint(
            raw_bitcoin.get("confirmations"), "record.bitcoin.confirmations",
            positive=True, maximum=U64_MAX,
        )
        input_sats = _canonical_uint(
            raw_bitcoin.get("inputValueSats"), "record.bitcoin.inputValueSats",
            positive=True, maximum=MAX_BTC_SATS,
        )
        output_sats = _canonical_uint(
            raw_bitcoin.get("outputValueSats"), "record.bitcoin.outputValueSats",
            positive=True, maximum=MAX_BTC_SATS,
        )
        fee_sats = _canonical_uint(
            raw_bitcoin.get("feeSats"), "record.bitcoin.feeSats",
            positive=True, maximum=MAX_BTC_SATS,
        )
        if confirmations < 6 or input_sats != output_sats + fee_sats:
            frappe.throw("record.bitcoin confirmation depth or satoshi conservation is invalid")
        rate = str(raw_bitcoin.get("feeRateSatsPerVbyte") or "")
        if not _FEE_RATE.fullmatch(rate):
            frappe.throw("record.bitcoin.feeRateSatsPerVbyte is invalid")
        if raw_bitcoin.get("feePayerPolicy") != "transaction_inputs":
            frappe.throw("record.bitcoin.feePayerPolicy must be transaction_inputs")
        raw_outputs = raw_bitcoin.get("outputs")
        if not isinstance(raw_outputs, list) or len(raw_outputs) != len(lines):
            frappe.throw("record.bitcoin.outputs must match payment lines")
        outputs = []
        previous_vout = -1
        for index, output in enumerate(raw_outputs):
            if not isinstance(output, dict):
                frappe.throw(f"record.bitcoin.outputs[{index}] must be an object")
            _strict_keys(
                output, {"vout", "destination", "valueSats"},
                f"record.bitcoin.outputs[{index}]",
            )
            vout = _canonical_uint(
                output.get("vout"), f"record.bitcoin.outputs[{index}].vout",
                maximum=4_294_967_295,
            )
            value_sats = _canonical_uint(
                output.get("valueSats"), f"record.bitcoin.outputs[{index}].valueSats",
                positive=True, maximum=MAX_BTC_SATS,
            )
            if vout <= previous_vout or value_sats != int(lines[index]["crypto_value"]):
                frappe.throw("record.bitcoin outputs must be ordered and match payment lines")
            previous_vout = vout
            outputs.append({
                "vout": str(vout),
                "destination": bitcoin_address(
                    output.get("destination"), self.chain,
                    f"record.bitcoin.outputs[{index}].destination",
                ),
                "value_sats": str(value_sats),
            })
        if sum(int(output["value_sats"]) for output in outputs) > output_sats:
            frappe.throw("record.bitcoin payment outputs exceed transaction outputs")
        return {
            "review_digest": hex_values["reviewDigest"],
            "wtxid": hex_values["wtxid"],
            "raw_transaction_hash": hex_values["rawTransactionHash"],
            "bitcoin_block_height": str(block_height),
            "block_hash": hex_values["blockHash"],
            "confirmations": str(confirmations),
            "input_value_sats": str(input_sats),
            "output_value_sats": str(output_sats),
            "fee_sats": str(fee_sats),
            "fee_rate_sats_per_vbyte": rate,
            "fee_payer_policy": "transaction_inputs",
            "bitcoin_outputs_json": json.dumps(outputs, sort_keys=True, separators=(",", ":")),
        }

    def rebuild_evidence(self, batch) -> dict | None:
        try:
            outputs = json.loads(batch.bitcoin_outputs_json)
        except (TypeError, json.JSONDecodeError):
            frappe.throw(f"payment record {batch.name} has invalid Bitcoin outputs")
        return {
            "review_digest": batch.review_digest,
            "wtxid": batch.wtxid,
            "raw_transaction_hash": batch.raw_transaction_hash,
            "bitcoin_block_height": str(batch.bitcoin_block_height),
            "block_hash": batch.block_hash,
            "confirmations": str(batch.confirmations),
            "input_value_sats": str(batch.input_value_sats),
            "output_value_sats": str(batch.output_value_sats),
            "fee_sats": str(batch.fee_sats),
            "fee_rate_sats_per_vbyte": str(batch.fee_rate_sats_per_vbyte),
            "fee_payer_policy": batch.fee_payer_policy,
            "bitcoin_outputs_json": json.dumps(outputs, sort_keys=True, separators=(",", ":")),
        }

    def journal_remark(self, batch) -> str:
        if not batch.review_digest:
            return ""
        return (
            f" · Bitcoin review {batch.review_digest}"
            f" · block {batch.bitcoin_block_height}"
            f" · {batch.confirmations} confirmations"
            f" · fee {batch.fee_sats} sats paid by transaction inputs"
        )

    def network_fee(self, batch) -> tuple[str, str, str] | None:
        from crypto_payroll.compliance import format_units

        if batch.fee_sats is None:
            return None
        value = str(batch.fee_sats)
        return (
            value,
            f"{format_units(value, 8)} BTC",
            batch.fee_payer_policy or "transaction_inputs",
        )
```

- [ ] **Step 5: Register Bitcoin and collapse the remaining dispatch sites**

`chains/__init__.py`: add `from crypto_payroll.chains.btc import BtcRules` and entries for `btc:testnet` and `btc:mainnet`.

In `api/__init__.py`:

- Lines 146–148 (the allowlist): replace the hardcoded set membership check with the registry lookup. The `rules_for` call itself throws `"record.chain is unsupported"`, so this becomes:
  ```python
      chain = str(record.get("chain") or "")
      rules = rules_for(chain)
  ```
  and the `rules_for(chain)` call added in Task 2 Step 4 is deleted (it is now assigned here, before the lines loop, which is required because line 206 needs it).
- Lines 149–157 (tx-hash branching): `tx_hash = rules.validate_tx_hash(record.get("txHash"), "record.txHash")`.
- Line 206: `maximum = rules.max_native_units`.
- Lines 212–215: `expected_asset, expected_decimals = rules.asset, rules.decimals`.
- Lines 333–383 (the `bitcoin = None` block): delete.
- Lines 640–649 (the two remark ternaries inside `user_remark`): replace both with `+ rules_for(batch.chain).journal_remark(batch)`. The EVM remark at lines 635–639 also folds in — `EvmRules.journal_remark` reproduces it exactly, so delete that ternary too and rely on the single call.

In `compliance.py`: delete lines 242–261 and the `_network_fee` chain ladder at 312–323, replacing the latter with:

```python
def _network_fee(batch) -> tuple[str, str, str]:
    fee = rules_for(batch.chain).network_fee(batch)
    return fee if fee else (UNAVAILABLE, UNAVAILABLE, UNAVAILABLE)
```

**Preserve the legacy-digest candidates.** `_source_digests` lines 283–293 build backward-compatible digests for records persisted before Bitcoin, Solana, and Sepolia support existed. That logic is chain-agnostic and stays exactly where it is — do not move it into the chain modules and do not simplify it. Records written by earlier versions become unverifiable if it changes.

- [ ] **Step 6: Run the full backend suite**

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`
Expected: `Ran 30 tests ... OK`, including the now-widened registry test.

- [ ] **Step 7: Verify the module actually shrank**

Run: `wc -l apps/backend/apps/crypto_payroll/crypto_payroll/api/__init__.py apps/backend/apps/crypto_payroll/crypto_payroll/compliance.py apps/backend/apps/crypto_payroll/crypto_payroll/chains/*.py`
Expected: `api/__init__.py` well under 400 lines (was 690); no chain module over 250.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/apps/crypto_payroll/crypto_payroll/
git commit -m "refactor(backend): move Bitcoin rules into chains/btc.py and route all dispatch through the registry"
```

---

### Task 5: Verify registry completeness with a cross-chain test

**Files:**
- Test: `apps/backend/apps/crypto_payroll/crypto_payroll/test_api.py` (append)

**Interfaces:**
- Consumes: `CHAIN_RULES` from Task 1; all four rule classes.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing test**

This is the test the old structure could not express: that every registered chain implements the whole protocol, and that inbound and outbound evidence agree on key sets. A future chain #5 that forgets `rebuild_evidence` fails here rather than at digest-verification time in production.

```python
    def test_every_registered_chain_implements_the_protocol(self):
        from crypto_payroll.chains import CHAIN_RULES

        for chain, rules in CHAIN_RULES.items():
            with self.subTest(chain=chain):
                self.assertEqual(rules.chain, chain)
                self.assertTrue(rules.asset)
                self.assertIsInstance(rules.decimals, int)
                self.assertIn(rules.evidence_key, {None, "evm", "solana", "bitcoin"})
                for method in (
                    "validate_tx_hash", "normalise_evidence",
                    "rebuild_evidence", "journal_remark", "network_fee",
                ):
                    self.assertTrue(
                        callable(getattr(rules, method, None)),
                        f"{chain} is missing {method}",
                    )

    def test_evidence_round_trips_through_the_registry(self):
        """normalise_evidence and rebuild_evidence must agree on key sets.

        A drift between them silently breaks _source_digests, so pin it here.
        """
        from crypto_payroll.chains import rules_for

        ensure_custom_fields()
        record = _evm_record(batch_id="secure-EVM-ROUNDTRIP", outer_byte="33", safe_byte="44")
        persist_confirmed_payment(record)
        batch = frappe.get_doc(
            "Crypto Payment Batch",
            frappe.db.get_value(
                "Crypto Payment Batch", {"external_id": "secure-EVM-ROUNDTRIP"}, "name"
            ),
        )
        rules = rules_for("evm:11155111")
        inbound = rules.normalise_evidence(record, [], "0x" + "33" * 32)
        outbound = rules.rebuild_evidence(batch)
        self.assertEqual(set(inbound), set(outbound))
        self.assertEqual(inbound, outbound)
```

Add `"secure-EVM-ROUNDTRIP"` to the `_IDS` list at the top of `test_api.py` so the existing teardown cleans it up.

- [ ] **Step 2: Run to verify it passes**

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`
Expected: `Ran 32 tests ... OK`

If `test_evidence_round_trips_through_the_registry` fails on key sets, the EVM move in Task 2 introduced a real drift — fix `chains/evm.py`, not the test.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/apps/crypto_payroll/crypto_payroll/test_api.py
git commit -m "test(backend): pin ChainRules protocol completeness and evidence round-trip"
```

---

# Workstream 2 — TreasuryDetail split and formatter consolidation

### Task 6: Shared formatter modules

**Files:**
- Create: `apps/desktop/src/lib/format/thousands.ts`, `ckb.ts`, `btc.ts`, `sol.ts`, `evm.ts`, `chain-badge.ts`
- Test: `apps/desktop/src/lib/format/format.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `formatThousands(n: bigint): string`
  - `formatCkb(shannons: bigint): string`
  - `formatBtc(satoshiText: string): string` · `formatSignedBtc(satoshiText: string): string`
  - `formatSol(lamportText: string): string` · `formatSignedSol(lamportText: string): string` · `formatLamports(lamportText: string): string`
  - `formatEth(wei: bigint): string`
  - `chainBadge(chain: string): string`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/lib/format/format.test.ts`. The `formatCkb` cases pin the *existing* three-copy behaviour — including thousands separators, which is what makes the `shannonsToCkbDisplay` deletion in Task 9 a visible-but-bounded change.

```typescript
import { describe, expect, it } from "vitest";
import { formatThousands } from "./thousands";
import { formatCkb } from "./ckb";
import { formatBtc, formatSignedBtc } from "./btc";
import { formatSol, formatSignedSol, formatLamports } from "./sol";
import { formatEth } from "./evm";
import { chainBadge } from "./chain-badge";

describe("formatThousands", () => {
  it("groups digits in threes", () => {
    expect(formatThousands(1234567n)).toBe("1,234,567");
  });

  it("leaves short numbers alone", () => {
    expect(formatThousands(999n)).toBe("999");
  });
});

describe("formatCkb", () => {
  it("drops the fractional part when it is zero", () => {
    expect(formatCkb(100_000_000n)).toBe("1");
  });

  it("groups the whole part and trims trailing zeros", () => {
    expect(formatCkb(123_456_700_000_000n)).toBe("1,234,567");
    expect(formatCkb(150_000_000n)).toBe("1.5");
  });

  it("keeps leading fractional zeros", () => {
    expect(formatCkb(100_000_001n)).toBe("1.00000001");
  });

  it("formats zero", () => {
    expect(formatCkb(0n)).toBe("0");
  });
});

describe("formatBtc", () => {
  it("converts satoshis with 8 decimals", () => {
    expect(formatBtc("123456789")).toBe("1.23456789");
    expect(formatBtc("100000000")).toBe("1");
  });

  it("signs non-negative and negative values", () => {
    expect(formatSignedBtc("100000000")).toBe("+1");
    expect(formatSignedBtc("-100000000")).toBe("-1");
  });
});

describe("formatSol", () => {
  it("converts lamports with 9 decimals", () => {
    expect(formatSol("1500000000")).toBe("1.5");
    expect(formatSol("1000000000")).toBe("1");
  });

  it("signs values", () => {
    expect(formatSignedSol("1000000000")).toBe("+1");
    expect(formatSignedSol("-1000000000")).toBe("-1");
  });

  it("formats raw lamports with separators", () => {
    expect(formatLamports("1500000000")).toBe("1,500,000,000");
  });
});

describe("formatEth", () => {
  it("formats wei as ether", () => {
    expect(formatEth(1_000_000_000_000_000_000n)).toBe("1");
  });
});

describe("chainBadge", () => {
  it("labels every supported chain", () => {
    expect(chainBadge("ckb:mainnet")).toBe("CKB mainnet");
    expect(chainBadge("ckb:testnet")).toBe("CKB testnet");
    expect(chainBadge("btc:mainnet")).toBe("Bitcoin mainnet");
    expect(chainBadge("btc:testnet")).toBe("Bitcoin testnet");
    expect(chainBadge("sol:mainnet")).toBe("Solana mainnet");
    expect(chainBadge("sol:devnet")).toBe("Solana devnet");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace apps/desktop run test -- src/lib/format/format.test.ts`
Expected: FAIL — `Failed to resolve import "./thousands"`

- [ ] **Step 3: Read the current implementations before writing**

Run: `sed -n '789,830p;859,931p' apps/desktop/src/features/treasury/TreasuryDetail.tsx`

Copy the bodies verbatim. `chainBadge` in `TreasuryDetail.tsx:921` and `TreasuryList.tsx:137` may differ — diff them and, if they do, keep the `TreasuryDetail` version and note the difference in the commit message so the change is visible.

- [ ] **Step 4: Write the modules**

```typescript
// src/lib/format/thousands.ts
export function formatThousands(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
```

```typescript
// src/lib/format/ckb.ts
import { formatThousands } from "./thousands";

const SHANNONS_PER_CKB = 100_000_000n;

export function formatCkb(shannons: bigint): string {
  const whole = shannons / SHANNONS_PER_CKB;
  const fractional = shannons % SHANNONS_PER_CKB;
  if (fractional === 0n) return formatThousands(whole);
  // Trim trailing zeros from the 8-digit fractional part for readability.
  const fracStr = fractional.toString().padStart(8, "0").replace(/0+$/, "");
  return `${formatThousands(whole)}.${fracStr}`;
}
```

`btc.ts`, `sol.ts`, `evm.ts`, and `chain-badge.ts` take their bodies verbatim from `TreasuryDetail.tsx` lines 789–817, 859–864, and 921–929, each importing `formatThousands` from `./thousands`. `formatEth` uses `formatEther` from `viem`, matching the current implementation at line 859.

- [ ] **Step 5: Run to verify it passes**

Run: `npm --workspace apps/desktop run test -- src/lib/format/format.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/format/
git commit -m "feat(desktop): add shared format module with unit coverage"
```

---

### Task 7: Shared presentational atoms

**Files:**
- Create: `apps/desktop/src/components/ui/Tile.tsx`, `ReviewValue.tsx`, `Section.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `<Tile label={string} value={string} />` — plus any extra props the existing three copies take; reconcile in Step 1.
  - `<ReviewValue label={string} value={string} />`
  - `<Section title={string}>{children}</Section>`

- [ ] **Step 1: Diff the three `Tile` copies before writing**

Run: `sed -n '182,200p' apps/desktop/src/features/dashboard/Dashboard.tsx; sed -n '866,890p' apps/desktop/src/features/treasury/TreasuryDetail.tsx; sed -n '495,510p' apps/desktop/src/features/evm/SafeApprovalDetail.tsx`

They are unlikely to be identical — `TreasuryDetail`'s spans lines 866–886 and takes more props. Take the **superset**: the union of props, with the extras optional so the simpler call sites are unaffected. If a visual difference exists (padding, text size), keep `TreasuryDetail`'s and record the change; do not silently restyle Dashboard.

- [ ] **Step 2: Write the components**

```tsx
// src/components/ui/Section.tsx
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}
```

```tsx
// src/components/ui/ReviewValue.tsx
export function ReviewValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-surface-hi p-3">
      <div className="text-fg-muted">{label}</div>
      <div className="mt-1 font-medium tabular-nums">{value}</div>
    </div>
  );
}
```

`Tile.tsx` is written from the Step 1 superset.

- [ ] **Step 3: Verify nothing is broken yet**

Run: `npm run typecheck`
Expected: clean. Nothing imports these yet; this step only proves they compile.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/ui/
git commit -m "feat(desktop): add shared Tile/ReviewValue/Section atoms"
```

---

### Task 8: Split TreasuryDetail into per-chain files

**Files:**
- Create: `apps/desktop/src/features/treasury/CkbTreasuryDetail.tsx`, `EvmTreasuryDetail.tsx`, `BitcoinWatchDetail.tsx`, `SolanaWatchDetail.tsx`
- Modify: `apps/desktop/src/features/treasury/TreasuryDetail.tsx` (reduce to the router at lines 36–62)

**Interfaces:**
- Consumes: Task 6 formatters, Task 7 atoms.
- Produces: four named exports — `CkbTreasuryDetail`, `EvmTreasuryDetail`, `BitcoinWatchDetail`, `SolanaWatchDetail` — each taking `{ treasury }` with the types already used at `TreasuryDetail.tsx:64, 168, 293, 384`.

- [ ] **Step 1: Confirm the existing tests pass before touching anything**

Run: `npm --workspace apps/desktop run test -- src/features/treasury/`
Expected: PASS. Record the exact test count; it must be identical at Step 5.

- [ ] **Step 2: Move each component to its own file**

Cut these line ranges from `TreasuryDetail.tsx` into the matching new file, adding `export` to each function:

| Component | Current lines | New file |
|---|---|---|
| `SolanaWatchDetail` | 64–167 | `SolanaWatchDetail.tsx` |
| `CkbTreasuryDetail` | 168–292 | `CkbTreasuryDetail.tsx` |
| `EvmTreasuryDetail` | 293–383 | `EvmTreasuryDetail.tsx` |
| `BitcoinWatchDetail` | 384–788 | `BitcoinWatchDetail.tsx` |

Also move the chain-local helpers each one uses: `broadcastStateLabel` (827), `broadcastStatusLabel` (840), and `bitcoinAccountingStateLabel` (847) go with `BitcoinWatchDetail`; `balanceDisplay` (887), `secondsAgo` (917), and `formatBlockNumber` (913) go to whichever files use them — grep each name and, if two files need it, put it in `lib/format/` alongside Task 6's modules rather than duplicating.

Each new file imports its formatters from `@/lib/format/*` and its atoms from `@/components/ui/*`. Delete the local copies as you go — do not leave both.

- [ ] **Step 3: Reduce `TreasuryDetail.tsx` to the router**

Keep lines 36–62 verbatim, replace the removed function bodies with imports:

```tsx
import { BitcoinWatchDetail } from "./BitcoinWatchDetail";
import { CkbTreasuryDetail } from "./CkbTreasuryDetail";
import { EvmTreasuryDetail } from "./EvmTreasuryDetail";
import { SolanaWatchDetail } from "./SolanaWatchDetail";
```

Prune the now-unused imports at lines 1–34 — the router itself needs only `useNavigate`, `useParams`, the three type guards, and `useTreasuryStore`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean. Type errors here are almost always a missed import of a type that was previously file-local.

- [ ] **Step 5: Run the treasury tests unmodified**

Run: `npm --workspace apps/desktop run test -- src/features/treasury/`
Expected: PASS with the **same test count as Step 1**, and with zero changes to either test file. The tests import `{ TreasuryDetail } from "./TreasuryDetail"` and render through the router, so they exercise the extracted components without knowing they moved.

- [ ] **Step 6: Verify the split hit the target**

Run: `wc -l apps/desktop/src/features/treasury/*.tsx`
Expected: `TreasuryDetail.tsx` under 80 lines; `BitcoinWatchDetail.tsx` is the largest at roughly 420 — still over the 400 guideline but under the 800 limit, and further splitting it is out of scope for this plan.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/features/treasury/
git commit -m "refactor(desktop): split TreasuryDetail into per-chain components"
```

---

### Task 9: Delete the duplicated formatters across features

**Files:**
- Modify: `apps/desktop/src/features/sign/SignPanel.tsx` (delete 237–245), `features/dashboard/Dashboard.tsx` (delete the local `Tile`), `features/evm/SafeApprovalDetail.tsx` (delete 495–510), `features/treasury/TreasuryList.tsx` (delete 137+), `features/payments/PayPanel.tsx` (delete 977–981 and 1174–1181)

**Interfaces:**
- Consumes: Task 6 formatters, Task 7 atoms.
- Produces: no new exports. This is the task that realises the declared behaviour change.

- [ ] **Step 1: Find every remaining private copy**

Run: `grep -rn "function formatCkb\|function shannonsToCkbDisplay\|function formatThousands\|function chainBadge\|function Tile\|function Section" apps/desktop/src --include=*.tsx --include=*.ts`

Expected before: 9 hits outside `lib/format/` and `components/ui/`. Expected after this task: zero.

- [ ] **Step 2: Replace each copy with an import**

For each file, delete the local function and add the import. In `PayPanel.tsx` both `formatCkb` (1174) and `shannonsToCkbDisplay` (977) are deleted, and **every `shannonsToCkbDisplay(` call site becomes `formatCkb(`**. Find them with:

Run: `grep -n "shannonsToCkbDisplay(" apps/desktop/src/features/payments/PayPanel.tsx`

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Run the full desktop suite**

Run: `npm --workspace apps/desktop run test`
Expected: `154 files, 1077 passed | 4 skipped` — the same baseline. A failure here means a test asserted on an un-separated number produced by `shannonsToCkbDisplay`. That is the declared behaviour change surfacing: verify the failing assertion is a display string, update **that assertion only**, and note it in the commit message. If the failure is anything other than thousands separators, revert and investigate.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/
git commit -m "refactor(desktop): consolidate duplicated formatters and UI atoms

Deletes shannonsToCkbDisplay in favour of formatCkb; its call sites now
render thousands separators. This is the one declared behaviour change."
```

---

# Workstream 3 — PayPanel: cover, then split

### Task 10: Extract the pure CKB byte and unit helpers

**Files:**
- Create: `apps/desktop/src/lib/chains/ckb/bytes.ts`, `units.ts`, `address-lock.ts`
- Create: `apps/desktop/src/lib/chains/ckb/bytes.test.ts`, `units.test.ts`, `address-lock.test.ts`
- Modify: `apps/desktop/src/features/payments/PayPanel.tsx` (delete 967–975, 1149–1172; import instead)

**Interfaces:**
- Consumes: `@ckb-ccc/core` (`Script`, `hashTypeFrom`, `hexFrom`), `@ckb-ccc/core/advanced` (`addressPayloadFromString`).
- Produces:
  - `bytesEqual(a: Uint8Array, b: Uint8Array): boolean`
  - `bytesHex(b: Uint8Array): string`
  - `ckbToShannons(amountCkb: string): bigint | null`
  - `lockFromAddress(addr: string): Script`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/chains/ckb/bytes.test.ts
import { describe, expect, it } from "vitest";
import { bytesEqual, bytesHex } from "./bytes";

describe("bytesEqual", () => {
  it("is true for identical contents", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("is false for different lengths", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("is false for a single differing byte", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it("is true for two empty arrays", () => {
    expect(bytesEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});

describe("bytesHex", () => {
  it("pads each byte to two hex digits without a 0x prefix", () => {
    expect(bytesHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });

  it("returns an empty string for empty input", () => {
    expect(bytesHex(new Uint8Array())).toBe("");
  });
});
```

```typescript
// src/lib/chains/ckb/units.test.ts
import { describe, expect, it } from "vitest";
import { ckbToShannons } from "./units";

describe("ckbToShannons", () => {
  it("converts whole CKB", () => {
    expect(ckbToShannons("1")).toBe(100_000_000n);
  });

  it("converts fractional CKB, padding to 8 decimals", () => {
    expect(ckbToShannons("1.5")).toBe(150_000_000n);
    expect(ckbToShannons("0.00000001")).toBe(1n);
  });

  it("truncates beyond 8 decimals rather than rounding", () => {
    expect(ckbToShannons("1.123456789")).toBe(112_345_678n);
  });

  it("trims surrounding whitespace", () => {
    expect(ckbToShannons("  1  ")).toBe(100_000_000n);
  });

  it("returns null for zero, negatives, and non-numeric input", () => {
    expect(ckbToShannons("0")).toBeNull();
    expect(ckbToShannons("-1")).toBeNull();
    expect(ckbToShannons("abc")).toBeNull();
    expect(ckbToShannons("")).toBeNull();
  });
});
```

```typescript
// src/lib/chains/ckb/address-lock.test.ts
import { describe, expect, it } from "vitest";
import { lockFromAddress } from "./address-lock";

// A CKB2021 full-format testnet address (secp256k1_blake160_sighash_all).
const TESTNET_ADDRESS =
  "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqvf60vf0ggcgs7cmy4rlnvcrehzhy87d0qptn0hd";

describe("lockFromAddress", () => {
  it("decodes code hash, hash type, and args from a full address", () => {
    const script = lockFromAddress(TESTNET_ADDRESS);
    expect(script.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(script.args).toMatch(/^0x[0-9a-f]+$/);
  });

  it("throws on an empty address", () => {
    expect(() => lockFromAddress("")).toThrow("Recipient address is empty");
  });

  it("throws on a malformed address", () => {
    expect(() => lockFromAddress("not-an-address")).toThrow();
  });
});
```

If `TESTNET_ADDRESS` above does not decode, take a real one from `debug/keystores/setup.json` or from the confirmed testnet tx recorded in the README rather than hand-constructing one.

- [ ] **Step 2: Run to verify they fail**

Run: `npm --workspace apps/desktop run test -- src/lib/chains/ckb/bytes.test.ts src/lib/chains/ckb/units.test.ts src/lib/chains/ckb/address-lock.test.ts`
Expected: FAIL — `Failed to resolve import "./bytes"`

- [ ] **Step 3: Create the modules by moving the functions verbatim**

`bytes.ts` takes `PayPanel.tsx:967–975`; `units.ts` takes `1162–1172` plus the `SHANNONS_PER_CKB` constant from line 58; `address-lock.ts` takes `1149–1160`. Add `export` to each. Do not "improve" them — behaviour must be identical, and `ckbToShannons`'s truncation is pinned by the test above.

- [ ] **Step 4: Run to verify they pass**

Run: `npm --workspace apps/desktop run test -- src/lib/chains/ckb/`
Expected: PASS

- [ ] **Step 5: Import them in PayPanel and delete the local copies**

```typescript
import { bytesEqual, bytesHex } from "@/lib/chains/ckb/bytes";
import { ckbToShannons } from "@/lib/chains/ckb/units";
import { lockFromAddress } from "@/lib/chains/ckb/address-lock";
```

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npm run typecheck && npm --workspace apps/desktop run test`
Expected: clean typecheck; test count is baseline + the new files' tests.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/lib/chains/ckb/ apps/desktop/src/features/payments/PayPanel.tsx
git commit -m "refactor(payments): extract pure CKB byte/unit/address helpers with tests"
```

---

### Task 11: Extract and test the multisig pre-broadcast assertion

**Files:**
- Create: `apps/desktop/src/lib/chains/ckb/multisig-assert.ts`
- Create: `apps/desktop/src/lib/chains/ckb/multisig-assert.test.ts`
- Modify: `apps/desktop/src/features/payments/PayPanel.tsx` (delete 902–965; import instead)

**Interfaces:**
- Consumes: Task 10's `bytesEqual`/`bytesHex`; `encodeMultisigScript`, `lockArgsFromConfig`, `CkbMultisigConfig` from `@/lib/chains/ckb/multisig`; `CkbMultisig` from `@chain-pay/shared`.
- Produces:
  - `assertMultisigBytesMatchTreasury(tx: Transaction, cfg: CkbMultisigConfig, multisig: CkbMultisig): void`
  - `dumpInputsForInspection(tx: Transaction, multisig: CkbMultisig): void`

This is the highest-value test in the plan: a security check on the -52 `ERROR_MULTSIG_SCRIPT_HASH` class of failures that currently has no coverage at all.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Transaction, WitnessArgs, hexFrom } from "@ckb-ccc/core";
import type { CkbMultisig } from "@chain-pay/shared";
import {
  assertMultisigBytesMatchTreasury,
  dumpInputsForInspection,
} from "./multisig-assert";
import {
  encodeMultisigScript,
  lockArgsFromConfig,
  type CkbMultisigConfig,
} from "./multisig";
import { deriveMultisigAddress } from "./address";

// A 2-of-3 config. Pubkey hashes are 20-byte blake160 values; exact values do
// not matter as long as the address is derived from THIS config, because the
// assertion compares the address's decoded args against the config's own hash.
const CFG: CkbMultisigConfig = {
  s: 0,
  r: 0,
  m: 2,
  n: 3,
  pubkeyHashes: [
    "0x" + "11".repeat(20),
    "0x" + "22".repeat(20),
    "0x" + "33".repeat(20),
  ],
};

function multisigFor(cfg: CkbMultisigConfig, chain: "ckb:testnet" = "ckb:testnet"): CkbMultisig {
  return {
    chain,
    ...cfg,
    address: deriveMultisigAddress(cfg, chain),
  } as CkbMultisig;
}

function txWithWitnessLock(lock: Uint8Array): Transaction {
  const tx = Transaction.from({ inputs: [], outputs: [], outputsData: [] });
  tx.witnesses = [hexFrom(WitnessArgs.from({ lock: hexFrom(lock) }).toBytes())];
  return tx;
}

describe("assertMultisigBytesMatchTreasury", () => {
  it("passes when the witness script and the address both match the config", () => {
    const { multisigScript } = encodeMultisigScript(CFG);
    const lock = new Uint8Array(multisigScript.length + 65 * CFG.m);
    lock.set(multisigScript, 0);
    expect(() =>
      assertMultisigBytesMatchTreasury(txWithWitnessLock(lock), CFG, multisigFor(CFG)),
    ).not.toThrow();
  });

  it("throws when the treasury address decodes to different lock args", () => {
    const otherCfg: CkbMultisigConfig = {
      ...CFG,
      pubkeyHashes: ["0x" + "99".repeat(20), "0x" + "88".repeat(20), "0x" + "77".repeat(20)],
    };
    const { multisigScript } = encodeMultisigScript(CFG);
    const lock = new Uint8Array(multisigScript.length + 65 * CFG.m);
    lock.set(multisigScript, 0);
    expect(() =>
      assertMultisigBytesMatchTreasury(txWithWitnessLock(lock), CFG, multisigFor(otherCfg)),
    ).toThrow(/Treasury config drift/);
  });

  it("throws when witness[0].lock is shorter than the multisig script prefix", () => {
    expect(() =>
      assertMultisigBytesMatchTreasury(
        txWithWitnessLock(new Uint8Array(8)),
        CFG,
        multisigFor(CFG),
      ),
    ).toThrow(/witness\[0\]\.lock too short/);
  });

  it("throws when witness[0] carries a different multisig script", () => {
    const wrong = encodeMultisigScript({
      ...CFG,
      pubkeyHashes: ["0x" + "aa".repeat(20), "0x" + "bb".repeat(20), "0x" + "cc".repeat(20)],
    }).multisigScript;
    const lock = new Uint8Array(wrong.length + 65 * CFG.m);
    lock.set(wrong, 0);
    expect(() =>
      assertMultisigBytesMatchTreasury(txWithWitnessLock(lock), CFG, multisigFor(CFG)),
    ).toThrow(/multisig_script doesn't match/);
  });
});

describe("dumpInputsForInspection", () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__chainpay_debug;
  });

  it("publishes the debug global that smoke sessions read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tx = Transaction.from({ inputs: [], outputs: [], outputsData: [] });
    dumpInputsForInspection(tx, multisigFor(CFG));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const debug = (globalThis as any).__chainpay_debug;
    expect(debug).toBeDefined();
    expect(debug.treasuryAddress).toBe(multisigFor(CFG).address);
    expect(debug.expectedLockArgs).toMatch(/^0x[0-9a-f]{40}$/);
    expect(Array.isArray(debug.inputs)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

Check the real signatures before writing: run `grep -n "export function\|export interface\|export type" apps/desktop/src/lib/chains/ckb/multisig.ts apps/desktop/src/lib/chains/ckb/address.ts`. Adjust `CkbMultisigConfig` field names and the address-derivation helper name to match. If `deriveMultisigAddress` has a different name, use the real one — do not add a wrapper.

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace apps/desktop run test -- src/lib/chains/ckb/multisig-assert.test.ts`
Expected: FAIL — `Failed to resolve import "./multisig-assert"`

- [ ] **Step 3: Create the module**

Move `PayPanel.tsx:902–965` verbatim (both functions plus their doc comments), adding `export` to each and importing `bytesEqual`/`bytesHex` from `./bytes`. Keep the `eslint-disable-next-line @typescript-eslint/no-explicit-any` comments — they are load-bearing for lint.

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace apps/desktop run test -- src/lib/chains/ckb/multisig-assert.test.ts`
Expected: PASS, 5 tests.

If the "passes when..." case throws `Treasury config drift`, the test's address derivation does not match what `lockArgsFromConfig` produces — fix the test's helper, not the assertion.

- [ ] **Step 5: Import in PayPanel, delete the local copies, verify**

Run: `npm run typecheck && npm --workspace apps/desktop run test`
Expected: clean typecheck, full suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/chains/ckb/ apps/desktop/src/features/payments/PayPanel.tsx
git commit -m "test(payments): cover assertMultisigBytesMatchTreasury and extract it

The -52 pre-broadcast guard had no test coverage. Adds positive, drift,
short-witness, and wrong-script cases before moving it out of PayPanel."
```

---

### Task 12: Extract the payment-draft helpers

**Files:**
- Create: `apps/desktop/src/features/payments/payment-draft.ts`
- Create: `apps/desktop/src/features/payments/payment-draft.test.ts`
- Modify: `apps/desktop/src/features/payments/PayPanel.tsx` (delete 983–1022; import instead)

**Interfaces:**
- Consumes: Task 10's `ckbToShannons`; `PayeeProfile`, `PayrollBatchLine` from `@chain-pay/shared`; the `RecipientRow` interface at `PayPanel.tsx:61–68`.
- Produces:
  - `RecipientRow` interface — **moved here** and re-exported, since both `PayPanel` and the Task 14 subcomponents need it.
  - `buildBatchLinesFromRecipients(rows: RecipientRow[], findPayee: (id: string) => PayeeProfile | undefined): PayrollBatchLine[]`
  - `autoLabel(now?: Date): string` · `monthStart(now?: Date): string` · `monthEnd(now?: Date): string`

The three date helpers gain an **optional** `now` parameter defaulting to `new Date()`. Without it they are untestable, and every existing call site passes nothing, so behaviour is unchanged.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import type { PayeeProfile } from "@chain-pay/shared";
import {
  autoLabel,
  buildBatchLinesFromRecipients,
  monthEnd,
  monthStart,
  type RecipientRow,
} from "./payment-draft";

const PAYEE: PayeeProfile = {
  id: "payee-1",
  name: "Vendor One",
  salaryFiat: { currency: "USD", minor: 250_000 },
  ckbAddress: "ckt1qtest",
} as PayeeProfile;

const findPayee = (id: string) => (id === PAYEE.id ? PAYEE : undefined);

describe("buildBatchLinesFromRecipients", () => {
  it("builds one line per complete payee row", () => {
    const rows: RecipientRow[] = [
      { address: "ckt1qa", amountCkb: "1000", payeeId: "payee-1", fxRate: "0.005" },
    ];
    const lines = buildBatchLinesFromRecipients(rows, findPayee);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      payeeId: "payee-1",
      fiat: PAYEE.salaryFiat,
      crypto: { asset: "CKB", value: 100_000_000_000n, decimals: 8 },
      fxRate: "0.005",
      feeAllocated: { asset: "CKB", value: 0n, decimals: 8 },
    });
  });

  it("skips rows with no payee id", () => {
    const rows: RecipientRow[] = [{ address: "ckt1qa", amountCkb: "1000", fxRate: "0.005" }];
    expect(buildBatchLinesFromRecipients(rows, findPayee)).toHaveLength(0);
  });

  it("skips rows with no fx rate", () => {
    const rows: RecipientRow[] = [
      { address: "ckt1qa", amountCkb: "1000", payeeId: "payee-1" },
    ];
    expect(buildBatchLinesFromRecipients(rows, findPayee)).toHaveLength(0);
  });

  it("skips rows whose payee cannot be resolved", () => {
    const rows: RecipientRow[] = [
      { address: "ckt1qa", amountCkb: "1000", payeeId: "ghost", fxRate: "0.005" },
    ];
    expect(buildBatchLinesFromRecipients(rows, findPayee)).toHaveLength(0);
  });

  it("skips rows whose amount does not parse", () => {
    const rows: RecipientRow[] = [
      { address: "ckt1qa", amountCkb: "not-a-number", payeeId: "payee-1", fxRate: "0.005" },
    ];
    expect(buildBatchLinesFromRecipients(rows, findPayee)).toHaveLength(0);
  });
});

describe("date helpers", () => {
  const NOW = new Date(2026, 1, 14); // 14 Feb 2026, local time

  it("labels a batch with the ISO date", () => {
    expect(autoLabel(NOW)).toBe(`Batch ${NOW.toISOString().slice(0, 10)}`);
  });

  it("returns the first day of the current month", () => {
    expect(monthStart(NOW)).toBe("2026-02-01");
  });

  it("returns the last day of the current month", () => {
    expect(monthEnd(NOW)).toBe("2026-02-28");
  });

  it("handles a 31-day month", () => {
    expect(monthEnd(new Date(2026, 0, 5))).toBe("2026-01-31");
  });
});
```

`PayeeProfile`'s real shape may differ from the cast above — run `grep -n "PayeeProfile" packages/shared/src/*.ts` and build a valid literal instead of casting if the fields differ.

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace apps/desktop run test -- src/features/payments/payment-draft.test.ts`
Expected: FAIL — `Failed to resolve import "./payment-draft"`

- [ ] **Step 3: Create the module**

Move `PayPanel.tsx:983–1022` and the `RecipientRow` interface from lines 61–68. Add the optional `now` parameter to the three date helpers:

```typescript
export function autoLabel(now: Date = new Date()): string {
  return `Batch ${now.toISOString().slice(0, 10)}`;
}

export function monthStart(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

export function monthEnd(now: Date = new Date()): string {
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace apps/desktop run test -- src/features/payments/payment-draft.test.ts`
Expected: PASS

- [ ] **Step 5: Import in PayPanel, delete the local copies, verify**

Run: `npm run typecheck && npm --workspace apps/desktop run test`
Expected: clean; full suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/features/payments/
git commit -m "refactor(payments): extract payment-draft helpers with tests"
```

---

### Task 13: Characterization tests for PayPanel

**Files:**
- Create: `apps/desktop/src/features/payments/PayPanel.test.tsx`

**Interfaces:**
- Consumes: the current `PayPanel` export, unchanged.
- Produces: the safety net that Tasks 14–15 must not disturb.

**This task changes no production code.** If you find yourself editing `PayPanel.tsx`, stop.

- [ ] **Step 1: Study the existing component-test harness**

Run: `sed -n '1,120p' apps/desktop/src/features/treasury/TreasuryDetail.bitcoin.test.tsx`

Mirror its structure: `// @vitest-environment jsdom` on line 1, `cleanup` in `afterEach`, Zustand stores primed via `useXStore.setState(...)` in `beforeEach`, IPC bridges mocked with `vi.mock`, and rendering inside `MemoryRouter` + `QueryClientProvider`.

- [ ] **Step 2: Enumerate what PayPanel touches**

Run: `sed -n '77,115p;114,230p' apps/desktop/src/features/payments/PayPanel.tsx`

The mocks needed are: `useTreasuryStore`, `useSyncStore`, `usePayeesStore`, `usePayrollBatchesStore`, `useNetworkConfigStore`, `useIncomingSigsStore`, `lightClient` (`@/lib/light-client/client`), `buildPaymentSkeleton` (`@/lib/chains/ckb/tx-builder`), `encodeTransferPacket` + `treasurySighashDigest` (`@/lib/chains/ckb/transfer-packet`), `mergeSignatures` (`@/lib/chains/ckb/merge-signatures`), and `fetchCkbPrices` (`@/lib/fx/coingecko`).

- [ ] **Step 3: Write the characterization tests**

Each `it` pins one currently-observable behaviour. Write them against the component as it is today; do not fix anything you find odd — record it in the commit message instead.

These selectors come from the current JSX and are stable to query against:

| Element | Query |
|---|---|
| Recipient address input | `getAllByPlaceholderText("ckb1… or ckt1…")` |
| Recipient amount input | `getAllByPlaceholderText("amount CKB")` |
| Remove-row button | `getAllByRole("button", { name: "×" })` — `disabled` when one row remains |
| Add-row button | `getByText("+ add recipient")` |
| Label input | `getByPlaceholderText("e.g. March payroll batch")` |
| Build button | `getByRole("button", { name: /Build payment\|waiting for sync…\|fetching cells/ })` |
| Broadcast button | `getByRole("button", { name: /Merge & broadcast\|broadcasting…/ })` |
| Signature textareas | `getAllByPlaceholderText("0x… (130 hex chars)")` |
| Success panel | `getByText("Broadcast successful")` |
| Explorer link | `getByRole("link", { name: /View on explorer/ })` |

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { PayPanel } from "./PayPanel";
import { useTreasuryStore } from "@/stores/treasury";
import { useSyncStore } from "@/stores/sync";
import { buildPaymentSkeleton } from "@/lib/chains/ckb/tx-builder";

vi.mock("@/lib/chains/ckb/tx-builder", () => ({ buildPaymentSkeleton: vi.fn() }));
vi.mock("@/lib/fx/coingecko", () => ({
  fetchCkbPrices: vi.fn(),
  fiatToCkbShannons: vi.fn(),
  formatFxQuote: vi.fn(() => "1 CKB = $0.005"),
}));

// Fill in from the real store shapes; mirror TreasuryDetail.bitcoin.test.tsx's
// TREASURY constant. The multisig config must be a valid 2-of-3 so the panel
// renders past its treasury guard.
const TREASURY = {
  /* id, kind, label, createdAt, updatedAt, multisig: { chain: "ckb:testnet", s, r, m, n, pubkeyHashes, address } */
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PayPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useTreasuryStore.setState({ treasuries: [TREASURY as never], activeTreasuryId: "ckb-1" });
  // syncReady gates the Build button — prime it or every build test fails on a
  // disabled control rather than on the behaviour under test.
  useSyncStore.setState({ ckb: { ready: true } as never });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PayPanel — draft phase", () => {
  it("starts with exactly one recipient row whose remove button is disabled", () => {
    renderPanel();
    expect(screen.getAllByPlaceholderText("ckb1… or ckt1…")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "×" })).toBeDisabled();
  });

  it("adds a recipient row and enables removal once there are two", () => {
    renderPanel();
    fireEvent.click(screen.getByText("+ add recipient"));
    expect(screen.getAllByPlaceholderText("ckb1… or ckt1…")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "×" })[0]).not.toBeDisabled();
  });

  it("removes the row that was clicked, keeping the others' values", () => {
    renderPanel();
    fireEvent.click(screen.getByText("+ add recipient"));
    const addresses = screen.getAllByPlaceholderText("ckb1… or ckt1…");
    fireEvent.change(addresses[0], { target: { value: "ckt1qfirst" } });
    fireEvent.change(addresses[1], { target: { value: "ckt1qsecond" } });
    fireEvent.click(screen.getAllByRole("button", { name: "×" })[0]);
    const remaining = screen.getAllByPlaceholderText("ckb1… or ckt1…");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toHaveValue("ckt1qsecond");
  });

  it("strips non-digits from the fee rate input", () => {
    renderPanel();
    const feeRate = screen.getByDisplayValue("1000");
    fireEvent.change(feeRate, { target: { value: "12a3b" } });
    expect(feeRate).toHaveValue("123");
  });

  it("disables Build until the light client reports sync ready", () => {
    useSyncStore.setState({ ckb: { ready: false } as never });
    renderPanel();
    expect(screen.getByRole("button", { name: /waiting for sync/ })).toBeDisabled();
  });
});

describe("PayPanel — build", () => {
  it("passes the entered recipients and fee rate to buildPaymentSkeleton", async () => {
    renderPanel();
    fireEvent.change(screen.getByPlaceholderText("ckb1… or ckt1…"), {
      target: { value: "ckt1qrecipient" },
    });
    fireEvent.change(screen.getByPlaceholderText("amount CKB"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Build payment/ }));
    await waitFor(() => expect(buildPaymentSkeleton).toHaveBeenCalledTimes(1));
    // Assert on the recipient amount reaching the builder as shannons, not CKB.
    const call = vi.mocked(buildPaymentSkeleton).mock.calls[0]![0];
    expect(JSON.stringify(call)).toContain("10000000000");
  });

  it("surfaces a build failure and stays on the draft form", async () => {
    vi.mocked(buildPaymentSkeleton).mockRejectedValueOnce(new Error("no live cells"));
    renderPanel();
    fireEvent.change(screen.getByPlaceholderText("ckb1… or ckt1…"), {
      target: { value: "ckt1qrecipient" },
    });
    fireEvent.change(screen.getByPlaceholderText("amount CKB"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /Build payment/ }));
    await waitFor(() => expect(screen.getByText(/no live cells/)).toBeInTheDocument());
    expect(screen.getByPlaceholderText("ckb1… or ckt1…")).toBeInTheDocument();
  });
});
```

**The remaining cases depend on JSX this plan has not quoted** — `PacketPanel` (line 834), the batch-hydration effect (line 181), and the FX panel (line 860). Write them the same way: read the relevant JSX, render, run `screen.debug()` once to see the real markup, then assert. Each must end with at least one `expect`; a body that only calls `renderPanel()` is not a test.

Cases still to write, one `it` each:

1. Packet JSON is rendered once the skeleton builds (query the packet textarea/`<pre>` in `PacketPanel`).
2. Broadcast stays disabled while any signature textarea is empty, and enables when all are filled.
3. A successful broadcast shows `Broadcast successful`, the tx hash, and a `pudge.explorer.nervos.org` link on testnet.
4. The same flow on `ckb:mainnet` links to `explorer.nervos.org` (drive via `useNetworkConfigStore`).
5. Selecting a draft batch hydrates the recipient rows from its lines.
6. Selecting a draft batch belonging to another treasury switches `treasuryId` first, then hydrates on the next render.
7. A manual payment with no payee rows leaves no batch attached (assert no batch-store write).
8. A successful FX fetch fills the amount column for payee-sourced rows.
9. An FX fetch failure shows the error and leaves manually typed amounts untouched.

- [ ] **Step 4: Run and verify every test passes against unmodified PayPanel**

Run: `npm --workspace apps/desktop run test -- src/features/payments/PayPanel.test.tsx`
Expected: PASS, ~14 tests. Any failure means the test encodes an assumption the component does not hold — fix the test.

- [ ] **Step 5: Prove the tests have teeth**

Pick two tests — the build call and the signature gating — and temporarily break the component to confirm they fail:

- Comment out the `buildPaymentSkeleton` call in `handleBuild`; the build test must fail.
- Change the broadcast button's `disabled` expression at line 1089 to `disabled={busy}`; the signature-gating test must fail.

Run the suite after each, confirm the expected failure, then **revert both edits** with `git checkout -- apps/desktop/src/features/payments/PayPanel.tsx`.

This step is not optional. A characterization test that passes whether or not the behaviour exists provides no protection in Task 15, and the project has already been bitten by an assertion that matched every branch of the function it was testing.

- [ ] **Step 6: Confirm PayPanel.tsx is unmodified**

Run: `git diff --stat apps/desktop/src/features/payments/PayPanel.tsx`
Expected: empty output.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/features/payments/PayPanel.test.tsx
git commit -m "test(payments): characterization tests for PayPanel before splitting

Pins draft, build, packet, signature-gating, broadcast, batch-hydration,
and FX behaviour. Teeth verified by temporarily breaking two paths."
```

---

### Task 14: Extract PayPanel subcomponents

**Files:**
- Create: `apps/desktop/src/features/payments/DraftForm.tsx`, `PacketPanel.tsx`, `FxSnapshotPanel.tsx`, `SignaturePanel.tsx`, `BroadcastResult.tsx`
- Modify: `apps/desktop/src/features/payments/PayPanel.tsx` (delete 709–906, 1024–1144)

**Interfaces:**
- Consumes: Task 12's `RecipientRow`; Task 7's `Section`; Task 6's `formatCkb`.
- Produces: five named exports whose props are exactly the current inline props objects — `DraftForm` (709), `PacketPanel` (834), `FxSnapshotPanel` (860), `SignaturePanel` (1024), `BroadcastResult` (1099).

- [ ] **Step 1: Move each component verbatim**

Cut each function into its own file, add `export`, and import what it needs. `SignaturePanel` and `PacketPanel` use `Section` — import it from `@/components/ui/Section` (Task 7) and delete `PayPanel`'s local copy at line 1137.

`inputCls` (line 1146) is shared by several of them: move it to `features/payments/styles.ts` as `export const inputCls` rather than duplicating the string.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Run the characterization tests unchanged**

Run: `npm --workspace apps/desktop run test -- src/features/payments/`
Expected: PASS with **zero edits** to `PayPanel.test.tsx`. The tests render `PayPanel` and assert on DOM output, so moving children between files is invisible to them. A failure means something changed that should not have.

- [ ] **Step 4: Run the full suite and commit**

Run: `npm --workspace apps/desktop run test`
Expected: full suite green.

```bash
git add apps/desktop/src/features/payments/
git commit -m "refactor(payments): extract PayPanel subcomponents into files"
```

---

### Task 15: Extract the three state hooks

**Files:**
- Create: `apps/desktop/src/features/payments/hooks/usePaymentDraft.ts`, `useFxSnapshot.ts`, `usePaymentLifecycle.ts`
- Modify: `apps/desktop/src/features/payments/PayPanel.tsx`

**Interfaces:**
- Consumes: Task 12's `RecipientRow`; Task 13's characterization tests as the gate.
- Produces:
  - `usePaymentDraft(initialTreasuryId: string)` → `{ treasuryId, setTreasuryId, recipients, setRecipients, feeRate, setFeeRate, label, setLabel }`
  - `useFxSnapshot()` → `{ fxSnapshot, setFxSnapshot, fxLoading, setFxLoading, fxError, setFxError }`
  - `usePaymentLifecycle()` → `{ phase, setPhase, skeleton, setSkeleton, packetJson, setPacketJson, sigs, setSigs, broadcastedTxHash, setBroadcastedTxHash, activeBatchId, setActiveBatchId, reset }`

`reset()` returns the lifecycle to `phase: "draft"` with all other fields cleared — it replaces whatever the current "Send another" / `onReset` handler does inline. Read that handler first and reproduce it exactly.

- [ ] **Step 1: Write the hooks**

Each is a thin `useState` grouping — no logic moves into them in this task. Example:

```typescript
import { useState } from "react";
import type { FxQuote } from "@chain-pay/shared";

export function useFxSnapshot() {
  const [fxSnapshot, setFxSnapshot] = useState<Map<string, FxQuote>>(new Map());
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState<string | null>(null);
  return { fxSnapshot, setFxSnapshot, fxLoading, setFxLoading, fxError, setFxError };
}
```

- [ ] **Step 2: Rewire PayPanel to consume them**

Replace the 15 `useState` declarations (lines 85–110) with three hook calls plus the two that stay local:

```typescript
  const draft = usePaymentDraft(ckbTreasuries[0]?.id ?? "");
  const fx = useFxSnapshot();
  const lifecycle = usePaymentLifecycle();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
```

Then update every reference in the body. **Do not change any logic while doing this** — `setPhase("packet-ready")` becomes `lifecycle.setPhase("packet-ready")` and nothing more. Resist the urge to tidy the effects; that is a separate change with a separate risk profile.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. Errors here are usually a missed rename.

- [ ] **Step 4: Run the characterization tests unchanged — the gate**

Run: `npm --workspace apps/desktop run test -- src/features/payments/`
Expected: PASS with **zero edits** to `PayPanel.test.tsx`.

**If a characterization test fails, the hook extraction changed behaviour.** Revert with `git checkout -- apps/desktop/src/features/payments/PayPanel.tsx`, and re-approach in smaller pieces — one hook at a time, running the tests between each. If a test cannot be made to pass without editing it, invoke the spec's declared fallback: keep Tasks 10–14, abandon the hook extraction, and say so plainly in the PR.

- [ ] **Step 5: Verify the file shrank**

Run: `wc -l apps/desktop/src/features/payments/PayPanel.tsx`
Expected: under 500 lines, down from 1181.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm --workspace apps/desktop run test && npm run typecheck`

```bash
git add apps/desktop/src/features/payments/
git commit -m "refactor(payments): group PayPanel state into three hooks"
```

---

### Task 16: Fix backend test discovery, squash, and open the PR

**Files:**
- Move: `apps/backend/apps/crypto_payroll/crypto_payroll/test_api.py` → `.../crypto_payroll/tests/test_api.py`
- Create: `.../crypto_payroll/tests/__init__.py`
- Modify: `README.md` (the backend test command, if documented)

**Interfaces:**
- Consumes: everything.
- Produces: the delivery artefact.

This is deliberately last: the file being moved is the safety net for Workstream 1, so it stays exactly where it is until that work is proven.

- [ ] **Step 1: Record the baseline**

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api`
Expected: `Ran 32 tests ... OK`

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --app crypto_payroll`
Expected: `Ran 4 tests ... OK` — the problem being fixed.

- [ ] **Step 2: Move the test module into a discovered package**

```bash
mkdir -p apps/backend/apps/crypto_payroll/crypto_payroll/tests
touch apps/backend/apps/crypto_payroll/crypto_payroll/tests/__init__.py
git mv apps/backend/apps/crypto_payroll/crypto_payroll/test_api.py \
       apps/backend/apps/crypto_payroll/crypto_payroll/tests/test_api.py
```

The imports inside `test_api.py` are all absolute (`from crypto_payroll.api import ...`), so they need no change.

- [ ] **Step 3: Verify discovery now finds everything**

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --app crypto_payroll`
Expected: `Ran 36 tests ... OK` (32 + the 4 setup tests)

Run: `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.tests.test_api`
Expected: `Ran 32 tests ... OK`

**If `--app` still reports 4**, the discovery mechanism is something other than package layout. Revert the move (`git checkout -- .` plus removing the new directory), and instead document the working command prominently in `README.md` under the backend test instructions. A documented correct command beats a broken clever one — record which path you took in the commit message.

- [ ] **Step 4: Squash into the three delivery commits**

```bash
git log --oneline main..HEAD
git reset --soft main
```

Then stage and commit in three groups:

```bash
git add apps/backend/ docs/superpowers/
git commit -m "refactor(backend): split chain rules into a registry

Collapses ~15 per-chain branch sites in api/__init__.py and compliance.py
into CHAIN_RULES[chain]. Each chain module owns both inbound validation and
outbound digest reconstruction, so the two can no longer drift. Adds protocol
completeness and evidence round-trip tests, and fixes app-level test discovery."

git add apps/desktop/src/lib/format/ apps/desktop/src/components/ui/ \
        apps/desktop/src/features/treasury/ apps/desktop/src/features/dashboard/ \
        apps/desktop/src/features/evm/ apps/desktop/src/features/sign/
git commit -m "refactor(desktop): split TreasuryDetail and consolidate formatters

TreasuryDetail.tsx becomes a router over four per-chain files. Deletes three
formatCkb copies, three Tile copies, and two chainBadge copies. Deleting
shannonsToCkbDisplay adds thousands separators at its call sites — the one
declared behaviour change in this branch."

git add apps/desktop/src/features/payments/ apps/desktop/src/lib/chains/ckb/
git commit -m "refactor(payments): cover and split PayPanel

Adds the first test coverage for assertMultisigBytesMatchTreasury and for
PayPanel itself, then splits 1181 lines into pure helpers, five
subcomponents, and three state hooks. Characterization tests are unchanged
across the split."
```

Confirm nothing was dropped: `git diff main..HEAD --stat` before and after the squash must show identical totals. Capture the pre-squash output first.

- [ ] **Step 5: Full verification**

```bash
npm run typecheck
npm --workspace apps/desktop run test
npm --workspace apps/desktop run lint
docker exec chainpay-backend bench --site chainpay.localhost run-tests --app crypto_payroll
```

Expected: typecheck clean · desktop suite green at baseline + new tests · lint no new errors (the repo has 1 pre-existing lint error and 4 warnings — do not fix them here) · backend 36 tests OK.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin feat/consolidation-refactor
gh pr create --base main --title "refactor: consolidation pass — chain registry, TreasuryDetail split, PayPanel coverage" --body "$(cat <<'EOF'
## Summary

Behaviour-preserving consolidation after the four-chain expansion. No new features, no FX changes.

- **Backend chain registry** — ~15 per-chain branch sites collapse into `CHAIN_RULES[chain]`. Each chain module owns inbound validation and outbound digest reconstruction together, so they cannot drift.
- **TreasuryDetail split** — router over four per-chain files; formatters and UI atoms de-duplicated across five features.
- **PayPanel** — first-ever test coverage, then split from 1181 lines into helpers, subcomponents, and three hooks.

## Declared behaviour change

Deleting `shannonsToCkbDisplay` in favour of `formatCkb` adds thousands separators at those call sites. This is the only intended user-visible change.

## Test plan

- [x] `npm run typecheck` clean
- [x] Desktop suite green (baseline 1077 + new tests)
- [x] `bench run-tests --app crypto_payroll` — now 36 tests, was 4
- [x] `TreasuryDetail.bitcoin.test.tsx` / `.solana.test.tsx` pass unmodified
- [x] `PayPanel.test.tsx` unchanged across the subcomponent and hook splits
- [ ] Manual smoke: build a CKB payment draft, confirm amounts render with separators

Spec: `docs/superpowers/specs/2026-08-11-consolidation-refactor-design.md`
EOF
)"
```

---

## Verification summary

| Gate | Command | Expected |
|---|---|---|
| Backend (during W1) | `docker exec chainpay-backend bench --site chainpay.localhost run-tests --module crypto_payroll.test_api` | 28 → 32 OK |
| Backend (after T16) | `... run-tests --app crypto_payroll` | 36 OK |
| Desktop | `npm --workspace apps/desktop run test` | 1077 + new, 0 failures |
| Types | `npm run typecheck` | clean |
| Lint | `npm --workspace apps/desktop run lint` | no NEW errors |
| Size | `wc -l` on the three targets | api `<400`, TreasuryDetail `<80`, PayPanel `<500` |
