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
BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
BASE58_INDEX = {character: index for index, character in enumerate(BASE58_ALPHABET)}


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


def base58_bytes(value: object, size: int, path: str) -> str:
    """Canonical base58 string decoding to exactly `size` bytes. Used by Solana."""
    text = str(value or "")
    if not text or any(character not in BASE58_INDEX for character in text):
        frappe.throw(f"{path} must be canonical base58")
    number = 0
    for character in text:
        number = number * 58 + BASE58_INDEX[character]
    decoded = (b"\x00" * (len(text) - len(text.lstrip("1")))) + (
        number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    )
    encoded = "1" * (len(decoded) - len(decoded.lstrip(b"\x00")))
    remainder = int.from_bytes(decoded, "big")
    suffix = ""
    while remainder:
        remainder, digit = divmod(remainder, 58)
        suffix = BASE58_ALPHABET[digit] + suffix
    if len(decoded) != size or encoded + suffix != text:
        frappe.throw(f"{path} must encode exactly {size} bytes")
    return text
