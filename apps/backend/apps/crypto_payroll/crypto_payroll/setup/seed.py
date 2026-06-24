"""Idempotent seed for the ChainPay accounting bridge dev/test env.

Creates one test Company, the four GL accounts the accounting model
(docs/accounting-model.md) requires, a Fiscal Year for the current
calendar year, and the Main cost center tree. Safe to run repeatedly.
"""
import frappe
from frappe.utils import today, getdate

COMPANY = "ChainPay Test"
ABBR = "CPT"

# (account_name, root_type, parent group account name without abbr)
ACCOUNTS = [
    ("Salary or Wage Expense", "Expense", "Expenses"),
    ("Crypto Treasury Asset", "Asset", "Current Assets"),
    ("Network Fee Expense", "Expense", "Expenses"),
    ("FX Gain/Loss", "Income", "Income"),
]


def _ensure_warehouse_type(name: str) -> None:
    """ERPNext's Company.create_default_warehouses references 'Transit' Warehouse Type.
    In a fresh test environment this record doesn't exist yet, so we create it first.

    ignore_permissions=True: this reconstructs an ERPNext-internal default (mirroring
    ERPNext's own create_default_* helpers); it is infrastructure, not user data.
    """
    if not frappe.db.exists("Warehouse Type", name):
        frappe.get_doc({"doctype": "Warehouse Type", "name": name}).insert(ignore_permissions=True)
        frappe.db.commit()


def _ensure_company() -> str:
    _ensure_warehouse_type("Transit")
    if not frappe.db.exists("Company", COMPANY):
        frappe.get_doc(
            {
                "doctype": "Company",
                "company_name": COMPANY,
                "abbr": ABBR,
                "default_currency": "USD",
                "country": "Australia",
            }
        ).insert()
        frappe.db.commit()
    return COMPANY


def _ensure_account(account_name: str, root_type: str, parent_group: str) -> str:
    existing = frappe.db.get_value(
        "Account", {"account_name": account_name, "company": COMPANY}, "name"
    )
    if existing:
        return existing
    parent = frappe.db.get_value(
        "Account", {"account_name": parent_group, "company": COMPANY, "is_group": 1}, "name"
    )
    doc = frappe.get_doc(
        {
            "doctype": "Account",
            "account_name": account_name,
            "company": COMPANY,
            "parent_account": parent,
            "root_type": root_type,
            "is_group": 0,
        }
    ).insert()
    frappe.db.commit()
    return doc.name


def ensure_fiscal_year() -> None:
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


def ensure_cost_center() -> str:
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


def run() -> dict:
    _ensure_company()
    ensure_fiscal_year()
    cost_center = ensure_cost_center()
    names = [_ensure_account(a, rt, pg) for a, rt, pg in ACCOUNTS]
    return {"company": COMPANY, "accounts": names, "cost_center": cost_center}
