"""Whitelisted REST: post a balanced journal from a confirmed payment batch."""
import frappe
from frappe.utils import today
from crypto_payroll.setup.seed import ensure_fiscal_year, ensure_cost_center

COMPANY = "ChainPay Test"


def _minor_to_major(currency: str, minor_str: str) -> float:
    """Convert integer minor units (cents) to major units.

    Divisor is hardcoded to 100: this slice handles a single 2-decimal fiat
    currency (cents → dollars) per the Global Constraints in the design spec.
    The `currency` parameter is accepted for future multi-currency extension.
    """
    divisor = 100
    return int(minor_str) / divisor


@frappe.whitelist()
def post_journal(batch_id: str, preview: dict) -> dict:
    """Create+submit a Journal Entry for a confirmed batch. Idempotent on batch_id.

    Returns {"je_name": str, "idempotent": bool}. Raises frappe.ValidationError on
    a malformed, unbalanced, or unknown-account payload.
    """
    # Fix 1 (CRITICAL — privilege escalation): role-gate before any work.
    # ignore_permissions=True on the insert below is intentional and safe because
    # this gate ensures only callers holding an Accounts role can reach it.
    frappe.only_for(["Accounts Manager", "Accounts User"])

    preview = frappe.parse_json(preview) if isinstance(preview, str) else preview
    if not batch_id:
        frappe.throw("batch_id is required")
    entries = (preview or {}).get("entries") or []
    if not entries:
        frappe.throw(f"preview for batch {batch_id} has no entries")

    existing = frappe.db.get_value("Journal Entry", {"crypto_batch_id": batch_id}, "name")
    if existing:
        return {"je_name": existing, "idempotent": True}

    ensure_fiscal_year()
    cost_center = ensure_cost_center()

    accounts = []
    total_debit = 0.0
    total_credit = 0.0
    # SECURITY (Slice C residual): `preview` (accounts + amounts) is caller-supplied
    # and trusted here. It is bounded by role-gating (above) + company-bound account
    # checks, but amounts are NOT verified against a persisted source of truth.
    # Slice E persists Crypto Payment Batch records; server-side verification of
    # preview entries against the persisted batch is a HARD PREREQUISITE before any
    # real-money/production use. Tracked as a Slice E blocker.
    for e in entries:
        account = e.get("account")
        if not account or not frappe.db.exists("Account", {"name": account, "company": COMPANY}):
            frappe.throw(f"unknown account: {account!r}")
        row = {"account": account}
        if e.get("debit"):
            amt = _minor_to_major(e["debit"]["currency"], e["debit"]["minor"])
            row["debit_in_account_currency"] = amt
            row["cost_center"] = cost_center
            total_debit += amt
        elif e.get("credit"):
            amt = _minor_to_major(e["credit"]["currency"], e["credit"]["minor"])
            row["credit_in_account_currency"] = amt
            total_credit += amt
        else:
            frappe.throw(f"entry for {account} has neither debit nor credit")
        accounts.append(row)

    if round(total_debit, 2) != round(total_credit, 2):
        frappe.throw(f"unbalanced journal for batch {batch_id}: {total_debit} != {total_credit}")

    je = frappe.get_doc(
        {
            "doctype": "Journal Entry",
            "voucher_type": "Journal Entry",
            "company": COMPANY,
            "posting_date": today(),
            "crypto_batch_id": batch_id,
            "user_remark": f"ChainPay batch {batch_id}",
            "accounts": accounts,
        }
    )
    je.insert(ignore_permissions=True)
    je.submit()
    frappe.db.commit()
    return {"je_name": je.name, "idempotent": False}
