# Phase 5 Slice A3 — finalized BTC accounting smoke playbook

This verifies a Bitcoin testnet watch-only treasury from an externally signed
raw transaction through a six-confirmation, idempotent ERPNext Journal Entry.
ChainPay never constructs or signs the transaction and never accepts a seed,
private key, PSBT, or signing request.

## Prerequisites

1. Start the local ERPNext stack and run `bench --site chainpay.localhost migrate`.
2. Configure `BITCOIN_TESTNET_ESPLORA_URL` only in the desktop main-process environment.
3. Configure the accounting bridge and start ChainPay with `npm run dev:desktop:accounting`.
4. Import and sync a funded Bitcoin testnet watch-only treasury.
5. Create, fully sign, and finalize a standard testnet transaction in an external wallet. Keep the raw hex and all signing material outside ChainPay until the final raw transaction is pasted.

## Review and broadcast

1. Paste the final raw transaction and choose **Inspect signed transaction**.
2. Verify every input, output, change candidate, fee, fee rate, txid, and warning.
3. For every positive external output, enter a payee reference and positive USD obligation in cents. Confirm watched change and zero-value OP_RETURN outputs have no mapping fields.
4. Choose **Prepare accounting-bound review**. Verify review v2 shows the exact immutable mappings and states that they are operator-approved, not signed by the external Bitcoin signers.
5. Approve the immutable review and broadcast. Record the txid and review digest.

## Finalization and accounting

1. At five confirmations, verify the UI remains **Waiting for 6 canonical confirmations**, no finalized evidence exists, and ERPNext has no source record or Journal Entry.
2. At six confirmations, verify the UI shows the canonical block height/hash evidence and then both the Crypto Payment Batch and Journal Entry identifiers.
3. In ERPNext, verify one BTC/8-decimal child line per mapped external output, exact sats and USD values, txid/wtxid/raw hash, block/depth, totals, fee/rate, ordered output JSON, and `transaction_inputs` fee policy.
4. Verify the submitted Journal Entry debit equals credit and contains only the committed USD obligations; the BTC fee is audit metadata under the current zero-FX policy.
5. Export a Bitcoin-testnet compliance CSV and verify block height, exact native amount, `0.00001 BTC`-style fee formatting, transaction-input payer, immutable digest, and Journal Entry binding.

## Recovery and negative gates

1. Stop ERPNext immediately after the six-confirmation evidence is accepted. Verify **Post failed — safe to retry**, restart ERPNext, retry, and confirm the same source-record and Journal Entry IDs are returned without another broadcast.
2. Restart ChainPay while accounting is posting. Verify it recovers as retryable with the same raw transaction, review, receipt, and evidence.
3. On a controlled provider, regress a prior confirmed status to pending/unknown or change its canonical block mapping. Verify posting is blocked; if a late backend response or prior post exists, all backend IDs remain visible and **Manual reconciliation required** is prominent. Confirm there is no automatic reversal or rebroadcast.
4. Load a persisted A2 review. Verify broadcast/status still work, the legacy exclusion notice is visible, and no accounting post occurs.
5. Exercise missing, duplicate, reordered, change-output, address/value-mismatched, noncanonical/unsafe, and tampered-digest mappings. Exercise altered raw bytes, txid/wtxid, block evidence, totals, fee, and five-confirmation evidence. Each must fail before posting.

## Secrecy and regression gate

Inspect renderer state, IPC responses, logs, built artifacts, and the repository
diff for Esplora endpoints/tokens/headers/upstream bodies, ERPNext secrets,
private keys, seeds, and PSBT data. Run desktop typecheck/tests/build, shared and
mobile regressions, backend migration/tests, and the advisory audit. Confirm no
coin selection, construction, signing/custody, fee bumping, automatic
rebroadcast, new Bitcoin script/network, arbitrary RPC, or WebSocket surface was
introduced.
