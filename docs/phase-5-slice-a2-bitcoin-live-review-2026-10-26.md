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
