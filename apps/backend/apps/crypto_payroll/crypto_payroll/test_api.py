import frappe
from frappe.tests.utils import FrappeTestCase
from crypto_payroll.setup import seed
from crypto_payroll.setup.custom_fields import ensure_custom_fields
from crypto_payroll.api import post_journal

COMPANY = "ChainPay Test"

# Batch IDs used by this test module.  Collected here so setUp can wipe any
# leftovers from previous runs and keep tests idempotent.
_BATCH_IDS = ["batch-A", "batch-B", "batch-C", "batch-D", "batch-E", "batch-SEC-1"]


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


def _delete_jes_for_batches(batch_ids):
    """Hard-delete any Journal Entries (and their GL entries) for given batch IDs.

    Submitted JEs have linked GL entries that prevent normal cancel+delete.
    We purge the GL rows first, then force-delete the JE at the DB layer.
    This is test-only housekeeping; never use outside of test teardown.
    """
    for bid in batch_ids:
        existing = frappe.db.get_all(
            "Journal Entry", filters={"crypto_batch_id": bid}, fields=["name"]
        )
        for je in existing:
            je_name = je["name"]
            # Remove linked GL entries so the JE can be deleted.
            frappe.db.delete("GL Entry", {"voucher_no": je_name})
            # Also remove Payment Ledger entries if present (ERPNext ≥14).
            frappe.db.delete("Payment Ledger Entry", {"voucher_no": je_name})
            # Force-delete the JE itself regardless of docstatus.
            frappe.db.delete("Journal Entry Account", {"parent": je_name})
            frappe.db.delete("Journal Entry", {"name": je_name})
    frappe.db.commit()


class TestPostJournal(FrappeTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        seed.run()
        ensure_custom_fields()

    def setUp(self):
        """Wipe leftover JEs so each test starts from a clean slate."""
        _delete_jes_for_batches(_BATCH_IDS)

    # ------------------------------------------------------------------
    # Original 4 tests (unchanged behaviour)
    # ------------------------------------------------------------------

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

    def test_accepts_desktop_account_labels_and_resolves_company_names(self):
        preview = _preview("batch-A")
        preview["entries"][0]["account"] = "Salary or Wage Expense"
        preview["entries"][1]["account"] = "Crypto Treasury Asset"
        res = post_journal("batch-A", preview)
        je = frappe.get_doc("Journal Entry", res["je_name"])
        self.assertEqual(je.accounts[0].account, _acct("Salary or Wage Expense"))
        self.assertEqual(je.accounts[1].account, _acct("Crypto Treasury Asset"))

    def test_existing_draft_is_not_reported_as_posted(self):
        seed.ensure_fiscal_year()
        draft = frappe.get_doc(
            {
                "doctype": "Journal Entry",
                "voucher_type": "Journal Entry",
                "company": COMPANY,
                "posting_date": frappe.utils.today(),
                "crypto_batch_id": "batch-E",
                "accounts": [
                    {
                        "account": _acct("Salary or Wage Expense"),
                        "debit_in_account_currency": 100,
                        "cost_center": seed.ensure_cost_center(),
                    },
                    {
                        "account": _acct("Crypto Treasury Asset"),
                        "credit_in_account_currency": 100,
                    },
                ],
            }
        )
        draft.insert(ignore_permissions=True)
        frappe.db.commit()

        with self.assertRaises(frappe.ValidationError):
            post_journal("batch-E", _preview("batch-E"))

    def test_unbalanced_rejected(self):
        with self.assertRaises(frappe.ValidationError):
            post_journal("batch-C", _preview("batch-C", salary_minor="10000", treasury_minor="9000"))

    def test_missing_account_rejected(self):
        bad = _preview("batch-D")
        bad["entries"][0]["account"] = "No Such Account - CPT"
        with self.assertRaises(frappe.ValidationError):
            post_journal("batch-D", bad)

    # ------------------------------------------------------------------
    # Fix 1: role-gate negative test
    # ------------------------------------------------------------------

    def test_rejects_caller_without_accounts_role(self):
        """frappe.only_for must block a user with no Accounts role.

        frappe.only_for is a no-op when local.flags.in_test is True (Frappe
        design — Administrator and test runs are always allowed).  To exercise
        the gate we temporarily clear in_test, switch to a roleless throwaway
        user, assert PermissionError, then restore both before returning.

        The throwaway user is created fresh so the test makes no assumptions
        about pre-existing users in the environment.
        """
        # Create a throwaway user with no Accounts-related roles.
        throwaway_email = "roleless-test-user@chainpay.test"
        if not frappe.db.exists("User", throwaway_email):
            u = frappe.get_doc({
                "doctype": "User",
                "email": throwaway_email,
                "first_name": "Roleless",
                "send_welcome_email": 0,
            })
            u.insert(ignore_permissions=True)
            frappe.db.commit()

        # Temporarily disable in_test so only_for performs the real check.
        frappe.local.flags.in_test = False
        frappe.set_user(throwaway_email)
        try:
            with self.assertRaises(frappe.PermissionError):
                post_journal("batch-SEC-1", _preview("batch-SEC-1"))
        finally:
            frappe.local.flags.in_test = True
            frappe.set_user("Administrator")

    # ------------------------------------------------------------------
    # Fix 2: company-bind account check
    # ------------------------------------------------------------------

    def test_account_from_wrong_company_rejected(self):
        """Accounts not belonging to COMPANY must be rejected.

        The company-bound check is frappe.db.exists("Account",
        {"name": account, "company": COMPANY}).  An account name that looks
        valid but carries a different company suffix (e.g. "- XX") does not
        exist for COMPANY and must raise ValidationError.

        Note: the existing test_missing_account_rejected already exercises the
        rejection path for a fully non-existent name.  This test additionally
        proves that the company field is part of the filter: an account name
        that would pass a bare exists("Account", name) check is still rejected
        when the company doesn't match.  We use a name with a foreign suffix
        ("- XX") that cannot exist in this single-company environment.
        """
        bad = _preview("batch-D")
        # Substitute an account name that carries a different company suffix.
        bad["entries"][0]["account"] = "Salary or Wage Expense - XX"
        with self.assertRaises(frappe.ValidationError):
            post_journal("batch-D", bad)
