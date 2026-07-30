"""Idempotently ensure ChainPay custom fields exist on stock DocTypes."""
import frappe


def _ensure_journal_field(fieldname: str, label: str, insert_after: str) -> None:
    if frappe.db.exists("Custom Field", {"dt": "Journal Entry", "fieldname": fieldname}):
        return
    frappe.get_doc(
        {
            "doctype": "Custom Field",
            "dt": "Journal Entry",
            "fieldname": fieldname,
            "label": label,
            "fieldtype": "Data",
            "unique": 1,
            "read_only": 1,
            "no_copy": 1,
            "insert_after": insert_after,
        }
    ).insert(ignore_permissions=True)


def ensure_custom_fields() -> None:
    """Add unique source identifiers to Journal Entry if absent.

    Idempotent: safe to call on every backend boot. These unique indexes are
    the backend's at-most-one-JE-per-record and at-most-one-JE-per-chain-tx
    guarantees.
    """
    _ensure_journal_field("crypto_batch_id", "Crypto Batch ID", "user_remark")
    _ensure_journal_field("crypto_tx_hash", "Crypto Transaction Hash", "crypto_batch_id")
    frappe.db.commit()
