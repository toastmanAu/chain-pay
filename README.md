# ChainPay

Crypto-native payroll & accounting suite. CKB and EVM multisig treasuries, embedded SQLite light client, no key custody.

## What this is

A desktop app (Electron + React) that lets an organisation run payroll from a self-custodied multisig treasury, on Nervos CKB or EVM (via Safe), without trusting a third-party RPC. The CKB light client is **embedded in the app** — no external node, no infura, no quicknode. Every confirmed payment is posted as a journal entry into an ERPNext / Frappe HR backend.

## Status

**Phase 0 — scaffold.** No dependencies installed, no features built. See [docs/mvp-roadmap.md](docs/mvp-roadmap.md) for phases.

## Stack

| Layer | Tool |
|---|---|
| Desktop shell | Electron (electron-vite) |
| Frontend | React + Vite + TypeScript |
| UI | Tailwind v4 + shadcn/ui pattern |
| State | TanStack Query + Zustand |
| Forms | React Hook Form + Zod |
| Tables / charts | TanStack Table + Recharts |
| CKB | embedded `ckb-light-client-js` (WASM) + `@ckb-ccc/core` |
| EVM | viem + wagmi + `@safe-global/protocol-kit` |
| Backend | ERPNext + Frappe HR + custom `crypto_payroll` app |
| DB (backend) | MariaDB via Frappe |

## Repo layout

```
chain-pay/
  apps/
    desktop/                Electron app (frontend + light-client host)
      electron/             main + preload processes
      src/                  React renderer
        features/           one folder per product surface
        lib/chains/         ChainAdapter implementations (ckb, evm; btc/sol stubs)
        lib/signers/        MetaMask / JoyID / Ledger / WalletConnect transports
        lib/light-client/   renderer-side bridge to embedded WASM light client
    backend/                Frappe bench (deferred to Phase 4)
      apps/crypto_payroll/  custom Frappe app skeleton
  packages/
    shared/                 cross-cutting types and schemas
  docs/                     architecture, security model, payment flow, etc.
  docker/                   Frappe compose + Dockerfile (Phase 4)
```

## Quick start (when Phase 1 begins)

```bash
npm install
npm run dev:desktop       # launches Electron with HMR
```

## Trust model — read this first

ChainPay **does not store private keys**. Treasuries are multisig:

- **CKB** — `secp256k1_blake160_multisig_all` system script. Lock args = `blake160(S|R|M|N|pubkey_hashes...)`. Co-signers sign with their own wallet (JoyID, Ledger, ckb-cli keystore).
- **EVM** — Safe (formerly Gnosis Safe) contract. Owners sign EIP-712 `SafeTx` typed messages with their own wallet (MetaMask, WalletConnect, Ledger, Frame).

MetaMask is a **signer**, not a multisig. Safe is the multisig.

The CKB light client is embedded in the Electron main process and writes a SQLite store to `app.getPath('userData')/light-client-store/`. It verifies CKB mainnet headers directly. See [docs/light-client-integration.md](docs/light-client-integration.md).

## License

GPL-3.0 (inherits from ERPNext / Frappe HR ecosystem).
