"""Chain registry. Adding a chain = one module here plus one entry below."""
from __future__ import annotations

import frappe

from crypto_payroll.chains.base import ChainRules
from crypto_payroll.chains.btc import BtcRules
from crypto_payroll.chains.ckb import CkbRules
from crypto_payroll.chains.evm import EvmRules
from crypto_payroll.chains.sol import SolRules

CHAIN_RULES: dict[str, ChainRules] = {
    "ckb:mainnet": CkbRules(chain="ckb:mainnet"),
    "ckb:testnet": CkbRules(chain="ckb:testnet"),
    "evm:11155111": EvmRules(chain="evm:11155111"),
    "sol:devnet": SolRules(chain="sol:devnet"),
    "sol:mainnet": SolRules(chain="sol:mainnet"),
    "btc:testnet": BtcRules(chain="btc:testnet"),
    "btc:mainnet": BtcRules(chain="btc:mainnet"),
}


def rules_for(chain: str) -> ChainRules:
    rules = CHAIN_RULES.get(chain)
    if rules is None:
        frappe.throw("record.chain is unsupported")
    return rules
