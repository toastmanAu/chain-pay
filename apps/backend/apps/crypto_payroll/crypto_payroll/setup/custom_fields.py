"""Idempotently ensure ChainPay custom fields exist on stock DocTypes."""
import frappe


def ensure_custom_fields() -> None:
    """Add the unique crypto_batch_id Data field to Journal Entry if absent.

    Idempotent: safe to call on every backend boot. The unique index is the
    backend's at-most-one-JE-per-batch guarantee.
    """
    if frappe.db.exists(
        "Custom Field", {"dt": "Journal Entry", "fieldname": "crypto_batch_id"}
    ):
        return
    frappe.get_doc(
        {
            "doctype": "Custom Field",
            "dt": "Journal Entry",
            "fieldname": "crypto_batch_id",
            "label": "Crypto Batch ID",
            "fieldtype": "Data",
            "unique": 1,
            "read_only": 1,
            "no_copy": 1,
            "insert_after": "user_remark",
        }
    ).insert(ignore_permissions=True)
    frappe.db.commit()
