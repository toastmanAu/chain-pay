# Phase 3 Slice E — WalletConnect + two-instance Safe approval smoke

End-to-end manual verification that two isolated ChainPay instances can approve
the same canonical Sepolia SafeTx with different owner transports, exchange
only locally verified 65-byte approvals, execute once, and continue through the
existing ERPNext accounting lifecycle without Safe Transaction Service.

## Prerequisites

- A Sepolia Safe with at least two EOA owners and threshold 2.
- Owner A available through an injected browser wallet on instance A.
- Owner B available through a WalletConnect v2-compatible wallet.
- Two machines or two isolated OS/Chromium user-data profiles. Do not point both
  instances at the same renderer local-storage directory.
- Set `VITE_WALLETCONNECT_PROJECT_ID` before building/launching instance B. This
  public project identifier is configuration; WalletConnect session topics and
  pairing URIs must never appear in ChainPay approval files or domain stores.
- Complete the Slice D ERPNext setup if the final accounting continuation is
  part of this smoke.

## Build the identical SafeTx twice

1. Import the same Safe on both instances and verify its live owners, threshold,
   version, balance, and chain ID 11155111.
2. Before either instance executes anything, create the same native-ETH payment
   on both: identical recipient and wei value while the Safe nonce is unchanged.
3. Review both screens side by side. Safe address, recipient, value, calldata,
   operation, nonce, Safe version, and **SafeTx hash must be identical**. Stop if
   either hash differs.

The interchange file intentionally contains no transaction payload. An
importing instance must already hold and display the exact canonical SafeTx;
this prevents imported mutable fields from replacing its locally reviewed data.

## Owner A — injected wallet

1. On instance A choose **Approve with browser wallet** and approve as owner A.
2. Confirm the recorded owner address is correct.
3. Choose **Export approval** for owner A and inspect the JSON. Its only keys
   must be `schema`, `version`, `chainId`, `safeAddress`, `safeTxHash`, `signer`,
   and `signature`. It must not contain a payload, WalletConnect URI/topic,
   project ID, account list, or other session data.
4. Transfer this public approval file to instance B and choose **Import
   approval**. Confirm the count becomes 1/2.

## Owner B — WalletConnect

1. On instance B choose **Pair WalletConnect**.
2. Verify both the QR code and **Open wallet deep link** are shown. Pair owner B
   and approve only a session for Sepolia.
3. Quit and restart instance B before signing. Reopen the approval and verify
   the WalletConnect account is restored without a new QR ceremony.
4. Choose **Approve with WalletConnect**. In the wallet, verify the EIP-712
   domain points to the expected Safe on chain 11155111 and the SafeTx fields
   match ChainPay's review.
5. Confirm threshold becomes 2/2. Export owner B's approval and import it on
   instance A. Instance A must also become threshold-ready.

## Execute and account once

1. Execute from instance A using an injected Safe owner wallet.
2. Verify the outer transaction confirms once; neither import nor retry should
   expose or invoke another execution.
3. If ERPNext is configured, verify the existing Slice D
   `posting → posted | post_failed` recovery flow is unchanged.

## Negative checks

- Pairing an Ethereum-mainnet-only session reports a Sepolia/wrong-chain error.
- A rejected pairing or signing request reports wallet rejection without saving
  an approval.
- An expired/deleted session requires pairing again; **Disconnect
  WalletConnect** removes the active session.
- Importing the approval into a payment with a different Safe, chain, nonce,
  recipient, value, or SafeTx hash is rejected.
- A malformed signature, changed signer, non-owner signer, duplicate owner,
  unsupported recovery ID, or JSON file with unknown extra fields cannot affect
  the persisted threshold.

## Automated gate

```sh
npm --workspace apps/desktop run typecheck
npm --workspace apps/desktop test
npm --workspace apps/desktop run build
```

Focused coverage includes provider/session lifecycle, exact typed-data request,
live owner revalidation, signature recovery/normalization, strict interchange,
duplicate protection, restart persistence, QR/deep-link UI, and import/export.
