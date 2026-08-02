# Phase 5 Slice A — Bitcoin watch-only smoke playbook

This playbook exercises Bitcoin testnet watch-only behavior. Regtest is intentionally not an
importable ChainPay network in this slice: accepting `bcrt1…` would violate the mainnet/testnet-only
scope. Provider protocol, pagination, reorg, and malformed-response cases are covered by the local
automated provider fixtures.

## Preconditions

- An Esplora-compatible Bitcoin testnet provider reachable from the desktop main process.
- A testnet wallet controlled outside ChainPay, with either a `tb1…` receive address or a public
  account descriptor/xpub. Do not use a wallet containing real funds for this smoke test.
- Optional testnet coins from a faucet for balance and confirmation checks.

Set the provider in the environment used to start Electron:

```sh
BITCOIN_TESTNET_ESPLORA_URL=https://your-testnet-provider.example/api npm run dev --workspace apps/desktop
```

If the provider requires a bearer token, set `BITCOIN_TESTNET_ESPLORA_BEARER_TOKEN` in the main
process environment. Never prefix these names with `VITE_`; Vite variables are renderer-visible.
Loopback `http://127.0.0.1:PORT` is accepted for a self-hosted provider; non-loopback providers must
use HTTPS.

## Import and refusal checks

1. Open **Treasury → Add Bitcoin watch**.
2. Keep **Bitcoin testnet** selected and import a testnet address with its explicit script type.
3. Confirm the treasury opens as **Bitcoin watch-only** and has no send, signing, PSBT, or broadcast
   action.
4. Attempt to import the same source again. Confirm ChainPay refuses the duplicate.
5. Attempt to import a `bc1…` mainnet address while testnet is selected. Confirm it is rejected.
6. In the account-xpub flow, paste an `xprv`, `tprv`, or a 12-word seed phrase made only for this
   negative test. Confirm it is rejected and does not appear in local storage.
7. Import a ranged `wpkh`, `sh(wpkh)`, `pkh`, or `tr` public descriptor. If it has a checksum, alter
   one checksum character and confirm the altered descriptor is rejected.

## Balance, UTXO, history, and receive discovery

1. Fund the watched testnet address externally.
2. Click **Refresh**. Confirm the pending transaction appears with zero confirmations and the exact
   satoshi amount is reflected in the balance/UTXO rows without floating-point rounding.
3. Mine or wait for a block, refresh, and confirm the transaction and UTXO show the correct
   confirmation count.
4. For a ranged source, fund a later external receive index with a gap smaller than the configured
   limit. Refresh and confirm discovery advances the next receive address to one index after the
   highest used address.
5. Close ChainPay during or after discovery, reopen it, and confirm the discovery cursor, next
   receive index, snapshot, and last sync state recover from `chain-pay:bitcoin-watch`.
6. Verify one transaction involving multiple watched addresses appears once in history and its net
   satoshi value covers all watched inputs and outputs.

## Reorg and unavailable-provider behavior

The automated provider fixtures prove that a transaction or UTXO whose recorded block hash no
longer matches `/block-height/:height` is downgraded to unconfirmed, and that the next snapshot
atomically replaces stale UTXOs and confirmations. Run them with:

```sh
npm test --workspace apps/desktop -- --run electron/main/bitcoin-provider.test.ts src/lib/chains/btc/sync.test.ts
```

For the manual unavailable case, stop the local provider or start ChainPay without
`BITCOIN_TESTNET_ESPLORA_URL`. Confirm the treasury shows a clear configuration/sync error, retains
the last good snapshot, and remains usable for navigation. Restore the provider and refresh.

## IPC secrecy check

Open renderer DevTools and inspect `window.chainpay.bitcoin`. It may expose only `status`, `scan`, and
`transactionStatus` functions. Status responses contain only `{ configured }`; scan/status results
contain public chain data only. Confirm provider URLs, bearer tokens, authorization headers, private
keys, and seed phrases do not appear in renderer local storage, console output, accounting exports,
or IPC responses.

## Regression gate

```sh
npm run typecheck
npm test --workspace apps/desktop
npm test --workspace packages/shared
npm run build:desktop
```
