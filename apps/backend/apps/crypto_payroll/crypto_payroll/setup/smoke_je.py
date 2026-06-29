"""Smoke-only: prove a balanced JE can be posted and cancelled."""
import frappe
from frappe.utils import today

from crypto_payroll.setup.seed import COMPANY, ensure_fiscal_year, ensure_cost_center


def _acct(name: str) -> str:
    return frappe.db.get_value("Account", {"account_name": name, "company": COMPANY}, "name")


def post_and_cancel() -> str:
    ensure_fiscal_year()
    cost_center = ensure_cost_center()
    je = frappe.get_doc(
        {
            "doctype": "Journal Entry",
            "voucher_type": "Journal Entry",
            "company": COMPANY,
            "posting_date": today(),
            "accounts": [
                {
                    "account": _acct("Salary or Wage Expense"),
                    "debit_in_account_currency": 100,
                    "cost_center": cost_center,
                },
                {
                    "account": _acct("Crypto Treasury Asset"),
                    "credit_in_account_currency": 100,
                },
            ],
        }
    )
    je.insert()
    je.submit()
    je.cancel()
    frappe.db.commit()
    return je.name
