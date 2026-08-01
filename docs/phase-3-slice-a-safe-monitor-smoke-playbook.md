# Phase 3 Slice A — Sepolia Safe monitor smoke

This slice imports and monitors an existing Safe. It does not create or execute
Safe transactions yet.

## Prerequisites

- An existing Safe deployed on Sepolia.
- Optional: set `VITE_EVM_SEPOLIA_RPC_URL` in `apps/desktop/.env` to use a
  specific Sepolia RPC. If omitted, viem's public default is used.

## Smoke

1. Run `npm run dev:desktop`.
2. Open **Treasury**, then choose **Add Sepolia Safe**.
3. Enter a label and the Sepolia Safe contract address.
4. Select **Verify and add Safe**.
5. Confirm the detail screen shows:
   - the Safe's ETH balance;
   - current Sepolia block height;
   - the on-chain threshold and owner list; and
   - the Safe contract version.
6. Compare the address, owners, and threshold against the Safe web app or a
   Sepolia explorer.
7. Leave the screen open for at least 12 seconds and confirm the refresh age
   resets.

## Negative checks

- An EOA or empty address reports that no contract is deployed.
- A non-Safe contract reports that it is not a readable Safe.
- Re-adding the same Safe reports that it is already in the treasury list.
- An RPC connected to another chain reports the expected and received chain IDs.

## Automated gate

```sh
cd apps/desktop
npm run typecheck
npm test
```
