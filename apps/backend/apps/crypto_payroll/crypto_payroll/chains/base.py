"""Per-chain rules for confirmed-payment evidence, in both directions.

Each chain module owns the inbound validation (`normalise_evidence`) AND the
outbound reconstruction used for digest verification (`rebuild_evidence`).
They MUST produce identical key sets — a drift between them breaks
`_source_digests` and makes persisted records unverifiable. Keeping both in one
class is the point of this module.
"""
from __future__ import annotations

import hashlib
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
BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
BECH32_GENERATORS = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)


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


def bitcoin_address(value: object, chain: str, path: str) -> str:
    """Canonical Base58Check (P2PKH/P2SH) or bech32/bech32m address for `chain`."""
    text = str(value or "")
    if _is_base58check_address(text, chain):
        return text
    return _bech32_address(text, chain, path)


def _is_base58check_address(text: str, chain: str) -> bool:
    if not (26 <= len(text) <= 35) or any(
        character not in BASE58_INDEX for character in text
    ):
        return False
    number = 0
    for character in text:
        number = number * 58 + BASE58_INDEX[character]
    decoded = b"\0" * (len(text) - len(text.lstrip("1"))) + number.to_bytes(
        (number.bit_length() + 7) // 8, "big"
    )
    versions = {0, 5} if chain == "btc:mainnet" else {111, 196}
    return (
        len(decoded) == 25
        and decoded[0] in versions
        and hashlib.sha256(hashlib.sha256(decoded[:-4]).digest()).digest()[:4]
        == decoded[-4:]
    )


def _bech32_address(text: str, chain: str, path: str) -> str:
    lowered = text.lower()
    if text != lowered or "1" not in lowered:
        frappe.throw(f"{path} must be a canonical address for {chain}")
    hrp, data_text = lowered.rsplit("1", 1)
    if (
        hrp != ("bc" if chain == "btc:mainnet" else "tb")
        or len(data_text) < 7
        or len(lowered) > 90
    ):
        frappe.throw(f"{path} must be a canonical address for {chain}")
    try:
        data = [BECH32_ALPHABET.index(character) for character in data_text]
    except ValueError:
        frappe.throw(f"{path} must be a canonical address for {chain}")
    payload = data[:-6]
    polymod = _bech32_polymod(hrp, data)
    if not payload or payload[0] > 1 or polymod != (1 if payload[0] == 0 else 0x2BC830A3):
        frappe.throw(f"{path} must be a canonical address for {chain}")
    program, bits, accumulator = _bech32_program(payload[1:])
    if (
        bits >= 5
        or ((accumulator << (8 - bits)) & 255) != 0
        or len(program) < 2
        or len(program) > 40
        or (payload[0] == 0 and len(program) not in {20, 32})
        or (payload[0] == 1 and len(program) != 32)
    ):
        frappe.throw(f"{path} must be a canonical address for {chain}")
    return text


def _bech32_polymod(hrp: str, data: list[int]) -> int:
    polymod = 1
    expanded = (
        [ord(character) >> 5 for character in hrp]
        + [0]
        + [ord(character) & 31 for character in hrp]
        + data
    )
    for item in expanded:
        top = polymod >> 25
        polymod = (polymod & 0x1FFFFFF) << 5 ^ item
        for index, generator in enumerate(BECH32_GENERATORS):
            if (top >> index) & 1:
                polymod ^= generator
    return polymod


def _bech32_program(payload: list[int]) -> tuple[bytearray, int, int]:
    accumulator = 0
    bits = 0
    program = bytearray()
    for item in payload:
        accumulator = (accumulator << 5) | item
        bits += 5
        while bits >= 8:
            bits -= 8
            program.append((accumulator >> bits) & 255)
    return program, bits, accumulator
