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
