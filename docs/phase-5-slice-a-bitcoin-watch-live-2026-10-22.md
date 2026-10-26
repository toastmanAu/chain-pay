# Bitcoin Testnet watch-only live smoke — 2026-10-22

## Public test evidence

- External signer: UniSat mobile, with **Bitcoin Testnet** selected. No signing material entered ChainPay.
- Watched address: `tb1q4dnsk3lq9zgvprljjr45y750qdv726jnupchty` (`p2wpkh`).
- Provider: configured Blockstream Testnet Esplora endpoint, queried by Electron main.
- Confirmed UTXO: `e4d8ec090477ab2993ccba9c5c8e613b93653c3103e1781fb5b33fcf0ccdaeb9:0`, 181,146 sats, block 5,106,359.
- At provider tip 5,196,029, the packaged ChainPay watch screen showed **0.00181146 BTC**, **1 UTXO**, and the funding transaction in history with **89,671 confirmations** and no sync error. This matched the provider's address and UTXO responses.

## App checks

1. Built and launched the Electron 44.4.5 Linux unpacked app under an isolated profile with `BITCOIN_TESTNET_ESPLORA_URL` set in the main-process environment.
2. Imported the public address as a **Bitcoin testnet** / **p2wpkh** watch-only treasury. Balance, UTXO, tip, and transaction history matched the live provider.
3. Restarted the packaged app with the same isolated profile. The treasury and watch snapshot were present in local storage before reopening the detail screen; balance and UTXO still displayed correctly after reopening and sync.
4. Reimporting the same address was refused as an existing watch source. Selecting mainnet for the `tb1…` address was rejected as an invalid mainnet address.
5. A packaged-app hard load of `/treasury/new/bitcoin` rendered the setup form after adding the origin-root HTML base. Before that fix, the relative bundled assets resolved under `/treasury/new/assets/` and left the page blank. The rebuilt app resolved its script under `/assets/`.

This confirms the funded-address watch, history, exact satoshi balance, duplicate refusal, network mismatch, and restart recovery paths. It does not exercise a newly pending transaction, ranged descriptor discovery, a live reorg, or unavailable-provider recovery. Those paths have fixture tests or remain separate manual checks in the [Slice A playbook](phase-5-slice-a-bitcoin-watch-smoke-playbook.md).

## Next gates

UniSat's [normal mobile Send instructions](https://docs.unisat.io/products/unisat-wallet/how-to-deposit-withdraw-assets) provide no pre-broadcast raw-hex export step. Its [mobile developer deeplink](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet/connect-with-unisat-mobile-wallet) can request `signPsbt`, but that needs a separate helper. The chosen next path is a fresh [Sparrow desktop wallet](https://sparrowwallet.com/download/) on **Testnet3**, funded independently. Sparrow [documents saving or copying a final signed transaction](https://sparrowwallet.com/features/), which can supply the external artifact for ChainPay's [A2 manual broadcast](phase-5-slice-a2-bitcoin-manual-broadcast-smoke-playbook.md) and [A3 accounting](phase-5-slice-a3-bitcoin-accounting-smoke-playbook.md). Do not move the UniSat recovery words into Sparrow, ChainPay, or the repository.
