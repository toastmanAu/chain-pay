"""Whitelisted accounting API backed by immutable confirmed-payment records."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import timezone
from decimal import Decimal

import frappe
from frappe.utils import get_datetime

from crypto_payroll.chains import CHAIN_RULES
from crypto_payroll.chains.base import BASE58_INDEX, base58_bytes
from crypto_payroll.setup.custom_fields import ensure_custom_fields
from crypto_payroll.setup.seed import ensure_cost_center, ensure_fiscal_year
from crypto_payroll.compliance import export_payload, normalise_filters

COMPANY = "ChainPay Test"
COMPANY_CURRENCY = "USD"
EXPENSE_ACCOUNT = "Salary or Wage Expense"
TREASURY_ACCOUNT = "Crypto Treasury Asset"
_TX_HASH = re.compile(r"^0x[0-9a-fA-F]{64}$")
_HEX_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_U64_MAX = 18_446_744_073_709_551_615
_MAX_BTC_SATS = 2_100_000_000_000_000


def _strict_keys(value: dict, allowed: set[str], path: str) -> None:
    extras = set(value) - allowed
    if extras:
        frappe.throw(f"{path} contains unsupported fields")


def _canonical_uint(value, path: str, *, positive: bool = False, maximum=None) -> int:
    text = str(value)
    if not re.fullmatch(r"0|[1-9][0-9]*", text):
        frappe.throw(f"{path} must be a canonical decimal integer")
    number = int(text)
    if (positive and number <= 0) or (not positive and number < 0):
        frappe.throw(f"{path} is outside the supported range")
    if maximum is not None and number > maximum:
        frappe.throw(f"{path} is outside the supported range")
    return number


def _bitcoin_address(value, chain: str, path: str) -> str:
    text = str(value or "")
    if 26 <= len(text) <= 35 and all(character in BASE58_INDEX for character in text):
        number = 0
        for character in text:
            number = number * 58 + BASE58_INDEX[character]
        decoded = b"\0" * (len(text) - len(text.lstrip("1"))) + number.to_bytes((number.bit_length() + 7) // 8, "big")
        versions = {0, 5} if chain == "btc:mainnet" else {111, 196}
        if len(decoded) == 25 and decoded[0] in versions and hashlib.sha256(hashlib.sha256(decoded[:-4]).digest()).digest()[:4] == decoded[-4:]:
            return text
    lowered = text.lower()
    if text != lowered or "1" not in lowered:
        frappe.throw(f"{path} must be a canonical address for {chain}")
    hrp, data_text = lowered.rsplit("1", 1)
    if hrp != ("bc" if chain == "btc:mainnet" else "tb") or len(data_text) < 7 or len(lowered) > 90:
        frappe.throw(f"{path} must be a canonical address for {chain}")
    alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    try:
        data = [alphabet.index(character) for character in data_text]
    except ValueError:
        frappe.throw(f"{path} must be a canonical address for {chain}")
    polymod = 1
    expanded = [ord(character) >> 5 for character in hrp] + [0] + [ord(character) & 31 for character in hrp] + data
    for item in expanded:
        top = polymod >> 25
        polymod = (polymod & 0x1FFFFFF) << 5 ^ item
        for index, generator in enumerate((0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)):
            if (top >> index) & 1:
                polymod ^= generator
    payload = data[:-6]
    if not payload or payload[0] > 1 or polymod != (1 if payload[0] == 0 else 0x2BC830A3):
        frappe.throw(f"{path} must be a canonical address for {chain}")
    accumulator = 0
    bits = 0
    program = bytearray()
    for item in payload[1:]:
        accumulator = (accumulator << 5) | item
        bits += 5
        while bits >= 8:
            bits -= 8
            program.append((accumulator >> bits) & 255)
    if bits >= 5 or ((accumulator << (8 - bits)) & 255) != 0 or len(program) < 2 or len(program) > 40 or (payload[0] == 0 and len(program) not in {20, 32}) or (payload[0] == 1 and len(program) != 32):
        frappe.throw(f"{path} must be a canonical address for {chain}")
    return text


def _minor_to_major(minor: str) -> Decimal:
    return Decimal(int(minor)) / Decimal(100)


def _account(account_name: str) -> str:
    account = frappe.db.get_value(
        "Account",
        {"account_name": account_name, "company": COMPANY, "is_group": 0},
        "name",
    )
    if not account:
        frappe.throw(f"configured account is missing: {account_name}")
    return account


def _normalise_record(record: dict | str) -> dict:
    record = frappe.parse_json(record) if isinstance(record, str) else record
    if not isinstance(record, dict):
        frappe.throw("record must be an object")
    _strict_keys(record, {"batchId", "sourceType", "label", "chain", "txHash", "confirmedAt", "lines", "evm", "solana", "bitcoin"}, "record")

    batch_id = str(record.get("batchId") or "").strip()
    if not batch_id or len(batch_id) > 140:
        frappe.throw("record.batchId is required and must be at most 140 characters")

    source_type = str(record.get("sourceType") or "")
    if source_type not in {"send", "payroll"}:
        frappe.throw("record.sourceType must be send or payroll")

    chain = str(record.get("chain") or "")
    if chain not in {"ckb:mainnet", "ckb:testnet", "evm:11155111", "sol:devnet", "sol:mainnet", "btc:testnet", "btc:mainnet"}:
        frappe.throw("record.chain is unsupported")

    if chain.startswith("sol:"):
        tx_hash = base58_bytes(record.get("txHash"), 64, "record.txHash")
    elif chain.startswith("btc:"):
        tx_hash = str(record.get("txHash") or "")
        if not re.fullmatch(r"[0-9a-f]{64}", tx_hash):
            frappe.throw("record.txHash must be a lowercase Bitcoin transaction id")
    else:
        tx_hash = str(record.get("txHash") or "").lower()
        if not _TX_HASH.fullmatch(tx_hash):
            frappe.throw("record.txHash must be a 0x-prefixed 32-byte transaction hash")

    try:
        confirmed_at = get_datetime(record.get("confirmedAt"))
    except Exception:
        frappe.throw("record.confirmedAt must be a valid datetime")
    if not confirmed_at:
        frappe.throw("record.confirmedAt is required")
    # MariaDB's DATETIME is timezone-naive. Preserve the instant by converting
    # offset-aware input to UTC before dropping timezone metadata.
    if confirmed_at.tzinfo is not None:
        confirmed_at = confirmed_at.astimezone(timezone.utc).replace(tzinfo=None)

    label = str(record.get("label") or batch_id).strip()
    if not label or len(label) > 140:
        frappe.throw("record.label is required and must be at most 140 characters")

    raw_lines = record.get("lines")
    if not isinstance(raw_lines, list) or not raw_lines:
        frappe.throw("record.lines must contain at least one payment")

    lines = []
    currency = None
    total_minor = 0
    for index, raw in enumerate(raw_lines):
        if not isinstance(raw, dict):
            frappe.throw(f"record.lines[{index}] must be an object")
        _strict_keys(raw, {"payeeId", "fiat", "crypto"}, f"record.lines[{index}]")
        fiat = raw.get("fiat") or {}
        crypto = raw.get("crypto") or {}
        if not isinstance(fiat, dict) or not isinstance(crypto, dict):
            frappe.throw(f"record.lines[{index}] fiat and crypto must be objects")
        _strict_keys(fiat, {"currency", "minor"}, f"record.lines[{index}].fiat")
        _strict_keys(crypto, {"asset", "value", "decimals"}, f"record.lines[{index}].crypto")
        line_currency = str(fiat.get("currency") or "").upper()
        if not re.fullmatch(r"[A-Z]{3}", line_currency):
            frappe.throw(f"record.lines[{index}].fiat.currency must be a 3-letter code")
        if line_currency != COMPANY_CURRENCY:
            frappe.throw(
                f"record.lines[{index}].fiat.currency must match "
                f"{COMPANY}'s accounting currency ({COMPANY_CURRENCY})"
            )
        if currency is None:
            currency = line_currency
        elif currency != line_currency:
            frappe.throw("a confirmed payment record cannot mix fiat currencies")
        fiat_minor = _canonical_uint(fiat.get("minor"), f"record.lines[{index}].fiat.minor", positive=True)
        maximum = _U64_MAX if chain.startswith("sol:") else (_MAX_BTC_SATS if chain.startswith("btc:") else None)
        crypto_value = _canonical_uint(crypto.get("value"), f"record.lines[{index}].crypto.value", positive=True, maximum=maximum)
        crypto_decimals = _canonical_uint(crypto.get("decimals"), f"record.lines[{index}].crypto.decimals")
        if crypto_decimals < 0 or crypto_decimals > 30:
            frappe.throw(f"record.lines[{index}].crypto.decimals is invalid")
        crypto_asset = str(crypto.get("asset") or "").upper()
        expected_asset, expected_decimals = (
            ("ETH", 18) if chain == "evm:11155111" else
            (("SOL", 9) if chain.startswith("sol:") else (("BTC", 8) if chain.startswith("btc:") else ("CKB", 8)))
        )
        if crypto_asset != expected_asset or crypto_decimals != expected_decimals:
            frappe.throw(
                f"record.lines[{index}] must contain {expected_asset} "
                f"with {expected_decimals} decimals"
            )
        payee_id = str(raw.get("payeeId") or "").strip()
        if not payee_id or len(payee_id) > 140:
            frappe.throw(f"record.lines[{index}].payeeId is required")
        total_minor += fiat_minor
        lines.append(
            {
                "payee_id": payee_id,
                "fiat_currency": line_currency,
                "fiat_minor": str(fiat_minor),
                "crypto_asset": crypto_asset,
                "crypto_value": str(crypto_value),
                "crypto_decimals": crypto_decimals,
            }
        )

    # Dispatched through the chain-rules registry (crypto_payroll.chains).
    # Only migrated chains have an entry here — Solana and Bitcoin still use
    # their inline blocks below until Tasks 3/4 move them into the registry
    # too, so this looks up CHAIN_RULES directly rather than rules_for(),
    # which would throw for a chain that's merely "not yet migrated" instead
    # of one that's genuinely unsupported (already rejected above).
    rules = CHAIN_RULES.get(chain)
    evm = None
    if rules is not None and rules.evidence_key == "evm":
        evm = rules.normalise_evidence(record, lines, tx_hash)
    elif record.get("evm") is not None:
        frappe.throw("record.evm is only valid for EVM payments")

    solana = None
    if rules is not None and rules.evidence_key == "solana":
        solana = rules.normalise_evidence(record, lines, tx_hash)
    elif record.get("solana") is not None:
        frappe.throw("record.solana is only valid for Solana payments")

    bitcoin = None
    if chain.startswith("btc:"):
        raw_bitcoin = record.get("bitcoin")
        if not isinstance(raw_bitcoin, dict):
            frappe.throw("record.bitcoin is required for a Bitcoin payment")
        _strict_keys(raw_bitcoin, {"reviewDigest", "wtxid", "rawTransactionHash", "blockHeight", "blockHash", "confirmations", "inputValueSats", "outputValueSats", "feeSats", "feeRateSatsPerVbyte", "feePayerPolicy", "outputs"}, "record.bitcoin")
        hex_values = {}
        for field in ("reviewDigest", "wtxid", "rawTransactionHash", "blockHash"):
            value = str(raw_bitcoin.get(field) or "")
            if not _HEX_DIGEST.fullmatch(value):
                frappe.throw(f"record.bitcoin.{field} must be lowercase 32-byte hex")
            hex_values[field] = value
        block_height = _canonical_uint(raw_bitcoin.get("blockHeight"), "record.bitcoin.blockHeight", positive=True, maximum=_U64_MAX)
        confirmations = _canonical_uint(raw_bitcoin.get("confirmations"), "record.bitcoin.confirmations", positive=True, maximum=_U64_MAX)
        input_sats = _canonical_uint(raw_bitcoin.get("inputValueSats"), "record.bitcoin.inputValueSats", positive=True, maximum=_MAX_BTC_SATS)
        output_sats = _canonical_uint(raw_bitcoin.get("outputValueSats"), "record.bitcoin.outputValueSats", positive=True, maximum=_MAX_BTC_SATS)
        fee_sats = _canonical_uint(raw_bitcoin.get("feeSats"), "record.bitcoin.feeSats", positive=True, maximum=_MAX_BTC_SATS)
        if confirmations < 6 or input_sats != output_sats + fee_sats:
            frappe.throw("record.bitcoin confirmation depth or satoshi conservation is invalid")
        rate = str(raw_bitcoin.get("feeRateSatsPerVbyte") or "")
        if not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?", rate):
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
            _strict_keys(output, {"vout", "destination", "valueSats"}, f"record.bitcoin.outputs[{index}]")
            vout = _canonical_uint(output.get("vout"), f"record.bitcoin.outputs[{index}].vout", maximum=4_294_967_295)
            value_sats = _canonical_uint(output.get("valueSats"), f"record.bitcoin.outputs[{index}].valueSats", positive=True, maximum=_MAX_BTC_SATS)
            if vout <= previous_vout or value_sats != int(lines[index]["crypto_value"]):
                frappe.throw("record.bitcoin outputs must be ordered and match payment lines")
            previous_vout = vout
            outputs.append({"vout": str(vout), "destination": _bitcoin_address(output.get("destination"), chain, f"record.bitcoin.outputs[{index}].destination"), "value_sats": str(value_sats)})
        if sum(int(output["value_sats"]) for output in outputs) > output_sats:
            frappe.throw("record.bitcoin payment outputs exceed transaction outputs")
        bitcoin = {
            "review_digest": hex_values["reviewDigest"], "wtxid": hex_values["wtxid"],
            "raw_transaction_hash": hex_values["rawTransactionHash"], "bitcoin_block_height": str(block_height),
            "block_hash": hex_values["blockHash"], "confirmations": str(confirmations),
            "input_value_sats": str(input_sats), "output_value_sats": str(output_sats), "fee_sats": str(fee_sats),
            "fee_rate_sats_per_vbyte": rate, "fee_payer_policy": "transaction_inputs",
            "bitcoin_outputs_json": json.dumps(outputs, sort_keys=True, separators=(",", ":")),
        }
    elif record.get("bitcoin") is not None:
        frappe.throw("record.bitcoin is only valid for Bitcoin payments")

    return {
        "batch_id": batch_id,
        "source_type": source_type,
        "label": label,
        "chain": chain,
        "tx_hash": tx_hash,
        "confirmed_at": confirmed_at,
        "fiat_currency": currency,
        "fiat_total_minor": str(total_minor),
        "lines": lines,
        "evm": evm,
        "solana": solana,
        "bitcoin": bitcoin,
    }


def _digest(normalised: dict) -> str:
    serialisable = {
        **normalised,
        "confirmed_at": normalised["confirmed_at"].isoformat(),
    }
    canonical = json.dumps(serialisable, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _existing_batch(normalised: dict, digest: str):
    name = frappe.db.get_value(
        "Crypto Payment Batch", {"external_id": normalised["batch_id"]}, "name"
    )
    tx_name = frappe.db.get_value(
        "Crypto Payment Batch", {"tx_hash": normalised["tx_hash"]}, "name"
    )
    safe_name = None
    if normalised["evm"]:
        safe_name = frappe.db.get_value(
            "Crypto Payment Batch",
            {"safe_tx_hash": normalised["evm"]["safe_tx_hash"]},
            "name",
        )
    review_name = None
    if normalised["solana"]:
        review_name = frappe.db.get_value(
            "Crypto Payment Batch", {"review_digest": normalised["solana"]["review_digest"]}, "name"
        )
    if normalised["bitcoin"]:
        review_name = frappe.db.get_value("Crypto Payment Batch", {"review_digest": normalised["bitcoin"]["review_digest"]}, "name")
    identities = {candidate for candidate in (name, tx_name, safe_name, review_name) if candidate}
    if len(identities) > 1:
        frappe.throw("confirmed payment identifiers belong to different source records")
    name = name or tx_name or safe_name or review_name
    if not name:
        return None
    batch = frappe.get_doc("Crypto Payment Batch", name)
    if batch.record_digest != digest:
        frappe.throw(
            f"confirmed payment {normalised['batch_id']} already exists with different immutable data"
        )
    if batch.docstatus != 1 or batch.state != "confirmed":
        frappe.throw(f"confirmed payment {normalised['batch_id']} is not submitted and confirmed")
    return batch


@frappe.whitelist()
def persist_confirmed_payment(record: dict) -> dict:
    """Persist and submit an immutable confirmed chain payment, idempotently."""
    frappe.only_for(["Accounts Manager", "Accounts User"])
    normalised = _normalise_record(record)
    digest = _digest(normalised)
    existing = _existing_batch(normalised, digest)
    if existing:
        return {"batch_name": existing.name, "idempotent": True}

    values = {
        "doctype": "Crypto Payment Batch",
        "label": normalised["label"],
        "external_id": normalised["batch_id"],
        "source_type": normalised["source_type"],
        "chain": normalised["chain"],
        "confirmed_at": normalised["confirmed_at"],
        "fiat_currency": normalised["fiat_currency"],
        "fiat_total_minor": normalised["fiat_total_minor"],
        "record_digest": digest,
        "state": "confirmed",
        "tx_hash": normalised["tx_hash"],
        "payments": normalised["lines"],
    }
    if normalised["evm"]:
        values.update(
            {key: value for key, value in normalised["evm"].items() if key != "outer_tx_hash"}
        )
    if normalised["solana"]:
        values.update(normalised["solana"])
    if normalised["bitcoin"]:
        values.update(normalised["bitcoin"])
    batch = frappe.get_doc(values)
    try:
        batch.insert(ignore_permissions=True)
        batch.submit()
        frappe.db.commit()
    except frappe.UniqueValidationError:
        frappe.db.rollback()
        existing = _existing_batch(normalised, digest)
        if existing:
            return {"batch_name": existing.name, "idempotent": True}
        raise
    return {"batch_name": batch.name, "idempotent": False}


def _load_confirmed_batch(batch_id: str):
    name = frappe.db.get_value("Crypto Payment Batch", {"external_id": batch_id}, "name")
    if not name:
        frappe.throw(f"confirmed payment record not found: {batch_id}")
    batch = frappe.get_doc("Crypto Payment Batch", name)
    if batch.docstatus != 1 or batch.state != "confirmed":
        frappe.throw(f"payment record {batch_id} must be submitted and confirmed before posting")
    if not batch.payments or not batch.tx_hash or not batch.record_digest:
        frappe.throw(f"payment record {batch_id} is incomplete")
    return batch


def _submitted_journal(
    batch_id: str,
    tx_hash: str,
    safe_tx_hash: str | None = None,
    expected_total: Decimal | None = None,
) -> str | None:
    fields = [
        "name",
        "docstatus",
        "crypto_batch_id",
        "crypto_tx_hash",
        "crypto_safe_tx_hash",
        "total_debit",
        "total_credit",
    ]
    by_batch = frappe.db.get_value(
        "Journal Entry",
        {"crypto_batch_id": batch_id},
        fields,
        as_dict=True,
    )
    by_tx = frappe.db.get_value(
        "Journal Entry",
        {"crypto_tx_hash": tx_hash},
        fields,
        as_dict=True,
    )
    by_safe = None
    if safe_tx_hash:
        by_safe = frappe.db.get_value(
            "Journal Entry",
            {"crypto_safe_tx_hash": safe_tx_hash},
            fields,
            as_dict=True,
        )
    identities = {
        candidate.name for candidate in (by_batch, by_tx, by_safe) if candidate
    }
    if len(identities) > 1:
        frappe.throw("accounting idempotency conflict between confirmed source identifiers")
    existing = by_batch or by_tx or by_safe
    if not existing:
        return None
    if existing.docstatus != 1:
        frappe.throw(f"Journal Entry {existing.name} exists but is not submitted")
    if by_batch and not by_batch.crypto_tx_hash and not by_tx:
        # One-time migration for JEs created by the pre-persistence Slice C
        # endpoint. Bind only when its submitted totals exactly match the new
        # immutable source record; never silently adopt a mismatched journal.
        if expected_total is None or (
            Decimal(str(by_batch.total_debit)) != expected_total
            or Decimal(str(by_batch.total_credit)) != expected_total
        ):
            frappe.throw(
                f"legacy Journal Entry {by_batch.name} does not match the confirmed payment total"
            )
        frappe.db.set_value(
            "Journal Entry",
            by_batch.name,
            "crypto_tx_hash",
            tx_hash,
            update_modified=False,
        )
        by_batch.crypto_tx_hash = tx_hash
    if (
        existing.crypto_batch_id != batch_id
        or existing.crypto_tx_hash != tx_hash
        or (safe_tx_hash and existing.crypto_safe_tx_hash != safe_tx_hash)
    ):
        frappe.throw("Journal Entry source identity does not match the confirmed payment")
    return existing.name


@frappe.whitelist()
def post_journal(batch_id: str) -> dict:
    """Derive and submit a Journal Entry from a persisted confirmed payment."""
    frappe.only_for(["Accounts Manager", "Accounts User"])
    if not batch_id:
        frappe.throw("batch_id is required")
    ensure_custom_fields()
    batch = _load_confirmed_batch(batch_id)
    source_total = sum(
        (_minor_to_major(line.fiat_minor) for line in batch.payments), Decimal(0)
    )

    safe_tx_hash = batch.safe_tx_hash or None
    existing = _submitted_journal(
        batch_id, batch.tx_hash, safe_tx_hash=safe_tx_hash, expected_total=source_total
    )
    if existing:
        batch.db_set("journal_entry", existing, update_modified=False)
        batch.db_set("journal_posted", 1, update_modified=False)
        frappe.db.commit()
        return {"je_name": existing, "idempotent": True}

    ensure_fiscal_year()
    cost_center = ensure_cost_center()
    expense = _account(EXPENSE_ACCOUNT)
    treasury = _account(TREASURY_ACCOUNT)

    accounts = []
    total = Decimal(0)
    for line in batch.payments:
        amount = _minor_to_major(line.fiat_minor)
        total += amount
        accounts.append(
            {
                "account": expense,
                "debit_in_account_currency": float(amount),
                "cost_center": cost_center,
            }
        )
    accounts.append(
        {
            "account": treasury,
            "credit_in_account_currency": float(total),
        }
    )

    je = frappe.get_doc(
        {
            "doctype": "Journal Entry",
            "voucher_type": "Journal Entry",
            "company": COMPANY,
            "posting_date": batch.confirmed_at.date(),
            "crypto_batch_id": batch_id,
            "crypto_tx_hash": batch.tx_hash,
            "crypto_safe_tx_hash": safe_tx_hash,
            "user_remark": (
                f"ChainPay {batch.source_type} {batch_id} · {batch.tx_hash}"
                + (
                    f" · SafeTx {safe_tx_hash} · gas paid by executor {batch.executor_address}"
                    if safe_tx_hash
                    else ""
                )
                + (
                    f" · Solana review {batch.review_digest} · finalized slot {batch.finalized_slot} · fee {batch.fee_lamports} lamports paid by {batch.fee_payer_address}"
                    if batch.chain.startswith("sol:") and batch.review_digest
                    else ""
                )
                + (
                    f" · Bitcoin review {batch.review_digest} · block {batch.bitcoin_block_height} · {batch.confirmations} confirmations · fee {batch.fee_sats} sats paid by transaction inputs"
                    if batch.chain.startswith("btc:") and batch.review_digest
                    else ""
                )
            ),
            "accounts": accounts,
        }
    )
    try:
        je.insert(ignore_permissions=True)
        je.submit()
        batch.db_set("journal_entry", je.name, update_modified=False)
        batch.db_set("journal_posted", 1, update_modified=False)
        frappe.db.commit()
    except frappe.UniqueValidationError:
        frappe.db.rollback()
        existing = _submitted_journal(
            batch_id,
            batch.tx_hash,
            safe_tx_hash=safe_tx_hash,
            expected_total=source_total,
        )
        if existing:
            return {"je_name": existing, "idempotent": True}
        raise
    return {"je_name": je.name, "idempotent": False}


@frappe.whitelist()
def post_confirmed_payment(record: dict) -> dict:
    """Expose persist-then-post as one retry-safe client operation."""
    frappe.only_for(["Accounts Manager", "Accounts User"])
    normalised = _normalise_record(record)
    persist_result = persist_confirmed_payment(record)
    result = post_journal(normalised["batch_id"])
    result["record_name"] = persist_result["batch_name"]
    result["record_idempotent"] = persist_result["idempotent"]
    return result


@frappe.whitelist()
def export_compliance(filters: dict | str | None = None, format: str = "csv") -> dict:
    """Export server-owned submitted payment evidence; callers provide filters only."""
    frappe.only_for(["Accounts Manager", "Accounts User"])
    return export_payload(normalise_filters(filters), str(format).lower())
