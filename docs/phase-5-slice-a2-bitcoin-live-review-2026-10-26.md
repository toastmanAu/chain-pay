# Bitcoin Testnet4 signed transaction review — 2026-10-26

Sparrow exported a finalized, externally signed raw transaction. ChainPay did not construct or sign it. This note records public transaction metadata only; the unbroadcast signed bytes are not stored in the repository.

| Field | Read-only review result |
|---|---|
| Chain | `btc:testnet4` |
| Transaction ID | `2d49a3c107fd58d6696925a7f1b44b18d6fee7717952f5aaca9730fda1367298` |
| Input | Confirmed faucet output `92bb61a6f5971a20ebcfc94275cd43cb421566287caf62943ae64f1262250006:1`, 50,000 sats, watched P2WPKH |
| Output 0 | `tb1q3n506r2xt3n3ypupl4s030sc4hhf05hmvyg4aj`, 5,000 sats |
| Output 1 | `tb1qmfa2529ufhkmamq63jp7gj5u3j2vuggfdrkm45`, 44,859 sats; likely Sparrow change, ownership not independently verified |
| Miner fee | 141 sats, 1 sat/vB (141 vB) |
| Locktime | 157,645 |

The first provider lookup returned HTTP 404 for `/tx/:txid`, but its `/tx/:txid/status` returned HTTP 200 with `{ "confirmed": false }`. ChainPay had treated that status response as proof the transaction was already broadcast. The provider code now checks the full transaction endpoint for existence during review, conflict recovery, and status polling. Regression tests cover the provider's conflicting responses. Typecheck, lint, production build, and the full desktop suite passed (1,218 tests, 4 skipped). A rebuilt packaged app successfully ran **Inspect signed transaction** against the public Testnet4 provider through the temporary read-only localhost relay; its UI displayed both positive outputs for accounting mapping. No broadcast control was used.

The current treasury watches only the original fixed address, so ChainPay classifies both outputs as external. If output 1 is Sparrow change, an A3 accounting-bound review would incorrectly require a payee and USD obligation for it. A correct A3 path needs a transaction with no change output or a watch source that also proves the change address belongs to this wallet. Do not approve an accounting mapping that presents wallet change as a payment.

At the last check the full transaction endpoint still returned 404 and the original faucet UTXO remained unspent. The operator chose to keep this transaction unbroadcast and replace it with a **no-change** transaction for the combined A2+A3 gate. The replacement should spend the same 50,000-sat UTXO, pay one externally controlled Testnet4 recipient address, and leave no change output; its destination, exact amount, fee, and signature must be reviewed again before any on-chain broadcast.

## No-change replacement reviewed

Sparrow supplied both its pre-signing transaction bytes and its finalized signed bytes. They share transaction ID `34f26f30229b2060b9101014f6150ba8f0436659a73a30314f615ae40cd2e90b`. The signed transaction has a two-item SegWit witness and wtxid `938a60ec9dceee3eb9641bbe5bb2cddb364023f8592328fde2cef0b55ba7b0ad`. The previously recorded value was the internal byte order of the txid, not the witness transaction ID; the code and evidence were corrected on 2026-10-30.

ChainPay's read-only live review verified the confirmed 50,000-sat faucet input, one P2WPKH output of **49,890 sats** to `tb1q3n506r2xt3n3ypupl4s030sc4hhf05hmvyg4aj`, no change output, a **110-sat fee** at **1 sat/vB**, and no signature or policy warnings. The public provider's current minimum/recommended fee was 1 sat/vB. The operator then confirmed the recipient is **another receive address in the same Sparrow wallet**. This is a self-transfer, so a payee expense and USD obligation would be incorrect even though the fixed-address ChainPay watch marks the destination as non-watched. Do not use this transaction for A3 accounting or broadcast it as the combined A2+A3 gate.

The correct combined-gate path is a new Testnet4 transaction from the same unspent faucet output to an address in a **separate recipient wallet**, with no change output. Treat the separate wallet as a simulated test payee and approve its test USD obligation explicitly during review. At the latest check this self-transfer still returned HTTP 404 from the full transaction endpoint and the 50,000-sat faucet UTXO remained unspent. No broadcast was performed.

## Separate recipient wallet — 2026-10-27

The operator created a separate Sparrow wallet and supplied its Testnet4 receive address, `tb1qs3s6jl4lr5x4lc7zlg5rgv56qq58esat5jn5rj`. ChainPay's Testnet address decoder accepts it as a canonical P2WPKH address. The public Testnet4 address endpoint showed no confirmed or mempool transactions at the time of the check. The faucet outspend endpoint still returned `{ "spent": false }` for `92bb61a6f5971a20ebcfc94275cd43cb421566287caf62943ae64f1262250006:1`. The public fee endpoint reported 1 sat/vB for minimum and recommended tiers.

Next, the original Sparrow wallet should construct a **Send Max** transaction from the 50,000-sat UTXO to this new address. Before broadcast, inspect the finalized signed raw transaction in ChainPay and verify the exact input, one recipient output, no change, fee, signatures, and policy warnings. Only then provide a test payee reference and operator-approved USD obligation for the accounting-bound review. The new wallet's seed and signing material stay outside ChainPay.

## First separate-wallet candidate — 2026-10-30

The operator supplied another finalized signed transaction, txid `60926ca82c474de7c44c58d3645f33d720a6aafbdac8ae849460e69defa0a755` (wtxid `05104359c55307d548c12c6395ab829474b1b4fe2c29342835631803737597ab`, corrected on 2026-10-30). ChainPay's local review verified its P2WPKH signature against the confirmed 50,000-sat faucet prevout. It has one output of **49,946 sats** to the separate wallet address `tb1qs3s6jl4lr5x4lc7zlg5rgv56qq58esat5jn5rj`, no change, and a **54-sat fee** at **0.49 sat/vB** (110 vB). The public Testnet4 provider's minimum/recommended fee endpoint currently reports **1 sat/vB**. This candidate is below that fee floor; do not broadcast it for the live gate. The full transaction endpoint returned HTTP 404 and the faucet outspend endpoint returned `{ "spent": false }` at the last check. The operator was asked to remake the Send Max transaction with at least 1 sat/vB and supply the new signed raw hex for review.

ChainPay's local review currently accepts positive fees below 1 sat/vB without a warning; provider relay policy may still reject them. Add a fee-floor warning or provider-aware preflight before release.

## Revised separate-wallet candidate — 2026-10-30

The revised finalized transaction has txid `e3eef945d690729590b8792e893f530b906945c906aee97439e50400b5c7ef63` and actual wtxid `2cf3b35c1363ceec66e27da7a875d770ad186d7f996912484032470c11a24382`. It spends the same confirmed 50,000-sat faucet output and pays one **49,885-sat** P2WPKH output to the separate wallet address, with **no change** and a **115-sat fee at 1.045 sat/vB** (110 vB). ChainPay's read-only live provider review verified the signature, finality, network, output, fee, and policy with no warnings. The operator approved a simulated payee reference `test-sparrow-recipient` and USD **1.00** obligation (100 cents); a version-2 accounting-bound review accepted that exact mapping. The public fee endpoint reported 1 sat/vB minimum, and the source outspend endpoint returned `{ "spent": false }` before review. No broadcast was performed.

During this review, ChainPay's `wtxid` field was found to contain the byte-reversed txid because `Transaction.hash` in the installed signer library is the internal txid hash. The review and finalized-evidence validation now calculate `sha256d` over the complete serialized raw transaction, including witness, then render it in display byte order. A BIP143 signed fixture asserts the correct witness ID, and a regression test rejects a pre-fix review even if its digest is otherwise valid. Typecheck, lint, production build, Linux unpacked package, and all 1,218 desktop tests passed (4 skipped). Pre-fix persisted reviews fail corrected finalized-transaction validation and need a fresh review and digest before accounting finalization.

The read-only harness used a placeholder treasury ID, so its review digest cannot be used for the actual treasury broadcast. Repeat the accounting-bound review in the corrected ChainPay app with the real Testnet4 watch-only treasury and confirm the current tip, digest, exact mapping, and destination immediately before any broadcast approval.
