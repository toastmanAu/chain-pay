# Phase 5 Slice B2A — Solana durable-nonce payment smoke playbook

## Scope and custody invariant

This slice prepares and relays one native-SOL transfer using an existing initialized System Program durable nonce account. ChainPay never creates or changes a nonce account, signs locally, or accepts a seed, mnemonic, private key, keypair, derivation path, hardware-wallet session, or custody credential. The nonce account has one authority; the transaction's actual required signer list is not an M-of-N treasury policy.

Run the live gate on `sol:devnet` first. Repeat the identical gate on `sol:mainnet` only after devnet passes and with a deliberately small amount. Provider endpoints and bearer tokens belong only in the Electron main-process environment.

## Prerequisites

- Two separate devices: an online ChainPay operator device and an offline or independently administered signer device.
- A watched, funded, on-curve System Program source wallet.
- An existing initialized and rent-safe durable nonce account on the selected cluster.
- The public key of the nonce account's decoded authority.
- An externally administered, funded, on-curve fee payer.
- External signing software that shows the exact message bytes and signer public key before producing a raw Ed25519 signature. It must not expose secret material to ChainPay.
- A funded on-curve destination wallet, or a new unfunded on-curve destination.
- The matching main-process provider configuration:

  ```text
  SOLANA_DEVNET_RPC_URL=https://your-devnet-provider.example/rpc
  SOLANA_DEVNET_RPC_BEARER_TOKEN=optional-token
  SOLANA_MAINNET_RPC_URL=https://your-mainnet-provider.example/rpc
  SOLANA_MAINNET_RPC_BEARER_TOKEN=optional-token
  ```

Only HTTPS is accepted except loopback HTTP for a locally operated validator. Restart ChainPay after changing provider configuration.

## Signature-envelope interchange

Transfer the displayed review fields and base64 message to each signer over the organization's approved channel. The signer must independently compare the cluster, source, destination, amount, fee payer, nonce account, nonce authority, durable nonce, signer order, and review digest before signing the decoded message bytes.

Import only this strict JSON envelope, with no additional fields:

```json
{
  "format": "chainpay-solana-signature-v1",
  "chain": "sol:devnet",
  "treasuryId": "the-displayed-treasury-id",
  "reviewDigest": "the-64-character-displayed-digest",
  "signer": "the-signing-public-key",
  "signature": "the-base58-encoded-64-byte-ed25519-signature"
}
```

Never transfer a secret key, seed phrase, keypair file, signing-session token, provider URL, bearer token, or authorization header in an envelope.

## Devnet two-device happy path

1. Open the matching Solana devnet treasury and select **New SOL payment**.
2. Enter the existing nonce account, its independently decoded authority, and the external fee payer. Select **Validate and save public configuration**.
3. Confirm ChainPay rejects any nonce that is uninitialized, malformed, incorrectly owned, below rent safety, or controlled by a different authority.
4. Enter the destination and a small exact SOL amount. Select **Prepare immutable review**.
5. Compare every review field with an independent devnet RPC or trusted explorer. Confirm instruction zero is `AdvanceNonceAccount`, instruction one is exactly one System Program transfer, and there are no other instructions or address lookup tables.
6. Record the displayed actual required signer order. Confirm it contains only the message-required fee payer, source, and nonce authority public keys, with duplicates collapsed when roles share a key. Do not add policy approvers as transaction signers.
7. On the offline signer device, decode and inspect the displayed base64 message, sign those exact bytes with the matching required key, and create the strict envelope above. Return only the envelope to the operator device.
8. Import each envelope. Confirm ChainPay marks the corresponding public key **verified**, preserves canonical signer order across restart, rejects duplicates, and does not allow submission until every required signer is present.
9. Quit ChainPay after at least one partial signature, restart it, and confirm the immutable review and partial signatures return only after main-process signature/review validation.
10. Recheck network, destination, amount, fee payer, signer list, nonce account, and digest. Select the separate confirmation checkbox, then select **Confirm and broadcast exact reviewed bytes**.
11. Confirm the receipt signature equals the fee payer's locally derived first transaction signature and status progresses through processed/confirmed/finalized as the provider reports it.
12. Restart ChainPay and confirm the receipt remains idempotent and status tracking resumes. Attempt the same fully signed submission again using a controlled fixture or preserved state; it must resolve as already submitted and must not create a different signature.

## Negative and failure drills

Perform these with fixtures or without approving a real spend:

1. Alter the cluster, treasury ID, digest, signer, signature, amount, destination, message, signer order, or durable nonce. Import or submission must fail.
2. Add an unknown or duplicate signer, reorder envelopes, append an extra JSON field, use malformed base58/base64, or exceed the transaction/response bounds. The boundary must reject it.
3. Use a token account, mint, executable program, PDA/off-curve recipient, nonce account as recipient, or source as recipient. Preparation must reject it.
4. Use an unfunded on-curve destination. Preparation may pass; repeat with an unfunded off-curve address and confirm rejection.
5. Drain the source below the transfer requirement, drain a distinct fee payer below the exact fee, or drop the nonce below rent safety. Preparation/submission must stop before broadcast.
6. Advance the nonce externally after review. Final confirmation must report a stale nonce and require a new review; it must not rebuild or silently resign.
7. Make simulation fail before or after signing. ChainPay must not call broadcast.
8. Stop or misconfigure the provider. The UI must show a sanitized error without endpoint, token, authorization header, upstream body, or diagnostic leakage.
9. Make a controlled provider return a signature different from the locally derived first signature. Submission must fail with a sanitized signature-mismatch error.
10. Regress a confirmed/finalized status to unknown, processed, or failed in a controlled provider. ChainPay must retain the receipt, flag rollback, and must not rebroadcast or create an accounting entry.

## Mainnet promotion gate

Repeat every happy-path comparison and negative safety check against mainnet configuration before the first mainnet submission. Use a small amount and independently verify the nonce account, authority, source, fee payer, destination, message bytes, digest, and required signer order on both devices. Devnet success does not authorize a relaxed mainnet gate.

## Automated and artifact gates

```text
npm run typecheck
npm --workspace apps/desktop test
npm run build:shared
npm run build:desktop
npm audit --omit=dev
```

Inspect the built desktop artifacts and repository diff for provider URLs, bearer tokens, authorization headers, upstream bodies, seed phrases, mnemonics, private keys, keypairs, and fixture secrets. Confirm existing CKB, EVM Safe, Bitcoin, accounting, mobile, and Solana watch-only tests remain green.

## Explicit exclusions

Confirm there is no local signing, nonce creation, nonce authority change, nonce withdrawal, SPL token transfer, staking, NFT operation, arbitrary program instruction/data, address lookup table, WebSocket subscription, payroll batching, accounting posting, custody integration, third-party multisig selection, or claim that a durable nonce provides program-enforced M-of-N control.
