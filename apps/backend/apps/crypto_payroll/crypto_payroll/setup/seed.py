"""Idempotent seed for the ChainPay accounting bridge dev/test env.

Creates one test Company and the four GL accounts the accounting model
(docs/accounting-model.md) requires. Safe to run repeatedly.
"""
import frappe

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


def run() -> dict:
    _ensure_company()
    names = [_ensure_account(a, rt, pg) for a, rt, pg in ACCOUNTS]
    return {"company": COMPANY, "accounts": names}
