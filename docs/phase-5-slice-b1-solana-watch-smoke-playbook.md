# Phase 5 Slice B1 — Solana watch-only smoke playbook

## Scope and safety invariant

This slice monitors one public Solana account on `sol:devnet` or `sol:mainnet`. It does not accept, store, construct, sign, or broadcast with a seed phrase, keypair, or private key. Provider URLs and bearer tokens remain in Electron's main process.

## Configure

Set one or both RPC URLs in the environment used to start the desktop app:

```text
SOLANA_DEVNET_RPC_URL=https://your-devnet-provider.example/rpc
SOLANA_DEVNET_RPC_BEARER_TOKEN=optional-token
SOLANA_MAINNET_RPC_URL=https://your-mainnet-provider.example/rpc
SOLANA_MAINNET_RPC_BEARER_TOKEN=optional-token
```

Only HTTPS endpoints are accepted, except loopback HTTP for a locally operated validator. Restart ChainPay after changing configuration.

## Manual smoke test

1. Open Treasury → Add Solana watch.
2. Select devnet, enter a label and a funded public address, then add it.
3. Confirm the detail screen shows “Solana watch-only,” provider readiness, exact balance, finalized slot and blockhash, receive address, and transaction history.
4. Compare balance, newest signatures, commitment state, fee, and watched-account delta with the configured provider or a trusted explorer.
5. Use “Check status” on processed, confirmed, finalized, and failed examples when available.
6. Restart ChainPay and confirm the last snapshot remains visible before the next refresh.
7. Disable the RPC setting, restart, and confirm the screen reports “Provider not configured” without losing the last good snapshot.
8. Enter a seed phrase, JSON keypair, and 64-byte base58 secret in the setup address field. Each must be rejected and no treasury created.

## Rollback drill

Against a controlled fixture/provider, first return a confirmed or finalized signature. On the next complete history response, omit it or regress its commitment. Confirm ChainPay replaces stale state and displays the rollback warning. A signature omitted only because the 100-entry history bound was reached must not trigger the warning.

## Automated gates

```text
npm --workspace apps/desktop run typecheck
npm --workspace apps/desktop test
npm --workspace apps/desktop run build
npm audit --omit=dev
```
