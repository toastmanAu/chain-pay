"""Deterministic compliance-report assembly and serialization.

The caller supplies filters only.  Rows are assembled from submitted source
documents and their submitted Journal Entries so renderer/client values can
never become report facts.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import re
from dataclasses import dataclass, fields
from datetime import date, datetime, time
from typing import Iterable

import frappe


ALLOWED_CHAINS = {
    "ckb:mainnet", "ckb:testnet", "evm:11155111",
    "sol:devnet", "sol:mainnet", "btc:testnet", "btc:mainnet",
}
MAX_EXPORT_ROWS = 10_000
UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class ComplianceFilters:
    from_date: date | None = None
    to_date: date | None = None
    chain: str | None = None


@dataclass(frozen=True)
class ComplianceRow:
    source_record: str
    batch_id: str
    source_type: str
    label: str
    payee_reference: str
    chain: str
    asset: str
    native_value: str
    native_decimals: str
    native_amount: str
    fiat_currency: str
    fiat_minor: str
    fiat_amount: str
    fx_base: str
    fx_quote: str
    fx_rate: str
    fx_source: str
    fx_taken_at: str
    transaction_hash: str
    safe_tx_hash: str
    confirmed_block: str
    confirmed_at_utc: str
    network_fee_native_value: str
    network_fee_native_amount: str
    network_fee_fiat: str
    network_fee_payer: str
    journal_entry: str
    immutable_digest: str


def normalise_filters(raw: dict | str | None) -> ComplianceFilters:
    raw = frappe.parse_json(raw) if isinstance(raw, str) else (raw or {})
    if not isinstance(raw, dict):
        frappe.throw("filters must be an object")
    unknown = set(raw) - {"from_date", "to_date", "chain"}
    if unknown:
        frappe.throw(f"unsupported compliance filter: {sorted(unknown)[0]}")

    def parse_date(key: str) -> date | None:
        value = raw.get(key)
        if value in (None, ""):
            return None
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            frappe.throw(f"filters.{key} must be YYYY-MM-DD")
        try:
            return date.fromisoformat(value)
        except ValueError:
            frappe.throw(f"filters.{key} must be a real calendar date")

    from_date = parse_date("from_date")
    to_date = parse_date("to_date")
    if from_date and to_date and from_date > to_date:
        frappe.throw("filters.from_date cannot be after filters.to_date")
    chain = raw.get("chain") or None
    if chain is not None and chain not in ALLOWED_CHAINS:
        frappe.throw("filters.chain must be a supported ChainPay network")
    return ComplianceFilters(from_date=from_date, to_date=to_date, chain=chain)


def build_rows(filters: ComplianceFilters) -> list[ComplianceRow]:
    db_filters: dict = {"docstatus": 1, "state": "confirmed", "journal_posted": 1}
    if filters.chain:
        db_filters["chain"] = filters.chain
    if filters.from_date and filters.to_date:
        db_filters["confirmed_at"] = [
            "between",
            [
                datetime.combine(filters.from_date, time.min),
                datetime.combine(filters.to_date, time.max),
            ],
        ]
    elif filters.from_date:
        db_filters["confirmed_at"] = [">=", datetime.combine(filters.from_date, time.min)]
    elif filters.to_date:
        db_filters["confirmed_at"] = ["<=", datetime.combine(filters.to_date, time.max)]

    names = frappe.get_all(
        "Crypto Payment Batch",
        filters=db_filters,
        fields=["name"],
        order_by="confirmed_at asc, external_id asc, name asc",
        limit_page_length=MAX_EXPORT_ROWS + 1,
    )
    if len(names) > MAX_EXPORT_ROWS:
        frappe.throw(
            f"compliance export exceeds {MAX_EXPORT_ROWS} source records; narrow the filters"
        )

    rows: list[ComplianceRow] = []
    for item in names:
        batch = frappe.get_doc("Crypto Payment Batch", item.name)
        _validate_source(batch)
        fx = _fx_fields(batch.fx_snapshot)
        confirmed_at = _utc_datetime(batch.confirmed_at)
        fee_value, fee_amount, fee_payer = _network_fee(batch)
        for line in sorted(batch.payments, key=lambda row: (int(row.idx or 0), row.name or "")):
            rows.append(
                ComplianceRow(
                    source_record=batch.name,
                    batch_id=batch.external_id,
                    source_type=batch.source_type,
                    label=batch.label,
                    payee_reference=line.payee_id,
                    chain=batch.chain,
                    asset=line.crypto_asset,
                    native_value=str(line.crypto_value),
                    native_decimals=str(line.crypto_decimals),
                    native_amount=format_units(str(line.crypto_value), int(line.crypto_decimals)),
                    fiat_currency=line.fiat_currency,
                    fiat_minor=str(line.fiat_minor),
                    fiat_amount=format_units(str(line.fiat_minor), 2),
                    fx_base=fx["base"],
                    fx_quote=fx["quote"],
                    fx_rate=fx["rate"],
                    fx_source=fx["source"],
                    fx_taken_at=fx["taken_at"],
                    transaction_hash=batch.tx_hash,
                    safe_tx_hash=batch.safe_tx_hash or UNAVAILABLE,
                    confirmed_block=(
                        batch.bitcoin_block_height
                        or batch.finalized_slot
                        or batch.confirmed_block_number
                        or UNAVAILABLE
                    ),
                    confirmed_at_utc=confirmed_at,
                    network_fee_native_value=fee_value,
                    network_fee_native_amount=fee_amount,
                    network_fee_fiat=UNAVAILABLE,
                    network_fee_payer=fee_payer,
                    journal_entry=batch.journal_entry,
                    immutable_digest=batch.record_digest,
                )
            )
            if len(rows) > MAX_EXPORT_ROWS:
                frappe.throw(
                    f"compliance export exceeds {MAX_EXPORT_ROWS} payment rows; narrow the filters"
                )
    return rows


def _validate_source(batch) -> None:
    if batch.docstatus != 1 or batch.state != "confirmed":
        frappe.throw(f"payment record {batch.name} is not submitted and confirmed")
    if not batch.journal_posted or not batch.journal_entry:
        frappe.throw(f"payment record {batch.name} has no posted Journal Entry")
    if not batch.record_digest or not batch.tx_hash or not batch.payments:
        frappe.throw(f"payment record {batch.name} is incomplete")
    if batch.record_digest not in _source_digests(batch):
        frappe.throw(f"payment record {batch.name} does not match its immutable digest")
    journal = frappe.get_doc("Journal Entry", batch.journal_entry)
    if journal.docstatus != 1:
        frappe.throw(f"Journal Entry {journal.name} is not submitted")
    if journal.crypto_batch_id != batch.external_id or journal.crypto_tx_hash != batch.tx_hash:
        frappe.throw(f"Journal Entry {journal.name} does not match payment record {batch.name}")
    expected_safe = batch.safe_tx_hash or None
    if (journal.crypto_safe_tx_hash or None) != expected_safe:
        frappe.throw(
            f"Journal Entry {journal.name} SafeTx identity does not match payment record {batch.name}"
        )


def _source_digests(batch) -> set[str]:
    lines = [
        {
            "payee_id": row.payee_id,
            "fiat_currency": row.fiat_currency,
            "fiat_minor": str(row.fiat_minor),
            "crypto_asset": row.crypto_asset,
            "crypto_value": str(row.crypto_value),
            "crypto_decimals": int(row.crypto_decimals),
        }
        for row in sorted(batch.payments, key=lambda row: (int(row.idx or 0), row.name or ""))
    ]
    evm = None
    if batch.chain == "evm:11155111":
        evm = {
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
    solana = None
    if batch.chain.startswith("sol:"):
        solana = {
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
    bitcoin = None
    if batch.chain.startswith("btc:"):
        try:
            outputs = json.loads(batch.bitcoin_outputs_json)
        except (TypeError, json.JSONDecodeError):
            frappe.throw(f"payment record {batch.name} has invalid Bitcoin outputs")
        bitcoin = {
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
    source = {
        "batch_id": batch.external_id,
        "source_type": batch.source_type,
        "label": batch.label,
        "chain": batch.chain,
        "tx_hash": batch.tx_hash,
        "confirmed_at": (
            frappe.utils.get_datetime(batch.confirmed_at).replace(tzinfo=None).isoformat()
        ),
        "fiat_currency": batch.fiat_currency,
        "fiat_total_minor": str(batch.fiat_total_minor),
        "lines": lines,
        "evm": evm,
        "solana": solana,
        "bitcoin": bitcoin,
    }

    def digest(value: dict) -> str:
        canonical = json.dumps(value, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    candidates = {digest(source)}
    # Records created before Bitcoin support did not include `bitcoin: null`.
    without_bitcoin = {key: value for key, value in source.items() if key != "bitcoin"}
    candidates.add(digest(without_bitcoin))
    # Records created before Solana support did not include `solana: null`.
    without_solana = {key: value for key, value in without_bitcoin.items() if key != "solana"}
    candidates.add(digest(without_solana))
    # CKB records created before Sepolia support also omitted `evm: null`.
    if batch.chain.startswith("ckb:"):
        candidates.add(digest({key: value for key, value in without_solana.items() if key != "evm"}))
    return candidates


def _fx_fields(raw: str | None) -> dict[str, str]:
    if not raw:
        return {key: UNAVAILABLE for key in ("base", "quote", "rate", "source", "taken_at")}
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        frappe.throw("persisted FX snapshot is not valid JSON")
    if not isinstance(value, dict):
        frappe.throw("persisted FX snapshot must be an object")
    result = {}
    for key in ("base", "quote", "rate", "source", "taken_at"):
        item = value.get(key)
        result[key] = str(item) if item not in (None, "") else UNAVAILABLE
    return result


def _network_fee(batch) -> tuple[str, str, str]:
    if batch.chain == "evm:11155111" and batch.gas_fee_wei:
        value = str(batch.gas_fee_wei)
        return value, f"{format_units(value, 18)} ETH", batch.gas_payer or "executor"
    if batch.chain.startswith("sol:") and batch.fee_lamports is not None:
        value = str(batch.fee_lamports)
        payer = f"{batch.fee_payer_policy}:{batch.fee_payer_address}"
        return value, f"{format_units(value, 9)} SOL", payer
    if batch.chain.startswith("btc:") and batch.fee_sats is not None:
        value = str(batch.fee_sats)
        return value, f"{format_units(value, 8)} BTC", batch.fee_payer_policy or "transaction_inputs"
    return UNAVAILABLE, UNAVAILABLE, UNAVAILABLE


def _utc_datetime(value) -> str:
    parsed = frappe.utils.get_datetime(value)
    # Frappe stores UTC instants as timezone-naive MariaDB DATETIME values.
    return parsed.replace(tzinfo=None).isoformat(timespec="seconds") + "Z"


def format_units(value: str, decimals: int) -> str:
    number = int(value)
    sign = "-" if number < 0 else ""
    digits = str(abs(number)).rjust(decimals + 1, "0")
    if decimals == 0:
        return sign + digits
    whole, fraction = digits[:-decimals], digits[-decimals:]
    fraction = fraction.rstrip("0")
    return sign + whole + (f".{fraction}" if fraction else "")


def render_csv(rows: Iterable[ComplianceRow]) -> bytes:
    output = io.StringIO(newline="")
    names = [field.name for field in fields(ComplianceRow)]
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow(names)
    for row in rows:
        writer.writerow([_csv_safe(getattr(row, name)) for name in names])
    return ("\ufeff" + output.getvalue()).encode("utf-8")


def _csv_safe(value: str) -> str:
    # Prevent spreadsheet formula execution without hiding the persisted value.
    return "'" + value if value.startswith(("=", "+", "-", "@", "\t", "\r")) else value


def render_pdf(rows: list[ComplianceRow], filters: ComplianceFilters) -> bytes:
    """Build a byte-deterministic, dependency-free, printable landscape PDF."""
    lines = [
        f"Period: {filters.from_date or 'all'} to {filters.to_date or 'all'}",
        f"Chain: {filters.chain or 'all'} | Payment lines: {len(rows)}",
        "",
    ]
    labels = {
        "source_record": "Source record", "batch_id": "Batch ID", "source_type": "Source type",
        "label": "Label", "payee_reference": "Payee/payslip reference", "chain": "Chain",
        "asset": "Asset", "native_value": "Native smallest units", "native_decimals": "Decimals",
        "native_amount": "Native amount", "fiat_currency": "Fiat currency",
        "fiat_minor": "Fiat minor units",
        "fiat_amount": "Fiat amount", "fx_base": "FX base", "fx_quote": "FX quote",
        "fx_rate": "FX rate", "fx_source": "FX source", "fx_taken_at": "FX taken at",
        "transaction_hash": "Transaction hash", "safe_tx_hash": "SafeTx hash",
        "confirmed_block": "Confirmed block", "confirmed_at_utc": "Confirmed at UTC",
        "network_fee_native_value": "Network fee smallest units",
        "network_fee_native_amount": "Network fee native", "network_fee_fiat": "Network fee fiat",
        "network_fee_payer": "Network fee payer", "journal_entry": "Journal Entry",
        "immutable_digest": "Immutable digest",
    }
    for index, row in enumerate(rows, 1):
        lines.extend((f"Payment line {index}", "-" * 110))
        for field in fields(ComplianceRow):
            lines.extend(_wrap(f"{labels[field.name]}: {getattr(row, field.name)}", 110))
        lines.append("")
    return _minimal_pdf(lines)


def _wrap(text: str, width: int) -> list[str]:
    if not text:
        return [""]
    return [text[index:index + width] for index in range(0, len(text), width)]


def _minimal_pdf(lines: list[str]) -> bytes:
    per_page = 47
    chunks = [lines[index:index + per_page] for index in range(0, len(lines), per_page)] or [[]]
    pages = [
        ["ChainPay Compliance Export", f"Page {index + 1} of {len(chunks)}", "", *chunk]
        for index, chunk in enumerate(chunks)
    ]
    objects: list[bytes] = []
    page_ids = [4 + index * 2 for index in range(len(pages))]
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{item} 0 R" for item in page_ids)
    objects.append(
        f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode()
    )
    objects.append(
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier "
        b"/Encoding /WinAnsiEncoding >>"
    )
    for index, page_lines in enumerate(pages):
        page_id = page_ids[index]
        stream_id = page_id + 1
        objects.append(
            (
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] "
                f"/Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>"
            ).encode()
        )
        commands = [b"BT /F1 8 Tf 36 576 Td 10 TL"]
        for line in page_lines:
            safe = (
                _pdf_visible(line).encode("ascii")
                .replace(b"\\", b"\\\\")
                .replace(b"(", b"\\(")
                .replace(b")", b"\\)")
            )
            commands.append(b"(" + safe + b") Tj T*")
        commands.append(b"ET")
        stream = b"\n".join(commands)
        objects.append(
            b"<< /Length "
            + str(len(stream)).encode()
            + b" >>\nstream\n"
            + stream
            + b"\nendstream"
        )

    result = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for object_id, body in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{object_id} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = len(result)
    result.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    result.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode())
    result.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(result)


def _pdf_visible(value: str) -> str:
    """Represent every Unicode code point losslessly using printable ASCII."""
    visible = []
    for character in value:
        codepoint = ord(character)
        if 32 <= codepoint <= 126:
            visible.append(character)
        elif codepoint <= 0xFFFF:
            visible.append(f"\\u{codepoint:04X}")
        else:
            visible.append(f"\\U{codepoint:08X}")
    return "".join(visible)


def export_payload(filters: ComplianceFilters, output_format: str) -> dict:
    if output_format not in {"csv", "pdf"}:
        frappe.throw("format must be csv or pdf")
    rows = build_rows(filters)
    if not rows:
        frappe.throw("no submitted confirmed payments match the compliance filters")
    content = render_csv(rows) if output_format == "csv" else render_pdf(rows, filters)
    period = f"{filters.from_date or 'all'}-to-{filters.to_date or 'all'}"
    chain = (filters.chain or "all-chains").replace(":", "-")
    filename = f"chainpay-compliance-{period}-{chain}.{output_format}"
    return {
        "filename": filename,
        "mime_type": "text/csv;charset=utf-8" if output_format == "csv" else "application/pdf",
        "bytes_base64": base64.b64encode(content).decode("ascii"),
        "sha256": hashlib.sha256(content).hexdigest(),
        "row_count": len(rows),
    }
