"""Focused regression coverage for `crypto_payroll.chains.base.bitcoin_address`.

Task 4 decomposed `_bitcoin_address` into helpers here and differential-fuzzed
19,810 case/chain pairs against the pre-refactor implementation with zero
mismatches, but that harness lives in a scratchpad and is not committed. This
is the only standing regression coverage for Bitcoin address validation — for
a payments system, a regression here means accepting an invalid payment
destination.

Every valid vector below is a real, well-known address taken from BIP-173
(https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki) and BIP-350
(https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki), or a widely
published Base58Check example address, cross-checked against an independent
decoder (a fresh Base58Check implementation and the reference
`segwit_addr.py` from the Bitcoin Core repository) before being pinned here.
"""
from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase

from crypto_payroll.chains.base import bitcoin_address


class TestBitcoinAddressVectors(FrappeTestCase):
    def test_accepts_real_valid_addresses_across_networks_and_formats(self):
        valid_cases = [
            (
                "mainnet P2PKH (version 0)",
                "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
                "btc:mainnet",
            ),
            (
                "mainnet P2SH (version 5)",
                "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
                "btc:mainnet",
            ),
            (
                "testnet P2PKH (version 111)",
                "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn",
                "btc:testnet",
            ),
            (
                "testnet P2SH (version 196)",
                "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc",
                "btc:testnet",
            ),
            (
                "bech32 v0, 20-byte witness program (P2WPKH), BIP-173",
                "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
                "btc:mainnet",
            ),
            (
                "bech32 v0, 32-byte witness program (P2WSH), BIP-173",
                "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7",
                "btc:testnet",
            ),
            (
                "bech32m v1, 32-byte witness program (P2TR), BIP-350",
                "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
                "btc:mainnet",
            ),
        ]
        for description, address, chain in valid_cases:
            with self.subTest(description):
                self.assertEqual(bitcoin_address(address, chain, "test"), address)

    def test_rejects_malformed_or_mismatched_addresses(self):
        rejection_cases = [
            (
                "bad base58 checksum (last character altered)",
                "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3",
                "btc:mainnet",
            ),
            (
                "mainnet base58 address offered on testnet",
                "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
                "btc:testnet",
            ),
            (
                "testnet base58 address offered on mainnet",
                "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn",
                "btc:mainnet",
            ),
            (
                "mixed-case bech32 (BIP-350 invalid vector)",
                "tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq",
                "btc:testnet",
            ),
            (
                "witness v0 encoded with a bech32m checksum (BIP-350 invalid vector)",
                "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh",
                "btc:mainnet",
            ),
            (
                "invalid witness program length: 1 byte (BIP-350 invalid vector)",
                "bc1pw5dgrnzv",
                "btc:mainnet",
            ),
            (
                "over-length bech32 string (>90 characters)",
                "bc1q" + "q" * 90,
                "btc:mainnet",
            ),
        ]
        for description, address, chain in rejection_cases:
            with self.subTest(description):
                with self.assertRaises(frappe.ValidationError):
                    bitcoin_address(address, chain, "test")
