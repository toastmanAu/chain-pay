# Live-gate run sheet — Bitcoin (Slices A → A2 → A3)

**Status:** prepared 2026-08-12, not yet run. Consolidates three playbooks into one sitting:
`phase-5-slice-a-bitcoin-watch`, `phase-5-slice-a2-bitcoin-manual-broadcast`,
`phase-5-slice-a3-bitcoin-accounting`. Read those for the full assertions; this sheet is the
sequence, the setup, and the traps.

## Why these three have never run

Not for want of time. **No chain provider was configured** — `BITCOIN_TESTNET_ESPLORA_URL` was
unset, so every gate would have failed at step 1. That is now wired (see below) and the provider
has been exercised end-to-end against the live endpoint through its own code path.

## Environment — already done

`apps/desktop/.env.accounting.local` now carries:

```
BITCOIN_TESTNET_ESPLORA_URL=https://blockstream.info/testnet/api
```

Keyless, no mainnet funds at risk. Verified working through `scanBitcoinAddresses` itself
(not merely curl): tip height, tip hash, address stats, UTXO set, and the paginated
`/txs/chain/{last}` history walk all return 200.

ERPNext is up and the accounting credentials are configured. One CKB payment is already posted
(`BATCH-2607-0025`), so the compliance-export gate later needs only a Safe payment.

## What you need to bring

1. **A funded Bitcoin testnet wallet you control externally** — Sparrow, Electrum in testnet mode,
   or a hardware wallet. It must be able to produce a **fully signed, finalized raw transaction
   hex**. ChainPay never signs; it inspects and broadcasts.
2. **Testnet coins.** Faucets are unreliable; budget time for this or reuse an existing stash.
   You need enough for one transaction with at least one external output plus change.
3. **A watch-only address or descriptor** to import — the wallet's receive address or an xpub
   descriptor.
4. **About 90 minutes**, most of it waiting: A3 does not post until **six confirmations**, which
   on testnet is roughly an hour and can be much longer if blocks are slow.

## Launch

```bash
npm run dev:desktop:accounting
```

That script sources `.env.accounting.local` into the main process. Launching with a plain
`npm run dev:desktop` will leave the provider unconfigured and the Bitcoin screens inert.

## Sequence

### Slice A — watch-only treasury
Import the watch-only source and sync. Confirm balance, UTXO list, and transaction history match
what a block explorer shows for the same address. Record tip height and hash.

### Slice A2 — reviewed manual broadcast
Build and fully sign the transaction **in your external wallet**. Paste the final raw hex into
ChainPay and choose **Inspect signed transaction**. Verify every input, output, change candidate,
fee, fee rate, txid, and warning against what your wallet showed you. Then approve and broadcast.
Record the txid.

### Slice A3 — accounting at six confirmations
For every positive external output, enter a payee reference and a positive USD obligation in cents.
Watched change and zero-value `OP_RETURN` outputs must have no mapping fields. Prepare the
**accounting-bound review (v2)**, approve the immutable review, and broadcast.

Then the gate proper:
- At **five** confirmations: UI must still read *Waiting for 6 canonical confirmations*, with no
  finalized evidence and **no** source record or Journal Entry in ERPNext.
- At **six**: canonical block height/hash evidence appears, followed by the Crypto Payment Batch
  and Journal Entry identifiers.
- In ERPNext: one BTC/8-decimal child line per mapped external output; exact sats and USD; txid,
  wtxid, raw hash; block and depth; totals; fee and rate; ordered output JSON; and the
  `transaction_inputs` fee policy. Debits equal credits, and the BTC fee is audit metadata only
  under the current zero-FX policy.

### Recovery and negative gates (the part most likely to find a bug)
1. Stop ERPNext right after the six-confirmation evidence is accepted. Expect **Post failed — safe
   to retry**. Restart, retry, and confirm the **same** source-record and Journal Entry IDs come
   back with **no** rebroadcast.
2. Restart ChainPay mid-post. It must recover as retryable with the same raw transaction, review,
   receipt, and evidence.
3. Load a persisted A2-era review. Broadcast and status must still work, the legacy exclusion
   notice must show, and **no** accounting post may occur.

## Traps found while preparing this

**A high-history address reports the wrong error.** Blockstream returns `400 Too many history
entries` for `/address/{addr}/utxo` on addresses with large UTXO sets — miner payout addresses and
faucet hot wallets in particular. ChainPay's provider collapses every non-OK response into
**"Bitcoin provider is unavailable"**, so this presents as *the endpoint is down* when in fact the
endpoint is fine and the address is unsupported.

I walked into this myself while preparing. If you see "unavailable" during Slice A, check the
address's history before suspecting the provider:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://blockstream.info/testnet/api/address/<ADDR>/utxo
```

A `400` there means pick a different address. **Use a fresh receive address**, not a faucet's
sending address.

This is the same diagnostic-quality class as the `preserve-caught-error` findings fixed in PR #19 —
`bitcoin-provider.ts`'s `request()` catch-all discards the real reason. Worth a small follow-up to
propagate the status and body.

**Fixture discipline.** Three separate times while validating the provider I picked a bad test
address — a mainnet txid, a high-history test vector, then a coinbase payout address — and each
looked like a provider failure. Verify a fixture is representative before concluding the code is
wrong.

## What to record

Txid, block height and hash at six confirmations, the review digest, the Crypto Payment Batch name,
and the Journal Entry name. Those go in the PR / memory as the canonical regression target for this
path, the way `0x69ebf7…3b4e1` serves the CKB payroll path.
