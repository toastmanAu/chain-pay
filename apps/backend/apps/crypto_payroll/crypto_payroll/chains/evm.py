"""Sepolia Safe rules: SafeTx evidence plus executor-paid gas metadata."""
from __future__ import annotations

from dataclasses import dataclass

import frappe
from frappe.model.document import Document

from crypto_payroll.chains.base import EVM_ADDRESS, TX_HASH, hex_tx_hash


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

    def rebuild_evidence(self, batch: Document) -> dict | None:
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

    def journal_remark(self, batch: Document) -> str:
        if not batch.safe_tx_hash:
            return ""
        return (
            f" · SafeTx {batch.safe_tx_hash}"
            f" · gas paid by executor {batch.executor_address}"
        )

    def network_fee(self, batch: Document) -> tuple[str, str, str] | None:
        from crypto_payroll.compliance import format_units

        if not batch.gas_fee_wei:
            return None
        value = str(batch.gas_fee_wei)
        return value, f"{format_units(value, 18)} ETH", batch.gas_payer or "executor"
