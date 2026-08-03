# Phase 5 Slice A2 — Bitcoin testnet manual-broadcast smoke playbook

This playbook verifies the deliberately narrow, watch-only broadcast workflow. ChainPay reviews and relays a transaction that was fully constructed and signed elsewhere. It never requests or accepts a seed phrase, private key, signing request, construction parameters, or PSBT.

## Prerequisites

- A Bitcoin testnet watch-only treasury already synced in ChainPay.
- An HTTPS Esplora-compatible testnet provider configured in the Electron main-process environment:

  ```text
  BITCOIN_TESTNET_ESPLORA_URL=https://provider.example/api
  BITCOIN_TESTNET_ESPLORA_BEARER_TOKEN=optional-token
  ```

- A small confirmed testnet UTXO belonging to the selected treasury.
- An external wallet capable of constructing and fully signing a standard P2PKH, P2WPKH, P2SH-P2WPKH, or Taproot key-path transaction and exporting its final raw transaction hex.

Never place provider credentials in renderer settings, the raw-transaction field, screenshots, logs, or this repository. Never paste wallet secrets into ChainPay.

## Happy path

1. In the external wallet, construct a testnet spend from a watched UTXO. Choose the destination and fee there, sign every input, finalize it, and export only the raw transaction hex. Do not export a PSBT.
2. Open the matching **Bitcoin testnet** treasury in ChainPay and refresh it so the watched address set and tip are current.
3. Paste the final raw hex into **Manual signed transaction broadcast** and select **Review signed transaction**.
4. Verify all of the following before confirming:
   - the network and selected treasury;
   - transaction ID and immutable review digest;
   - every input outpoint, exact input amount, and whether ownership is watched or unknown;
   - every output address, exact amount, and watched change candidate;
   - miner fee and sat/vB rate;
   - provider tip height and every displayed warning.
5. Select the explicit confirmation checkbox, then select **Confirm and broadcast**.
6. Confirm the state becomes **Submitted**, the displayed txid matches the external wallet's txid, and status advances from pending to confirming after mining.
7. Quit ChainPay completely, restart it, reopen the treasury, and confirm the submitted receipt and raw public transaction survived restart and status tracking resumes.
8. Paste the same raw transaction again. Review must report **Already broadcast**, or confirmation must resolve idempotently to that state; it must not create a second attempt with a different txid.

## Negative checks

Perform each check without approving a real spend:

1. Paste a PSBT (hex begins `70736274ff`): it must be rejected as unsupported.
2. Remove or alter a signature byte: review must reject the transaction as unsigned or invalid.
3. Append a byte, truncate the transaction, duplicate an input, or use an oversized transaction: review must reject it before provider submission.
4. Select a mainnet treasury for the testnet spend: the watched-address/network validation or missing selected-network prevout must reject it.
5. Use a transaction with an immature absolute locktime or a relative sequence lock: review must reject it as non-final or unsupported.
6. Use a P2WSH, multisig P2SH, Taproot script-path/annex, unusual sighash, dust output, value-range violation, zero fee, or excessive fee: review must reject it as unsupported or policy-invalid.
7. Change the raw hex, selected treasury, watched address set, or let the provider tip change after review: confirmation must refuse the stale digest and require a fresh review.
8. Stop or misconfigure the provider: the UI must show **Provider unavailable** without URL, token, authorization header, or upstream response content.
9. Make a test provider return a txid other than the locally computed txid after `POST /tx`: the attempt must fail with a sanitized txid-mismatch error.

## Confirmation and reorg check

On a controlled test provider, first return a canonical confirmed status for the receipt and then return pending/unknown or a different canonical block hash. After refresh, ChainPay must retain the receipt, mark the prior confirmation as reorged, and continue status tracking. It must not automatically rebroadcast or post accounting entries.

## Scope audit

Confirm there is still no Bitcoin coin selection, transaction builder, construction fee estimator, signing/key-custody path, PSBT import/export, automatic rebroadcast, accounting posting, arbitrary provider proxy, regtest/signet option, or additional Bitcoin network in the UI or generic `ChainAdapter` spending methods.
