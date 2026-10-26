# Bitcoin Testnet4 watch-only live smoke — 2026-10-26

## Public test evidence

- External wallet: Sparrow with **Bitcoin Testnet4** selected. No signing material entered ChainPay.
- Watched address: `tb1q720mtzgzd6tztx9kl9855l7xcmnd35rc6j70cz` (`p2wpkh`). Testnet3 and Testnet4 share the `tb1` address format, so the selected chain and provider must match.
- Provider: [Mempool Testnet4 Esplora API](https://mempool.space/testnet4/docs/api/rest). Its genesis hash matched [BIP94](https://github.com/bitcoin/bips/blob/master/bip-0094.mediawiki): `00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043`.
- Faucet transaction: `92bb61a6f5971a20ebcfc94275cd43cb421566287caf62943ae64f1262250006:1`, **50,000 sats**. At the smoke check it was in the mempool with zero confirmations.
- Packaged ChainPay 44.4.5 showed **0.0005 BTC**, **1 UTXO**, Testnet4 tip **157,631**, and the same funding transaction in history as unconfirmed.

## App checks

1. Built the Electron Linux unpacked app and launched it in an isolated profile. The Bitcoin watch setup selected `btc:testnet4` by default and accepted the address as `p2wpkh`.
2. The first direct Node request to `mempool.space` timed out in this environment. A temporary local HTTP relay forwarded read-only requests through `curl` to the same public Esplora API; the app then passed its Testnet4 genesis check and synced the balance, UTXO, tip, and history. The relay was test infrastructure outside the app and repository.
3. The same address had shown zero transactions when checked against Testnet3 earlier that day. This confirms why the wallet chain must be selected explicitly; a `tb1` address alone does not identify Testnet4.

The funded Testnet4 address watch is proven. A later public provider check found the faucet transaction confirmed in block **157,632**; at tip **157,643** it had **12 confirmations**, and its 50,000-sat output remained unspent. Sparrow initially missed the payment while its public mempool.space Electrum server was failing; after switching servers, the operator confirmed Sparrow showed **50,000 sats**. Direct Node connectivity from this environment still needs checking separately. Manual signed-transaction broadcast, confirmation tracking, and ERPNext journal posting remain the [A2](phase-5-slice-a2-bitcoin-manual-broadcast-smoke-playbook.md) and [A3](phase-5-slice-a3-bitcoin-accounting-smoke-playbook.md) live gates.
