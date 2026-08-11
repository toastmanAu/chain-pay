import copy
from dataclasses import fields as dataclass_fields

import frappe
from frappe.tests.utils import FrappeTestCase

from crypto_payroll.api import (
    export_compliance,
    persist_confirmed_payment,
    post_confirmed_payment,
    post_journal,
)
from crypto_payroll.setup import seed
from crypto_payroll.setup.custom_fields import ensure_custom_fields
from crypto_payroll.compliance import (
    ComplianceFilters,
    ComplianceRow,
    format_units,
    render_pdf,
)

COMPANY = "ChainPay Test"
_IDS = [
    "secure-A", "secure-B", "secure-C", "secure-D", "secure-E",
    "secure-EVM-A", "secure-EVM-B", "secure-EXPORT-CKB", "secure-EXPORT-EVM",
    "secure-EXPORT-FORMULA", "secure-EXPORT-TAMPER",
    "secure-EXPORT-SOURCE-TAMPER",
    "secure-SOL-A", "secure-SOL-B",
    "secure-BTC-A", "secure-BTC-B", "secure-EXPORT-BTC",
]


def _b58(data: bytes) -> str:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    leading = len(data) - len(data.lstrip(b"\0"))
    number = int.from_bytes(data, "big")
    suffix = ""
    while number:
        number, digit = divmod(number, 58)
        suffix = alphabet[digit] + suffix
    return "1" * leading + suffix


def _record(batch_id="secure-A", tx_byte="aa", minor="50"):
    return {
        "batchId": batch_id,
        "sourceType": "send",
        "label": f"Send {batch_id}",
        "chain": "ckb:testnet",
        "txHash": "0x" + tx_byte * 32,
        "confirmedAt": "2026-07-30T08:00:00Z",
        "lines": [
            {
                "payeeId": "vendor-1",
                "fiat": {"currency": "USD", "minor": minor},
                "crypto": {"asset": "CKB", "value": "6100000000", "decimals": 8},
            }
        ],
    }


def _evm_record(batch_id="secure-EVM-A", outer_byte="11", safe_byte="22"):
    return {
        "batchId": batch_id,
        "sourceType": "send",
        "label": f"Safe payment {batch_id}",
        "chain": "evm:11155111",
        "txHash": "0x" + outer_byte * 32,
        "confirmedAt": "2026-08-01T02:40:00Z",
        "lines": [
            {
                "payeeId": "vendor-evm",
                "fiat": {"currency": "USD", "minor": "2550"},
                "crypto": {
                    "asset": "ETH",
                    "value": "10000000000000000",
                    "decimals": 18,
                },
            }
        ],
        "evm": {
            "safeAddress": "0x1234567890123456789012345678901234567890",
            "safeTxHash": "0x" + safe_byte * 32,
            "outerTxHash": "0x" + outer_byte * 32,
            "executorAddress": "0x1111111111111111111111111111111111111111",
            "recipientAddress": "0x2222222222222222222222222222222222222222",
            "confirmedBlockNumber": "7123456",
            "gasUsed": "100000",
            "effectiveGasPriceWei": "2000000000",
            "gasFeeWei": "200000000000000",
            "gasPayer": "executor",
        },
    }


def _solana_record(batch_id="secure-SOL-A", signature_byte=7, digest_byte="ab"):
    source = _b58(bytes([1]) * 32)
    recipient = _b58(bytes([2]) * 32)
    fee_payer = _b58(bytes([3]) * 32)
    nonce_account = _b58(bytes([4]) * 32)
    nonce_authority = _b58(bytes([5]) * 32)
    durable_nonce = _b58(bytes([6]) * 32)
    return {
        "batchId": batch_id,
        "sourceType": "send",
        "label": f"Solana payment {batch_id}",
        "chain": "sol:devnet",
        "txHash": _b58(bytes([signature_byte]) * 64),
        "confirmedAt": "2026-08-05T02:40:00Z",
        "lines": [{
            "payeeId": "vendor-sol",
            "fiat": {"currency": "USD", "minor": "2599"},
            "crypto": {"asset": "SOL", "value": "9007199254740993", "decimals": 9},
        }],
        "solana": {
            "reviewDigest": digest_byte * 32,
            "sourceAddress": source,
            "recipientAddress": recipient,
            "feePayerAddress": fee_payer,
            "nonceAccount": nonce_account,
            "nonceAuthority": nonce_authority,
            "durableNonce": durable_nonce,
            "finalizedSlot": "9007199254740995",
            "amountLamports": "9007199254740993",
            "feeLamports": "5000",
            "feePayerPolicy": "transaction_fee_payer",
            "messageBase64": "bWVzc2FnZQ==",
        },
    }


def _bitcoin_record(batch_id="secure-BTC-A", tx_byte="31", digest_byte="41"):
    destination = "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn"
    return {
        "batchId": batch_id,
        "sourceType": "send",
        "label": f"Bitcoin payment {batch_id}",
        "chain": "btc:testnet",
        "txHash": tx_byte * 32,
        "confirmedAt": "2026-08-06T02:40:00Z",
        "lines": [{
            "payeeId": "vendor-btc",
            "fiat": {"currency": "USD", "minor": "2599"},
            "crypto": {"asset": "BTC", "value": "900719925474", "decimals": 8},
        }],
        "bitcoin": {
            "reviewDigest": digest_byte * 32,
            "wtxid": "51" * 32,
            "rawTransactionHash": "61" * 32,
            "blockHeight": "9007199254740995",
            "blockHash": "71" * 32,
            "confirmations": "6",
            "inputValueSats": "900719927474",
            "outputValueSats": "900719926474",
            "feeSats": "1000",
            "feeRateSatsPerVbyte": "8.333",
            "feePayerPolicy": "transaction_inputs",
            "outputs": [{"vout": "0", "destination": destination, "valueSats": "900719925474"}],
        },
    }


def _delete_test_records():
    for batch_id in _IDS:
        jes = frappe.db.get_all(
            "Journal Entry", filters={"crypto_batch_id": batch_id}, pluck="name"
        )
        for je_name in jes:
            frappe.db.delete("GL Entry", {"voucher_no": je_name})
            frappe.db.delete("Payment Ledger Entry", {"voucher_no": je_name})
            frappe.db.delete("Journal Entry Account", {"parent": je_name})
            frappe.db.delete("Journal Entry", {"name": je_name})
        batch_names = frappe.db.get_all(
            "Crypto Payment Batch", filters={"external_id": batch_id}, pluck="name"
        )
        for name in batch_names:
            frappe.db.delete("Crypto Payment Line", {"parent": name})
            frappe.db.delete("Crypto Payment Batch", {"name": name})
    frappe.db.commit()


class TestConfirmedPaymentAccounting(FrappeTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        seed.run()
        ensure_custom_fields()

    def setUp(self):
        _delete_test_records()

    def test_persists_submitted_confirmed_record_with_child_lines(self):
        result = persist_confirmed_payment(_record())
        self.assertFalse(result["idempotent"])
        batch = frappe.get_doc("Crypto Payment Batch", result["batch_name"])
        self.assertEqual(batch.docstatus, 1)
        self.assertEqual(batch.state, "confirmed")
        self.assertEqual(batch.external_id, "secure-A")
        self.assertEqual(batch.tx_hash, "0x" + "aa" * 32)
        self.assertEqual(batch.fiat_total_minor, "50")
        self.assertEqual(batch.payments[0].fiat_minor, "50")
        self.assertEqual(len(batch.record_digest), 64)

    def test_compliance_unit_formatting_is_exact_and_never_float_rounded(self):
        self.assertEqual(format_units("10000000000000000", 18), "0.01")
        self.assertEqual(format_units("123450000", 8), "1.2345")
        self.assertEqual(format_units("999999999999999999999999999999", 18), "999999999999.999999999999999999")
        self.assertEqual(format_units("50", 2), "0.5")

    def test_compliance_pdf_paginates_deterministically(self):
        values = {
            field.name: f"value-{field.name}" for field in dataclass_fields(ComplianceRow)
        }
        values["payee_reference"] = "José 💼"
        row = ComplianceRow(**values)
        first = render_pdf([row, row, row, row], ComplianceFilters())
        second = render_pdf([row, row, row, row], ComplianceFilters())
        self.assertEqual(first, second)
        self.assertIn(b"/Count 3", first)
        self.assertIn(b"Page 1 of 3", first)
        self.assertIn(b"Page 3 of 3", first)
        self.assertIn(b"Jos\\\\u00E9 \\\\U0001F4BC", first)

    def test_posts_server_derived_balanced_journal_for_fifty_cents(self):
        result = post_confirmed_payment(_record())
        je = frappe.get_doc("Journal Entry", result["je_name"])
        self.assertEqual(je.docstatus, 1)
        self.assertEqual(je.crypto_batch_id, "secure-A")
        self.assertEqual(je.crypto_tx_hash, "0x" + "aa" * 32)
        self.assertEqual(float(je.total_debit), 0.5)
        self.assertEqual(float(je.total_credit), 0.5)
        accounts = {row.account for row in je.accounts}
        self.assertTrue(any(name.startswith("Salary or Wage Expense") for name in accounts))
        self.assertTrue(any(name.startswith("Crypto Treasury Asset") for name in accounts))

    def test_record_and_journal_replays_are_idempotent(self):
        first = post_confirmed_payment(_record("secure-B", "bb"))
        second = post_confirmed_payment(_record("secure-B", "bb"))
        self.assertEqual(first["je_name"], second["je_name"])
        self.assertTrue(second["record_idempotent"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(
            frappe.db.count("Journal Entry", {"crypto_batch_id": "secure-B"}), 1
        )
        self.assertEqual(
            frappe.db.count("Crypto Payment Batch", {"external_id": "secure-B"}), 1
        )

    def test_persists_and_posts_safe_payment_without_charging_executor_gas_to_safe(self):
        result = post_confirmed_payment(_evm_record())
        batch = frappe.get_doc("Crypto Payment Batch", result["record_name"])
        self.assertEqual(batch.safe_tx_hash, "0x" + "22" * 32)
        self.assertEqual(batch.tx_hash, "0x" + "11" * 32)
        self.assertEqual(batch.executor_address, "0x1111111111111111111111111111111111111111")
        self.assertEqual(batch.gas_fee_wei, "200000000000000")
        self.assertEqual(batch.gas_payer, "executor")

        je = frappe.get_doc("Journal Entry", result["je_name"])
        self.assertEqual(je.crypto_safe_tx_hash, "0x" + "22" * 32)
        self.assertEqual(je.crypto_tx_hash, "0x" + "11" * 32)
        # Only the $25.50 Safe transfer is booked. Executor-paid gas is audit
        # metadata and must not increase the Safe treasury credit.
        self.assertEqual(float(je.total_debit), 25.5)
        self.assertEqual(float(je.total_credit), 25.5)
        self.assertIn("gas paid by executor", je.user_remark)

    def test_safe_and_outer_hashes_are_both_idempotency_keys(self):
        first = post_confirmed_payment(_evm_record())
        second = post_confirmed_payment(_evm_record())
        self.assertEqual(first["je_name"], second["je_name"])
        self.assertTrue(second["record_idempotent"])
        self.assertTrue(second["idempotent"])

        changed_outer = _evm_record("secure-EVM-B", "33", "22")
        with self.assertRaises(frappe.ValidationError):
            persist_confirmed_payment(changed_outer)

    def test_rejects_inconsistent_executor_paid_gas(self):
        bad = _evm_record()
        bad["evm"]["gasFeeWei"] = "1"
        with self.assertRaises(frappe.ValidationError):
            persist_confirmed_payment(bad)

    def test_persists_and_posts_finalized_sol_with_exact_metadata(self):
        result = post_confirmed_payment(_solana_record())
        batch = frappe.get_doc("Crypto Payment Batch", result["record_name"])
        self.assertEqual(batch.chain, "sol:devnet")
        self.assertEqual(batch.review_digest, "ab" * 32)
        self.assertEqual(batch.amount_lamports, "9007199254740993")
        self.assertEqual(batch.finalized_slot, "9007199254740995")
        self.assertEqual(batch.fee_lamports, "5000")
        self.assertEqual(batch.payments[0].crypto_value, "9007199254740993")
        je = frappe.get_doc("Journal Entry", result["je_name"])
        self.assertEqual(float(je.total_debit), 25.99)
        self.assertEqual(float(je.total_credit), 25.99)
        self.assertIn("Solana review", je.user_remark)

    def test_sol_signature_and_review_digest_are_idempotency_keys(self):
        first = post_confirmed_payment(_solana_record())
        second = post_confirmed_payment(_solana_record())
        self.assertEqual(first["je_name"], second["je_name"])
        self.assertTrue(second["record_idempotent"])
        with self.assertRaises(frappe.ValidationError):
            persist_confirmed_payment(_solana_record("secure-SOL-B", 8, "ab"))

    def test_persists_posts_and_replays_finalized_bitcoin_exactly(self):
        first = post_confirmed_payment(_bitcoin_record())
        second = post_confirmed_payment(_bitcoin_record())
        self.assertEqual(first["je_name"], second["je_name"])
        self.assertTrue(second["record_idempotent"])
        self.assertTrue(second["idempotent"])
        batch = frappe.get_doc("Crypto Payment Batch", first["record_name"])
        self.assertEqual(batch.chain, "btc:testnet")
        self.assertEqual(batch.review_digest, "41" * 32)
        self.assertEqual(batch.wtxid, "51" * 32)
        self.assertEqual(batch.bitcoin_block_height, "9007199254740995")
        self.assertEqual(batch.confirmations, "6")
        self.assertEqual(batch.input_value_sats, "900719927474")
        self.assertEqual(batch.fee_sats, "1000")
        self.assertEqual(batch.payments[0].crypto_value, "900719925474")
        self.assertIn('"vout":"0"', batch.bitcoin_outputs_json)
        journal = frappe.get_doc("Journal Entry", first["je_name"])
        self.assertEqual(float(journal.total_debit), 25.99)
        self.assertEqual(float(journal.total_credit), 25.99)
        self.assertIn("Bitcoin review", journal.user_remark)

    def test_bitcoin_txid_and_review_digest_are_both_idempotency_keys(self):
        post_confirmed_payment(_bitcoin_record())
        with self.assertRaises(frappe.ValidationError):
            persist_confirmed_payment(_bitcoin_record("secure-BTC-B", "32", "41"))

    def test_rejects_bitcoin_tampering_depth_ranges_cross_chain_metadata_and_accounts(self):
        cases = []
        for field, value in (
            ("confirmations", "5"), ("feeSats", "1001"),
            ("reviewDigest", "AA" * 32), ("feeRateSatsPerVbyte", "08.333"),
        ):
            bad = _bitcoin_record()
            bad["bitcoin"][field] = value
            cases.append(bad)
        output = _bitcoin_record()
        output["bitcoin"]["outputs"][0]["valueSats"] = "1"
        cases.append(output)
        address = _bitcoin_record()
        address["bitcoin"]["outputs"][0]["destination"] = "bc1qwrongnetwork"
        cases.append(address)
        unsafe = _bitcoin_record()
        unsafe["lines"][0]["crypto"]["value"] = "2100000000000001"
        cases.append(unsafe)
        metadata = _record()
        metadata["bitcoin"] = _bitcoin_record()["bitcoin"]
        cases.append(metadata)
        account = _bitcoin_record()
        account["accounts"] = ["Crypto Treasury Asset"]
        cases.append(account)
        for bad in cases:
            with self.assertRaises(frappe.ValidationError):
                persist_confirmed_payment(bad)

    def test_rejects_sol_tampering_cross_chain_metadata_and_client_accounts(self):
        cases = []
        amount = _solana_record()
        amount["solana"]["amountLamports"] = "1"
        cases.append(amount)
        signature = _solana_record()
        signature["txHash"] = signature["solana"]["sourceAddress"]
        cases.append(signature)
        metadata = _record()
        metadata["solana"] = _solana_record()["solana"]
        cases.append(metadata)
        account = _solana_record()
        account["accounts"] = ["Crypto Treasury Asset"]
        cases.append(account)
        noncanonical = _solana_record()
        noncanonical["solana"]["feeLamports"] = "05000"
        cases.append(noncanonical)
        for bad in cases:
            with self.assertRaises(frappe.ValidationError):
                persist_confirmed_payment(bad)

    def test_replay_with_changed_amount_is_rejected(self):
        persist_confirmed_payment(_record("secure-C", "cc", "50"))
        changed = _record("secure-C", "cc", "5000")
        with self.assertRaises(frappe.ValidationError):
            persist_confirmed_payment(changed)

    def test_transaction_hash_cannot_be_rebound_to_another_record(self):
        persist_confirmed_payment(_record("secure-C", "cc"))
        with self.assertRaises(frappe.ValidationError):
            persist_confirmed_payment(_record("secure-D", "cc"))

    def test_matching_legacy_journal_is_bound_to_tx_hash_without_duplication(self):
        persist_confirmed_payment(_record("secure-D", "dd"))
        expense = frappe.db.get_value(
            "Account",
            {"account_name": "Salary or Wage Expense", "company": COMPANY},
            "name",
        )
        treasury = frappe.db.get_value(
            "Account",
            {"account_name": "Crypto Treasury Asset", "company": COMPANY},
            "name",
        )
        legacy = frappe.get_doc(
            {
                "doctype": "Journal Entry",
                "voucher_type": "Journal Entry",
                "company": COMPANY,
                "posting_date": "2026-07-30",
                "crypto_batch_id": "secure-D",
                "accounts": [
                    {
                        "account": expense,
                        "debit_in_account_currency": 0.5,
                        "cost_center": seed.ensure_cost_center(),
                    },
                    {"account": treasury, "credit_in_account_currency": 0.5},
                ],
            }
        )
        legacy.insert(ignore_permissions=True)
        legacy.submit()
        frappe.db.commit()

        result = post_journal("secure-D")
        self.assertTrue(result["idempotent"])
        self.assertEqual(result["je_name"], legacy.name)
        migrated = frappe.get_doc("Journal Entry", legacy.name)
        self.assertEqual(migrated.crypto_tx_hash, "0x" + "dd" * 32)
        self.assertEqual(
            frappe.db.count("Journal Entry", {"crypto_batch_id": "secure-D"}), 1
        )

    def test_post_requires_a_persisted_submitted_record(self):
        with self.assertRaises(frappe.ValidationError):
            post_journal("secure-E")

    def test_client_cannot_supply_accounts_to_post_journal(self):
        persist_confirmed_payment(_record("secure-E", "ee"))
        with self.assertRaises(TypeError):
            post_journal(
                "secure-E",
                {"entries": [{"account": "Attacker Controlled Account"}]},
            )

    def test_malformed_or_non_positive_values_are_rejected(self):
        bad_hash = _record()
        bad_hash["txHash"] = "0x1234"
        with self.assertRaises(frappe.ValidationError):
            persist_confirmed_payment(bad_hash)

        zero = _record()
        zero["lines"][0]["fiat"]["minor"] = "0"
        with self.assertRaises(frappe.ValidationError):
            persist_confirmed_payment(zero)

        unsupported_currency = _record()
        unsupported_currency["lines"][0]["fiat"]["currency"] = "AUD"
        with self.assertRaises(frappe.ValidationError):
            persist_confirmed_payment(unsupported_currency)

        mixed = _record()
        second = copy.deepcopy(mixed["lines"][0])
        second["payeeId"] = "vendor-2"
        second["fiat"]["currency"] = "AUD"
        mixed["lines"].append(second)
        with self.assertRaises(frappe.ValidationError):
            persist_confirmed_payment(mixed)

    def test_rejects_caller_without_accounts_role(self):
        throwaway_email = "roleless-accounting-user@chainpay.test"
        if not frappe.db.exists("User", throwaway_email):
            frappe.get_doc(
                {
                    "doctype": "User",
                    "email": throwaway_email,
                    "first_name": "Roleless",
                    "send_welcome_email": 0,
                }
            ).insert(ignore_permissions=True)
            frappe.db.commit()

        frappe.local.flags.in_test = False
        frappe.set_user(throwaway_email)
        try:
            with self.assertRaises(frappe.PermissionError):
                persist_confirmed_payment(_record())
        finally:
            frappe.local.flags.in_test = True
            frappe.set_user("Administrator")

    def test_compliance_csv_is_server_derived_stable_and_covers_ckb_evm_and_bitcoin(self):
        ckb = _record("secure-EXPORT-CKB", "71", "12345")
        ckb["confirmedAt"] = "2026-07-30T08:00:00Z"
        evm = _evm_record("secure-EXPORT-EVM", "72", "73")
        evm["confirmedAt"] = "2026-08-01T02:40:00Z"
        ckb_result = post_confirmed_payment(ckb)
        post_confirmed_payment(evm)
        post_confirmed_payment(_bitcoin_record("secure-EXPORT-BTC", "77", "78"))
        import json

        frappe.db.set_value(
            "Crypto Payment Batch",
            ckb_result["record_name"],
            "fx_snapshot",
            json.dumps(
                {
                    "base": "CKB", "quote": "USD", "rate": "0.004321",
                    "source": "server-fixture", "taken_at": "2026-07-30T08:00:00Z",
                },
                sort_keys=True,
            ),
            update_modified=False,
        )
        frappe.db.commit()

        filters = {"from_date": "2026-07-01", "to_date": "2026-08-31"}
        first = export_compliance(filters, "csv")
        second = export_compliance(filters, "csv")
        self.assertEqual(first, second)
        self.assertGreaterEqual(first["row_count"], 2)
        self.assertRegex(first["filename"], r"^chainpay-compliance-[a-zA-Z0-9.-]+\.csv$")

        import base64
        import csv
        import io

        content = base64.b64decode(first["bytes_base64"])
        parsed = list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
        ours = {row["batch_id"]: row for row in parsed if row["batch_id"].startswith("secure-EXPORT-")}
        self.assertEqual(set(ours), {"secure-EXPORT-CKB", "secure-EXPORT-EVM", "secure-EXPORT-BTC"})
        self.assertEqual(ours["secure-EXPORT-CKB"]["native_value"], "6100000000")
        self.assertEqual(ours["secure-EXPORT-CKB"]["native_amount"], "61")
        self.assertEqual(ours["secure-EXPORT-CKB"]["fiat_amount"], "123.45")
        self.assertEqual(ours["secure-EXPORT-CKB"]["confirmed_block"], "unavailable")
        self.assertEqual(ours["secure-EXPORT-CKB"]["network_fee_native_amount"], "unavailable")
        self.assertEqual(ours["secure-EXPORT-CKB"]["fx_rate"], "0.004321")
        self.assertEqual(ours["secure-EXPORT-CKB"]["fx_source"], "server-fixture")
        self.assertEqual(ours["secure-EXPORT-CKB"]["fx_taken_at"], "2026-07-30T08:00:00Z")
        self.assertEqual(ours["secure-EXPORT-EVM"]["native_amount"], "0.01")
        self.assertEqual(ours["secure-EXPORT-EVM"]["confirmed_block"], "7123456")
        self.assertEqual(ours["secure-EXPORT-EVM"]["network_fee_native_amount"], "0.0002 ETH")
        self.assertEqual(ours["secure-EXPORT-EVM"]["network_fee_payer"], "executor")
        self.assertEqual(ours["secure-EXPORT-BTC"]["native_amount"], "9007.19925474")
        self.assertEqual(ours["secure-EXPORT-BTC"]["confirmed_block"], "9007199254740995")
        self.assertEqual(ours["secure-EXPORT-BTC"]["network_fee_native_value"], "1000")
        self.assertEqual(ours["secure-EXPORT-BTC"]["network_fee_native_amount"], "0.00001 BTC")
        self.assertEqual(ours["secure-EXPORT-BTC"]["network_fee_payer"], "transaction_inputs")
        self.assertEqual(ours["secure-EXPORT-EVM"]["fx_rate"], "unavailable")
        self.assertTrue(ours["secure-EXPORT-CKB"]["journal_entry"].startswith("ACC-JV-"))

    def test_compliance_pdf_is_deterministic_printable_and_filterable(self):
        ckb = _record("secure-EXPORT-CKB", "74")
        ckb["confirmedAt"] = "2026-07-30T08:00:00Z"
        evm = _evm_record("secure-EXPORT-EVM", "75", "76")
        evm["confirmedAt"] = "2026-08-01T02:40:00Z"
        post_confirmed_payment(ckb)
        post_confirmed_payment(evm)
        filters = {
            "from_date": "2026-08-01",
            "to_date": "2026-08-01",
            "chain": "evm:11155111",
        }
        first = export_compliance(filters, "pdf")
        second = export_compliance(filters, "pdf")
        import base64

        pdf = base64.b64decode(first["bytes_base64"])
        self.assertEqual(first, second)
        self.assertGreaterEqual(first["row_count"], 1)
        self.assertTrue(pdf.startswith(b"%PDF-1.4"))
        self.assertTrue(pdf.endswith(b"%%EOF\n"))
        self.assertIn(b"Page 1 of", pdf)
        self.assertIn(b"secure-EXPORT-EVM", pdf)
        self.assertNotIn(b"secure-EXPORT-CKB", pdf)

    def test_compliance_export_rejects_bad_filters_empty_sets_and_formats(self):
        with self.assertRaises(frappe.ValidationError):
            export_compliance({"from_date": "2026-02-30"}, "csv")
        with self.assertRaises(frappe.ValidationError):
            export_compliance({"from_date": "2026-08-02", "to_date": "2026-08-01"}, "csv")
        with self.assertRaises(frappe.ValidationError):
            export_compliance({"chain": "evm:1"}, "csv")
        with self.assertRaises(frappe.ValidationError):
            export_compliance({"records": [{"fiat_minor": "999999"}]}, "csv")
        with self.assertRaises(frappe.ValidationError):
            export_compliance({}, "xlsx")
        with self.assertRaises(frappe.ValidationError):
            export_compliance({"from_date": "1990-01-01", "to_date": "1990-01-02"}, "csv")

    def test_compliance_csv_neutralises_spreadsheet_formula_values(self):
        record = _record("secure-EXPORT-FORMULA", "77")
        record["lines"][0]["payeeId"] = "=HYPERLINK(\"https://attacker.invalid\")"
        post_confirmed_payment(record)
        result = export_compliance({"chain": "ckb:testnet"}, "csv")
        import base64

        content = base64.b64decode(result["bytes_base64"]).decode("utf-8-sig")
        self.assertIn("'=HYPERLINK", content)

    def test_compliance_export_rejects_a_tampered_journal_binding(self):
        result = post_confirmed_payment(_record("secure-EXPORT-TAMPER", "78"))
        frappe.db.set_value(
            "Journal Entry", result["je_name"], "crypto_tx_hash", "0x" + "79" * 32,
            update_modified=False,
        )
        frappe.db.commit()
        with self.assertRaises(frappe.ValidationError):
            export_compliance({"chain": "ckb:testnet"}, "csv")

    def test_compliance_export_rejects_source_fields_changed_after_submission(self):
        result = post_confirmed_payment(_record("secure-EXPORT-SOURCE-TAMPER", "7a"))
        batch = frappe.get_doc("Crypto Payment Batch", result["record_name"])
        frappe.db.set_value(
            "Crypto Payment Line", batch.payments[0].name, "fiat_minor", "999999",
            update_modified=False,
        )
        frappe.db.commit()
        with self.assertRaises(frappe.ValidationError):
            export_compliance({"chain": "ckb:testnet"}, "csv")

    def test_chain_registry_covers_every_supported_chain(self):
        from crypto_payroll.chains import CHAIN_RULES, rules_for

        # NOTE: temporarily narrowed to the CKB+EVM+Solana keys registered so
        # far. Widened again in Task 4 (Bitcoin) once that chain's rules are
        # registered (see chains/__init__.py).
        self.assertEqual(
            set(CHAIN_RULES),
            {
                "ckb:mainnet",
                "ckb:testnet",
                "evm:11155111",
                "sol:devnet",
                "sol:mainnet",
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

    def test_compliance_export_requires_an_accounts_role(self):
        throwaway_email = "roleless-accounting-user@chainpay.test"
        if not frappe.db.exists("User", throwaway_email):
            frappe.get_doc(
                {
                    "doctype": "User", "email": throwaway_email, "first_name": "Roleless",
                    "send_welcome_email": 0,
                }
            ).insert(ignore_permissions=True)
            frappe.db.commit()
        frappe.local.flags.in_test = False
        frappe.set_user(throwaway_email)
        try:
            with self.assertRaises(frappe.PermissionError):
                export_compliance({}, "csv")
        finally:
            frappe.local.flags.in_test = True
            frappe.set_user("Administrator")
