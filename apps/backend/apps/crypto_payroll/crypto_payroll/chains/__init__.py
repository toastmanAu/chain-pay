"""Chain registry. Adding a chain = one module here plus one entry below."""
from __future__ import annotations

import frappe

from crypto_payroll.chains.base import ChainRules
from crypto_payroll.chains.ckb import CkbRules

CHAIN_RULES: dict[str, ChainRules] = {
    "ckb:mainnet": CkbRules(chain="ckb:mainnet"),
    "ckb:testnet": CkbRules(chain="ckb:testnet"),
}


def rules_for(chain: str) -> ChainRules:
    rules = CHAIN_RULES.get(chain)
    if rules is None:
        frappe.throw("record.chain is unsupported")
    return rules
