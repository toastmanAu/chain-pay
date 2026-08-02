# Phase 3 Slice D — Safe accounting recovery smoke

End-to-end verification that one confirmed Sepolia native-ETH Safe payment
becomes one immutable ERPNext source record and one balanced, submitted Journal
Entry. The connected owner wallet pays execution gas; that gas is retained as
receipt evidence and is not credited out of the Safe treasury account.

## Prerequisites

1. Start or migrate the local backend with `./scripts/backend-up.sh`.
2. Launch the desktop app with `FRAPPE_URL`, `FRAPPE_API_KEY`, and
   `FRAPPE_API_SECRET` set as described in
   `docs/phase-5-slice-c-smoke-playbook.md`.
3. Import a Sepolia Safe with enough ETH for the transfer. Its executing owner
   wallet also needs Sepolia ETH for gas.

## Confirm and post

1. Create a native-ETH Safe payment and enter a payee/accounting reference plus
   a positive USD value. These accounting fields are committed before signing.
2. Collect the Safe owner threshold, execute, and wait for receipt confirmation.
3. Confirm the approval advances through **Posting to ERPNext** to **Posted** and
   displays an ERPNext Journal Entry name.
4. In **Crypto Payment Batch**, verify the submitted source record contains:
   the ChainPay ID, SafeTx hash, distinct outer transaction hash, Safe address,
   executor, recipient, confirmed block/time, gas used, effective gas price,
   computed gas fee, and `gas_payer = executor`.
5. In the linked Journal Entry, verify `crypto_batch_id`, `crypto_tx_hash`, and
   `crypto_safe_tx_hash` match the source. It must be submitted and balanced.
   The debit and treasury credit must equal only the reviewed USD payment value;
   executor-paid gas must not increase the Safe treasury credit.

## Failure and restart recovery

1. Stop the backend before a second Safe payment confirms.
2. Let the chain receipt succeed. ChainPay must retain the confirmed outer hash
   and receipt evidence, then show **accounting failed** / **Retry accounting**.
3. Restart ChainPay. Confirm it does not offer **Execute on Sepolia** and does
   not broadcast another transaction.
4. Restart the backend, choose **Retry accounting**, and verify the payment
   reaches **Posted**.
5. If the first request reached Frappe but its response was lost, the retry must
   return the same source record and Journal Entry. Verify exactly one
   `Crypto Payment Batch` exists for each SafeTx and outer hash, and exactly one
   Journal Entry exists for all three source identifiers.

## Negative checks

- Changing any replayed immutable value is rejected by Frappe.
- Reusing either a SafeTx hash or outer transaction hash for another record is
  rejected.
- Missing/malformed receipt metadata, mismatched outer hashes, non-positive gas,
  or `gasFeeWei != gasUsed × effectiveGasPriceWei` is rejected.
- A CKB record carrying EVM metadata is rejected, as is an EVM record without it.

## Automated gate

```sh
npm --workspace apps/desktop run typecheck
npm --workspace apps/desktop test
npm --workspace apps/desktop run build
```

With the backend running, also run:

```sh
docker compose --env-file docker/.env -f docker/docker-compose.yml exec -T backend \
  bench --site chainpay.localhost run-tests --module crypto_payroll.test_api
```

The backend suite includes Safe source persistence, dual-hash replay,
server-derived balancing, and executor-paid gas-policy coverage.
