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
from frappe.model.document import Document

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

    def rebuild_evidence(self, batch: Document) -> dict | None: ...

    def journal_remark(self, batch: Document) -> str: ...

    def network_fee(self, batch: Document) -> tuple[str, str, str] | None: ...


def hex_tx_hash(value: object, path: str) -> str:
    """0x-prefixed 32-byte hash, lowercased. Used by CKB and EVM."""
    text = str(value or "").lower()
    if not TX_HASH.fullmatch(text):
        frappe.throw(f"{path} must be a 0x-prefixed 32-byte transaction hash")
    return text
