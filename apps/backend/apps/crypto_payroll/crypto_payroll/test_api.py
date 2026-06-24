import frappe
from frappe.tests.utils import FrappeTestCase
from crypto_payroll.setup import seed
from crypto_payroll.setup.custom_fields import ensure_custom_fields
from crypto_payroll.api import post_journal

COMPANY = "ChainPay Test"


def _acct(name):
    return frappe.db.get_value("Account", {"account_name": name, "company": COMPANY}, "name")


def _preview(batch_id, salary_minor="10000", treasury_minor="10000"):
    return {
        "batchId": batch_id,
        "entries": [
            {"account": _acct("Salary or Wage Expense"),
             "debit": {"currency": "USD", "minor": salary_minor}, "memo": "t"},
            {"account": _acct("Crypto Treasury Asset"),
             "credit": {"currency": "USD", "minor": treasury_minor}, "memo": "t"},
        ],
    }


class TestPostJournal(FrappeTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        seed.run()
        ensure_custom_fields()

    def test_posts_balanced_submitted_je_with_batch_id(self):
        res = post_journal("batch-A", _preview("batch-A"))
        self.assertFalse(res["idempotent"])
        je = frappe.get_doc("Journal Entry", res["je_name"])
        self.assertEqual(je.docstatus, 1)               # submitted
        self.assertEqual(je.crypto_batch_id, "batch-A")
        self.assertEqual(je.total_debit, je.total_credit)

    def test_idempotent_repost_returns_same_je(self):
        first = post_journal("batch-B", _preview("batch-B"))
        second = post_journal("batch-B", _preview("batch-B"))
        self.assertEqual(first["je_name"], second["je_name"])
        self.assertTrue(second["idempotent"])
        count = frappe.db.count("Journal Entry", {"crypto_batch_id": "batch-B"})
        self.assertEqual(count, 1)

    def test_unbalanced_rejected(self):
        with self.assertRaises(frappe.ValidationError):
            post_journal("batch-C", _preview("batch-C", salary_minor="10000", treasury_minor="9000"))

    def test_missing_account_rejected(self):
        bad = _preview("batch-D")
        bad["entries"][0]["account"] = "No Such Account - CPT"
        with self.assertRaises(frappe.ValidationError):
            post_journal("batch-D", bad)
