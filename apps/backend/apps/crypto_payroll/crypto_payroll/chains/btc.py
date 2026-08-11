"""Bitcoin rules: per-output operator mapping, six-confirmation evidence."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

import frappe
from frappe.model.document import Document

from crypto_payroll.chains.base import (
    HEX_DIGEST,
    MAX_BTC_SATS,
    U64_MAX,
    bitcoin_address,
)

_TXID = re.compile(r"^[0-9a-f]{64}$")
_FEE_RATE = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$")
_MAX_VOUT = 4_294_967_295


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
            frappe.throw(
                "record.bitcoin confirmation depth or satoshi conservation is invalid"
            )
        rate = str(raw_bitcoin.get("feeRateSatsPerVbyte") or "")
        if not _FEE_RATE.fullmatch(rate):
            frappe.throw("record.bitcoin.feeRateSatsPerVbyte is invalid")
        if raw_bitcoin.get("feePayerPolicy") != "transaction_inputs":
            frappe.throw("record.bitcoin.feePayerPolicy must be transaction_inputs")
        outputs = self._normalise_outputs(raw_bitcoin.get("outputs"), lines)
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
            "bitcoin_outputs_json": _dump(outputs),
        }

    def _normalise_outputs(
        self, raw_outputs: object, lines: list[dict]
    ) -> list[dict[str, str]]:
        from crypto_payroll.api import _canonical_uint, _strict_keys

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
                maximum=_MAX_VOUT,
            )
            value_sats = _canonical_uint(
                output.get("valueSats"), f"record.bitcoin.outputs[{index}].valueSats",
                positive=True, maximum=MAX_BTC_SATS,
            )
            if vout <= previous_vout or value_sats != int(lines[index]["crypto_value"]):
                frappe.throw(
                    "record.bitcoin outputs must be ordered and match payment lines"
                )
            previous_vout = vout
            outputs.append({
                "vout": str(vout),
                "destination": bitcoin_address(
                    output.get("destination"), self.chain,
                    f"record.bitcoin.outputs[{index}].destination",
                ),
                "value_sats": str(value_sats),
            })
        return outputs

    def rebuild_evidence(self, batch: Document) -> dict | None:
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
            "bitcoin_outputs_json": _dump(outputs),
        }

    def journal_remark(self, batch: Document) -> str:
        if not batch.review_digest:
            return ""
        return (
            f" · Bitcoin review {batch.review_digest}"
            f" · block {batch.bitcoin_block_height}"
            f" · {batch.confirmations} confirmations"
            f" · fee {batch.fee_sats} sats paid by transaction inputs"
        )

    def network_fee(self, batch: Document) -> tuple[str, str, str] | None:
        from crypto_payroll.compliance import format_units

        if batch.fee_sats is None:
            return None
        value = str(batch.fee_sats)
        return (
            value,
            f"{format_units(value, 8)} BTC",
            batch.fee_payer_policy or "transaction_inputs",
        )


def _dump(outputs: object) -> str:
    return json.dumps(outputs, sort_keys=True, separators=(",", ":"))
