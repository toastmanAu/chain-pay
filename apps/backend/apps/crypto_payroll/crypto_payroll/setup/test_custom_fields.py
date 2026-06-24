import frappe
from frappe.tests.utils import FrappeTestCase
from crypto_payroll.setup.custom_fields import ensure_custom_fields


class TestCustomFields(FrappeTestCase):
    def test_crypto_batch_id_field_exists_and_is_unique(self):
        ensure_custom_fields()
        ensure_custom_fields()  # idempotent: second call must not raise
        cf = frappe.db.get_value(
            "Custom Field",
            {"dt": "Journal Entry", "fieldname": "crypto_batch_id"},
            ["fieldtype", "unique", "read_only"],
            as_dict=True,
        )
        self.assertIsNotNone(cf)
        self.assertEqual(cf.fieldtype, "Data")
        self.assertEqual(cf.unique, 1)
        self.assertEqual(cf.read_only, 1)
