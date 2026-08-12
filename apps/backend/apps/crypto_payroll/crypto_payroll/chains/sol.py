"""Solana rules: durable-nonce evidence, base58 addresses, 64-byte signature."""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass

import frappe
from frappe.model.document import Document

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

    def rebuild_evidence(self, batch: Document) -> dict | None:
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

    def journal_remark(self, batch: Document) -> str:
        if not batch.review_digest:
            return ""
        return (
            f" · Solana review {batch.review_digest}"
            f" · finalized slot {batch.finalized_slot}"
            f" · fee {batch.fee_lamports} lamports paid by {batch.fee_payer_address}"
        )

    def network_fee(self, batch: Document) -> tuple[str, str, str] | None:
        from crypto_payroll.compliance import format_units

        if batch.fee_lamports is None:
            return None
        value = str(batch.fee_lamports)
        payer = f"{batch.fee_payer_policy}:{batch.fee_payer_address}"
        return value, f"{format_units(value, 9)} SOL", payer
