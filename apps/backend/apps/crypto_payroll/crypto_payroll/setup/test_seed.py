import frappe
from frappe.tests.utils import FrappeTestCase
from crypto_payroll.setup import seed

ACCOUNTS = [
    "Salary or Wage Expense",
    "Crypto Treasury Asset",
    "Network Fee Expense",
    "FX Gain/Loss",
]


class TestSeed(FrappeTestCase):
    def test_run_creates_company_and_accounts(self):
        result = seed.run()
        self.assertEqual(result["company"], "ChainPay Test")
        self.assertTrue(frappe.db.exists("Company", "ChainPay Test"))
        for acc in ACCOUNTS:
            self.assertTrue(
                frappe.db.exists("Account", {"account_name": acc, "company": "ChainPay Test"}),
                f"missing account {acc}",
            )

    def test_run_is_idempotent(self):
        seed.run()
        before = frappe.db.count("Account", {"company": "ChainPay Test"})
        seed.run()
        after = frappe.db.count("Account", {"company": "ChainPay Test"})
        self.assertEqual(before, after)
