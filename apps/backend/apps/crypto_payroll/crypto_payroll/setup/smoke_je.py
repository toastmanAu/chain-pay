"""Smoke-only: prove a balanced JE can be posted and cancelled."""
import frappe
from frappe.utils import today, getdate

COMPANY = "ChainPay Test"
ABBR = "CPT"


def _acct(name: str) -> str:
    return frappe.db.get_value("Account", {"account_name": name, "company": COMPANY}, "name")


def _ensure_fiscal_year() -> None:
    """Create a Fiscal Year for the current calendar year if one doesn't exist."""
    year = getdate(today()).year
    fy_name = str(year)
    if not frappe.db.exists("Fiscal Year", fy_name):
        fy = frappe.get_doc(
            {
                "doctype": "Fiscal Year",
                "year": fy_name,
                "year_start_date": f"{year}-01-01",
                "year_end_date": f"{year}-12-31",
                "companies": [{"company": COMPANY}],
            }
        )
        fy.insert(ignore_permissions=True)
        frappe.db.commit()


def _ensure_cost_center() -> str:
    """Return a leaf cost center for the company, creating the tree if absent.

    Mirrors ERPNext's Company.create_default_cost_center exactly, including
    the ignore_mandatory flag required to insert the parentless root node.
    """
    main_cc = f"Main - {ABBR}"
    if frappe.db.exists("Cost Center", main_cc):
        return main_cc

    root_cc = f"{COMPANY} - {ABBR}"
    if not frappe.db.exists("Cost Center", root_cc):
        root = frappe.get_doc(
            {
                "doctype": "Cost Center",
                "cost_center_name": COMPANY,
                "company": COMPANY,
                "is_group": 1,
                "parent_cost_center": None,
            }
        )
        root.flags.ignore_permissions = True
        root.flags.ignore_mandatory = True
        root.insert()
        frappe.db.commit()

    main = frappe.get_doc(
        {
            "doctype": "Cost Center",
            "cost_center_name": "Main",
            "company": COMPANY,
            "is_group": 0,
            "parent_cost_center": root_cc,
        }
    )
    main.flags.ignore_permissions = True
    main.insert()
    frappe.db.commit()
    return main_cc


def post_and_cancel() -> str:
    _ensure_fiscal_year()
    cost_center = _ensure_cost_center()
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
