# Phase 5 Slice B2B — finalized SOL accounting smoke playbook

This verifies the native-SOL durable-nonce flow from an immutable v2 review through finalized devnet evidence and one idempotent ERPNext Journal Entry. ChainPay never handles a seed phrase or private key. Existing B2A v1 reviews remain broadcast/status compatible and are deliberately excluded from accounting.

## Preconditions

1. Start and migrate ERPNext with `bash scripts/backend-up.sh`.
2. Configure Electron main-process environment only:

   ```text
   SOLANA_DEVNET_RPC_URL=https://your-devnet-provider.example/rpc
   SOLANA_DEVNET_RPC_BEARER_TOKEN=optional-token
   FRAPPE_URL=http://chainpay.localhost:8001
   FRAPPE_API_KEY=your-api-key
   FRAPPE_API_SECRET=your-api-secret
   ```

3. Start ChainPay with `npm run dev:desktop:accounting`.
4. Use a devnet source, funded durable-nonce account, decoded nonce authority, and fee payer. Keep all signing keys in an external Solana signer.

## Finalized payment to ERPNext

1. Open the Solana treasury and choose **New SOL payment**.
2. Enter a destination, exact SOL amount, payee/accounting reference, and positive USD obligation. Prepare the review.
3. Verify the immutable review includes the payee, USD value, exact lamports and fee, source/destination, fee payer, nonce account/authority/value, instruction order, and v2 review digest.
4. For every required signer, externally sign both:
   - the decoded `messageBase64` transaction message; and
   - the UTF-8 bytes `chainpay:solana-review-approval:v2\n<reviewDigest>`.
5. Import each `chainpay-solana-signature-v2` envelope. Change the payee or fiat value in a copied proposal/envelope and verify import is rejected.
6. Confirm and broadcast once. At `processed` and `confirmed`, verify the UI says it is waiting and ERPNext has no matching Crypto Payment Batch.
7. Wait for `finalized`. Verify the UI displays finalized slot/time, actual lamport fee, and fee payer, then shows the immutable Crypto Payment Batch and Journal Entry identifiers.
8. In ERPNext, verify:
   - chain, signature, review digest, exact amount lamports, slot, source, destination, nonce evidence, message, actual fee, and fee-payer policy match the review/evidence;
   - the Journal Entry is submitted and debit equals credit;
   - the server-selected accounts are used and no account names came from ChainPay.

## Recovery and idempotency

1. Stop ERPNext immediately after finalization or while the UI says **Posting to ERPNext**. Restart ChainPay. The state must recover as **Accounting post needs retry**; it must not rebroadcast.
2. Restart ERPNext, choose **Retry accounting post**, and confirm the same source-record and Journal Entry identifiers are returned.
3. Retry again or replay the exact POST. Confirm only one Crypto Payment Batch and one Journal Entry exist for the signature/review digest.
4. With a disposable provider/test fixture, regress a previously finalized/posted status to unknown or failed. Verify the prominent reconciliation warning retains receipt and ERPNext IDs and performs no reversal, rebroadcast, or automatic repost.
5. Load a persisted v1 B2A review. Verify it remains signable/submittable/status-trackable and displays the explicit accounting-exclusion notice.

## Automated gates

```bash
npm run typecheck
npm run build:shared
npm run build:desktop
npm --workspace apps/desktop test
docker compose --env-file docker/.env -f docker/docker-compose.yml exec -T backend \
  bench --site chainpay.localhost run-tests --app crypto_payroll
npm audit --omit=dev
```

Inspect the production build and diff for RPC URLs, bearer tokens, authorization headers, upstream response bodies, seed phrases, private keys, and keypairs. Verify renderer IPC contains only fixed typed operations and public payment artifacts.
