# Phase 3 Slice B — Safe payment + owner approval smoke

This slice builds and reviews a native-ETH Sepolia Safe transaction, then
records one injected-wallet owner's EIP-712 signature. It deliberately does
not execute or submit the transaction.

## Prerequisites

- A Safe v1.3.0 or v1.4.1 deployed on Sepolia and imported into ChainPay.
- The Safe has a small Sepolia ETH balance.
- An injected EVM wallet is available to Electron and one selected account is
  an owner of the Safe.
- Optional: `VITE_EVM_SEPOLIA_RPC_URL` in `apps/desktop/.env`. When omitted,
  ChainPay uses viem's Sepolia public default.

For the clearest smoke, use a 1-of-N Safe. A higher threshold is also valid,
but one approval will correctly remain below threshold.

## Build and review

1. Run `npm run dev:desktop`.
2. Open **Treasury**, select the imported Sepolia Safe, and choose
   **New payment**.
3. Enter a Sepolia recipient and a positive ETH amount below the displayed
   Safe balance.
4. Choose **Build and review**.
5. On the review screen, compare all of these with the intended payment:
   Safe address, recipient, ETH/wei amount, chain ID 11155111, operation
   `CALL (0)`, empty calldata `0x`, Safe nonce, version, and SafeTx hash.

## Owner approval

1. Choose **Connect owner wallet and approve**.
2. Approve the Sepolia network switch if the wallet requests it.
3. Inspect the wallet's EIP-712 SafeTx prompt and confirm its recipient and
   value match ChainPay's review screen.
4. Sign the typed data.
5. Confirm the owner address appears under **Recorded owner approvals**.
6. For a 1-of-N Safe, confirm the state becomes **Signature threshold met**.
   For a higher threshold, confirm it remains awaiting further signatures.

## Restore check

1. Quit and restart ChainPay.
2. Open **Approvals**, then reopen the payment.
3. Confirm the exact owner approval is still present and the signature count
   and lifecycle state are unchanged.

## Negative checks

- A non-owner selected in the wallet is refused before any signature prompt.
- A wallet on another chain is asked to switch to Sepolia.
- An address with insufficient Safe balance cannot create the payment.
- Changing the persisted payload, review output, or SafeTx hash causes signing
  to fail closed.
- No transaction is broadcast: the Safe nonce and balances remain unchanged.

## Automated gate

```sh
cd apps/desktop
npm run typecheck
npm test
npm run build
```
