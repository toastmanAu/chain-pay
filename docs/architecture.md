# Architecture

## One-page picture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                       ChainPay Electron desktop app                          │
│  ┌──────────────────────────────────────────┐                                │
│  │  Renderer (React, sandboxed)             │                                │
│  │  ├ features/dashboard                    │                                │
│  │  ├ features/treasury (multisig setup)    │                                │
│  │  ├ features/payroll  (batch runs)        │                                │
│  │  ├ features/payments (sig collection)    │                                │
│  │  ├ lib/chains/ckb  ──┐                   │                                │
│  │  ├ lib/chains/evm  ──┼──> ChainAdapter   │                                │
│  │  ├ lib/signers/*   ──┘    interface      │                                │
│  │  └ lib/light-client/ipc.ts ──┐           │                                │
│  └────────────────────────────────────┼─────┘                                │
│                       contextBridge   │                                      │
│  ┌────────────────────────────────────┼─────────┐                            │
│  │  Main process                      ▼         │                            │
│  │  ├ light-client-host.ts  ───────►  WASM LC   │ ──► CKB mainnet p2p        │
│  │  ├ ipc handlers                     │        │     (no third-party RPC)   │
│  │  │                                  ▼        │                            │
│  │  │                          SQLite store      │                          │
│  │  │                          (userData/)       │                          │
│  └─────────────────────────────────────────────┘                            │
│                                                                              │
│  Backend bridge (Phase 4):                                                   │
│  └── lib/api/client.ts → Frappe REST → crypto_payroll app                    │
└──────────────────────────────────────────────────────────────────────────────┘

External:
  • EVM RPCs (viem) — read-only, no key custody
  • Safe Transaction Service — optional; self-coordinate mode bypasses
  • Wallet signers — JoyID, MetaMask, WalletConnect, Ledger (CKB + EVM)
  • Frappe / ERPNext — accounting & HR system of record (Phase 4)
```

## Layers and what they own

| Layer | Lives in | Owns | Never touches |
|---|---|---|---|
| Features | `apps/desktop/src/features/*` | Product UI, calls hooks/stores | Chain bytes, signing |
| Chain adapters | `apps/desktop/src/lib/chains/<chain>` | Tx construction, broadcast, status | Payroll concepts |
| Signer transports | `apps/desktop/src/lib/signers/*` | Talking to JoyID/MetaMask/Ledger/etc. | Tx construction |
| Light client host | `apps/desktop/electron/main/light-client-host.ts` | Embedded CKB node lifecycle | UI, accounting |
| Shared types | `packages/shared/src/*` | Cross-cutting domain types | Anything chain-specific |
| Frappe app | `apps/backend/apps/crypto_payroll/` | Accounting, HR, audit log, journal posting | Signing, RPC |

## Decision: embedded light client over remote RPC

**Default:** `CKB_LIGHT_CLIENT_MODE=embedded`. The Electron main process starts `ckb-light-client-js` against a SQLite store under `userData/`. Direct CKB mainnet p2p — no Infura-equivalent in our path.

**Justification:** [lite-sqlite-findings.md](../docs/light-client-integration.md) — 96–98 % disk reduction, 23 % faster cold scan, identical correctness vs RocksDB. Already production-tested in Pocket Node and ckb-light-client-lite.

**Remote RPC fallback** is config-toggled (`CKB_LIGHT_CLIENT_MODE=remote`) for development against a public node or constrained environments. Never the default.

## Decision: multisig everywhere, no key custody

The product is a **treasury coordinator**, not a wallet. Even when ChainPay holds the only copy of the multisig config, the threshold guarantees no single device can spend.

| Chain | Multisig primitive | Signer transports |
|---|---|---|
| CKB | `secp256k1_blake160_multisig_all` system script | JoyID, Ledger CKB app, ckb-cli keystore import |
| EVM | Safe contracts (v1.4.x) | MetaMask, WalletConnect v2, Ledger, Frame |

See [ckb-multisig-witness.md](./ckb-multisig-witness.md) and [security-model.md](./security-model.md).

## Decision: adapters all the way down

The original `chainPay` brief insisted on adapters. We keep them and extend the pattern:

- `ChainAdapter` — per chain, owns tx primitives.
- `SignerTransport` — per wallet kind, owns signing primitives. Same Ledger device can be a CKB signer AND an EVM signer simultaneously — these are independent transports because the protocol shapes differ.
- `FiatRampProvider` (Phase 5) — Stripe / Coinbase / Transak / Banxa behind a single interface.

## Decision: Frappe deferred to Phase 4

The original brief had Frappe as Phase 1. We defer because:

1. The light client + multisig is the architectural commitment. Validate it first.
2. Frappe install is a heavy environmental commitment (MariaDB, Redis, multiple Python services); pre-MVP iteration is faster against in-memory mocks.
3. The DocType schemas (in `apps/backend/apps/crypto_payroll/`) already encode the data contract — they don't need a running Frappe to be useful as a design document.

## Build & dist

- `electron-vite` orchestrates main, preload, and renderer with one config.
- `electron-builder` produces installers: macOS (dmg), Windows (nsis), Linux (AppImage, deb).
- `appId: io.chainpay.desktop`.
- Native modules compiled per-target during `electron-builder` postinstall.
