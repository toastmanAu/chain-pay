# Phase 3 Slice C — Safe execution + confirmation smoke

This slice reconstructs a threshold-approved native-ETH SafeTx, revalidates
every persisted EOA signature, submits it through an injected owner wallet,
and tracks the outer Sepolia transaction to a successful or reverted receipt.
EVM accounting ingestion remains a later slice.

## Prerequisites

- Complete the Slice A and B setup in
  `docs/phase-3-slice-a-safe-monitor-smoke-playbook.md` and
  `docs/phase-3-slice-b-safe-owner-approval-smoke-playbook.md`.
- The approval shows **Signature threshold met**.
- The connected Safe owner has enough Sepolia ETH to pay execution gas.

## Execute

1. Open **Approvals** and select the threshold-approved payment.
2. Recheck the Safe address, recipient, value, nonce, calldata, operation, and
   SafeTx hash.
3. Choose **Execute on Sepolia**.
4. In the wallet, verify the transaction targets the Safe contract and approve
   the execution gas transaction.
5. Confirm ChainPay immediately records the outer Ethereum transaction hash
   and shows **Confirming on Sepolia**.
6. Quit and restart ChainPay while the receipt is pending. Reopen the approval
   and confirm polling resumes from the persisted outer transaction hash.
7. Wait for **Confirmed** and verify the recorded Sepolia block number.

## Explorer checks

- The outer transaction hash exists and its receipt status is successful.
- The Safe emitted its execution event and its nonce increased by one.
- The recipient balance increased by the exact reviewed native-ETH value.
- The SafeTx hash shown by ChainPay is distinct from the outer Ethereum
  transaction hash.
- No ERPNext source payment or Journal Entry is expected in this slice.

## Negative checks

- Removing or changing one persisted signature fails before the wallet opens.
- A duplicate, non-owner, malformed, or below-threshold signature set is
  refused before submission.
- A non-owner connected wallet is refused as the execution account.
- A reverted receipt moves the approval to **Failed** and displays the reason.
- Reopening a confirmed approval never offers the Execute button again.

## Automated gate

```sh
cd apps/desktop
npm run typecheck
npm test
npm run build
```
