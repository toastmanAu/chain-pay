# Crypto payment flow

End-to-end lifecycle of one payment from payroll calculation to confirmed on-chain settlement.

## State machine

```
   ┌──────────┐
   │  draft   │
   └────┬─────┘
        │ user: "calculate batch"
        ▼
   ┌──────────────┐
   │  calculated  │  (FX rates snapshotted, crypto amounts derived, fee estimated)
   └────┬─────────┘
        │ user: "send for approval"
        ▼
   ┌────────────────────┐
   │  pending_approval  │  (treasury owners review)
   └────┬───────────────┘
        │ M-of-N owners approve (off-chain — Frappe audit log)
        ▼
   ┌──────────┐
   │ approved │
   └────┬─────┘
        │ adapter: build unsigned tx; produce sighash
        ▼
   ┌──────────────────────┐
   │  awaiting_signature  │  (sigs collected from co-signers)
   └────┬─────────────────┘
        │ threshold sigs collected
        ▼
   ┌─────────────────────┐
   │ ready_to_broadcast  │
   └────┬────────────────┘
        │ adapter.broadcastTransaction(...)
        ▼
   ┌─────────────┐
   │ broadcasted │
   └────┬────────┘
        │ tx hash returned
        ▼
   ┌─────────────┐
   │ confirming  │  (polled via embedded light client / viem)
   └────┬────────┘
        │ N confirmations (chain-specific)
        ▼
   ┌──────────┐
   │confirmed │  → persist source → derive/post journal → done
   └──────────┘

   ┌─────────┐
   │ failed  │  ← any chain-level failure (bad witness, replaced tx, etc.)
   └─────────┘

   ┌──────────┐
   │cancelled │  ← user cancels before broadcast
   └──────────┘
```

## What happens at each transition

### draft → calculated
- Payroll service iterates batch payees
- For each: convert `salary_fiat` to `crypto` using FX snapshot
- Estimate fee per chain (via adapter)
- Store all numbers + FX snapshot in `Crypto Payment Batch` DocType

### calculated → pending_approval
- Generate human-readable summary view
- Write `Crypto Audit Log` entry: `actor=<user>, action=submit_for_approval, batch=<id>`

### pending_approval → approved
- M-of-N treasury owners click "approve" in their app
- Approval is **off-chain trust** at this stage — it does NOT bypass the multisig signing step
- Approval count tracked in audit log

### approved → awaiting_signature
- Adapter builds unsigned tx (single tx, multiple outputs)
- Produces stable `signingDigest` (CKB sighash; EVM SafeTx hash)
- Pending tx record created with status `awaiting_signature`

### awaiting_signature → ready_to_broadcast
- Each co-signer opens "Pending payments" feature
- Reviews sighash + decoded tx
- Signs via their preferred `SignerTransport`
- Signature uploaded back; recorded against their `signerHash`
- When `signatures.length >= threshold`, status auto-transitions

### ready_to_broadcast → broadcasted
- Adapter aggregates partial sigs into final signed tx
- Broadcasts via embedded light client (CKB) or viem (EVM)
- Stores `tx_hash`

### broadcasted → confirming
- Background polling: every 6s on CKB, every 12s on EVM
- Update confirmation count

### confirming → confirmed
- Threshold reached (CKB: 6 blocks; EVM: 12-24 blocks depending on chain)
- Auto-call `post_confirmed_payment(record)`; Frappe submits the immutable
  source record, then calls `post_journal(batch_id)` without a client preview
- Mark batch as `confirmed` if all lines confirmed

### Any → failed
- Failure reasons: chain rejected tx, witness invalid, insufficient gas, etc.
- Status set to `failed`; full chain error stored in `Crypto Audit Log`
- User can clone the batch as new `draft` to retry

## Off-chain trust vs on-chain trust

The state machine has **two trust transitions**:

1. **Approval (off-chain):** owners click "approve" in the app. This is process-only. A compromised ChainPay could lie about approvals.
2. **Signing (on-chain):** owners sign the sighash in their wallet. This is cryptographic. A compromised ChainPay cannot forge a signature.

Approval is convenient — it lets non-signing stakeholders (HR director, controller) gate the batch before signers wake up. But the **only trust root that prevents theft is the signing threshold**, not the approval count.

Phase 2 UI must make this distinction obvious. Approving ≠ signing.

## Idempotency

- Re-broadcasting an already-broadcasted tx is a no-op (chains reject duplicates).
- Re-signing a tx with the same signer is a no-op (deduplicated by `signerHash` in `signatures[]`).
- Confirmed source persistence is digest-bound and idempotent on both external
  batch ID and `tx_hash`.
- Journal posting is independently idempotent on both identifiers; a replay
  returns the existing submitted Journal Entry.

## Failure recovery

| Failure | Recovery |
|---|---|
| Sig collected from wrong signer | Reject at upload; not added to `signatures[]` |
| Bad sig (verification fails) | Reject at upload; log to audit |
| Broadcast rejected by chain | Mark `failed`; clone as new draft |
| Tx replaced before confirmation | Mark `failed`; if EVM gas-replaced by sender, broadcast new tx with bumped fee |
| Light client disconnected mid-confirmation | Resume polling on reconnect (state is in DocType, not in memory) |
