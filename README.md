# ChainPay

Crypto-native payroll & accounting suite. CKB and EVM multisig treasuries, **embedded WASM CKB light client** in the desktop app, no private key custody.

> [!NOTE]
> Phase 1 (embedded CKB light client) is **shipped and verified live on mainnet**. Phase 2 (CKB multisig treasury) is in progress. See [Status](#status).

## Why ChainPay exists

Existing crypto payroll tools fall into one of two buckets:

1. **Custodial SaaS** — your payroll provider holds the keys. Convenient, defeats the entire point of crypto.
2. **Hand-rolled multisig + spreadsheets** — non-custodial but no payroll workflow, no journal entries, no compliance exports.

ChainPay aims to be the middle ground: a desktop app that lets a small org run payroll from a self-custodied multisig treasury, post every confirmed payment as a journal entry into ERPNext / Frappe HR, and ship compliance exports — without ever holding a private key and without trusting an Infura-style RPC provider.

The trust-minimisation half is the differentiator. The CKB light client is **embedded directly inside the desktop app** as a WASM bundle and verifies mainnet headers itself. There is no `wss://my-favourite-rpc-provider.com` in the loop. See [docs/light-client-integration.md](docs/light-client-integration.md) for the full architecture.

## Design pillars (these constrain every decision)

1. **No key custody, ever.** All signing happens in external wallets (JoyID, Ledger, MetaMask, WalletConnect, ckb-cli keystore). ChainPay coordinates partial signatures only.
2. **Light client first.** Tempted to call a third-party RPC? Stop. Use the embedded light client. Remote RPC is a fallback config flag, not the default.
3. **Multisig is the trust root.** MetaMask is a signer *transport*, not a treasury. Safe is the EVM treasury. `secp256k1_blake160_multisig_all` is the CKB treasury.
4. **Adapters stay adapters.** All chain code lives behind the `ChainAdapter` / `SignerTransport` interfaces. Payroll, treasury, and accounting logic must never know whether a chain is CKB or EVM.
5. **Every confirmed payment posts a journal entry.** Salary expense debit, treasury asset credit, network fee expense, FX gain/loss. Bookkeepers should never have to reconcile a chain explorer.

## Status

| Phase | Theme | State |
|---|---|---|
| 0 | Repo scaffold | ✅ done |
| 1 | Embedded CKB light client (renderer-owned, WASM, browser-storage) | ✅ done — verified live on mainnet, peers attach within ~30 s |
| 2 | CKB multisig treasury (setup wizard, address derivation, tx builder + JoyID signer) | 🚧 in progress — encoding primitives + address derivation + wizard shipped; tx builder next |
| 2.5 | Payroll batch over CKB multisig | planned |
| 3 | EVM (Safe) treasury — MetaMask + WalletConnect signers | planned |
| 4 | Frappe accounting bridge | planned |
| 5+ | BTC/SOL adapters, fiat ramps, mobile signer companion | planned |

Detailed roadmap: [docs/mvp-roadmap.md](docs/mvp-roadmap.md). Phase-specific notes: [PHASE-1.md](PHASE-1.md).

## Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  Electron main                                              │
│  ├── BrowserWindow (COOP/COEP + CSP headers, DevTools)      │
│  └── stdout mirror for renderer console                     │
└─────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│  Electron renderer (React + Vite)                           │
│                                                             │
│  features/         dashboard, treasury, payroll, payments…  │
│       │            (UI, never touches chain primitives)     │
│       │                                                     │
│  lib/chains/       ChainAdapter — ckb, evm; btc/sol stubs   │
│       │                                                     │
│  lib/signers/      SignerTransport — JoyID, MetaMask, etc.  │
│       │                                                     │
│  lib/light-client/ ╔══════════════════════════════════════╗ │
│                    ║  @nervosnetwork/ckb-light-client-js  ║ │
│                    ║  ├── lightclient.worker (sync+RPC)   ║ │
│                    ║  └── db.worker (OPFS/IndexedDB)      ║ │
│                    ╚══════════════════════════════════════╝ │
└─────────────────────────────────────────────────────────────┘

Phase 4: ────────────────► HTTP ────────────────►
                           Frappe + ERPNext + crypto_payroll
                           (journal entries, payslips, exports)
```

### Why the light client runs in the **renderer**, not Electron main

The original plan had it in main with an IPC bridge. The reversal was forced: `@nervosnetwork/ckb-light-client-js` requires Web Workers, `SharedArrayBuffer`, and a browser storage backend (the bundled `ckb-light-client-db-worker` writes to OPFS / IndexedDB). Electron main is Node.js — none of those exist there.

Trade-off accepted: no caller-controlled store path. Electron's per-app IndexedDB partition gives equivalent isolation to a file under `userData/`.

### Five runtime ceremonies needed to make the WASM light client run

None of these are obvious from the package's README alone. All are documented in [docs/light-client-integration.md](docs/light-client-integration.md):

1. **COOP/COEP response headers** (`SharedArrayBuffer` requirement).
2. **CSP allowing `blob:` workers + `'wasm-unsafe-eval'`** — strict `script-src 'self'` silently refuses every worker; the client appears to "start then stop" with no error message.
3. **Preload bundle must be CJS** — `sandbox: true` in BrowserWindow forbids ESM preload.
4. **Custom TOML config is mandatory** — the WASM defaults only ship IP-only bootnodes on port 8114; browsers can't open WSS to a raw IP. Use the canonical `*.ckb.guide:443` WSS bootnode list.
5. **A stub `[rpc]` block is required in the TOML** — the embedded Rust serde deserializer fails with `missing field 'rpc'` even though the WASM build never binds an RPC port.

If you're porting this WASM bundle into any other Electron / Tauri / browser app, save yourself the day of debugging and skim the doc first.

## Tech stack

| Layer | Tool |
|---|---|
| Desktop shell | Electron 33 (electron-vite) |
| Frontend | React 19 + Vite 5 + TypeScript |
| UI | Tailwind v4 |
| State | TanStack Query + Zustand |
| Forms | (useState today; React Hook Form + Zod once forms get complex) |
| Tables / charts | TanStack Table + Recharts |
| Tests | Vitest + @vitest/coverage-v8 |
| CKB | embedded `@nervosnetwork/ckb-light-client-js` (WASM) + `@ckb-ccc/core` for tx construction |
| EVM | viem + wagmi + `@safe-global/protocol-kit` (planned, Phase 3) |
| Backend | ERPNext + Frappe HR + custom `crypto_payroll` app (planned, Phase 4) |
| DB (backend) | MariaDB via Frappe (planned, Phase 4) |

## External dependencies that materially shape the architecture

These are not just dependencies — they constrain how ChainPay is built. Anything else is replaceable; these aren't.

### `@nervosnetwork/ckb-light-client-js` (v0.5.5+)

The reason ChainPay can offer self-custody read access. CKB is the only chain in our adapter set with both a WASM-portable light client and a small enough storage footprint to ship in a desktop app. There is no equivalent for EVM (Helios is close but not production-stable), no equivalent for BTC at WASM-embeddable scale, and Solana fundamentally requires a full node for trust-minimised access.

This asymmetry — CKB gets first-class self-custody, EVM gets best-effort RPC — is the product's strongest differentiator and worth more than the "all chains equal" optical wins.

Underlying Rust crate: [`ckb-light-client`](https://github.com/nervosnetwork/ckb-light-client). Storage-backend benchmark that informed the JS bundle's footprint: see `~/ckb-wallet/research/ckb-light-client/raw/lite-sqlite-findings.md` (RocksDB 132 MB vs SQLite 2.4–5.8 MB at parity correctness).

### `@ckb-ccc/core` (v1.12+)

The CKB transaction-construction layer. Used for `Script`/`Address` encoding, multisig-script byte assembly, fee estimation, witness handling, and (later) the tx-builder + completer pipeline. Picked over Lumos because CCC's async-iterator + ScriptInfo model fits the embedded-light-client query pattern much better than Lumos's indexer-centric flow.

ChainPay's multisig encoding (in `apps/desktop/src/lib/chains/ckb/multisig.ts`) is implemented **from spec** rather than reaching for a CCC helper because CCC core doesn't ship a multisig builder — only the `Secp256k1Multisig` `KnownScript` constants for address derivation.

### `@safe-global/protocol-kit` + `@safe-global/api-kit` (Phase 3)

Safe (formerly Gnosis Safe) is the EVM treasury. Its contracts are deployed at the same address across every EVM chain via singleton deployer, so `chainId` determines which network to call, not which contract to use. EIP-712 `SafeTx` typed messages are the canonical signing format; not inventing our own.

### `viem` + `wagmi` (Phase 3)

EVM read calls and signer transport. viem for low-level calls, wagmi for the React hook layer over EIP-1193 providers (MetaMask, WalletConnect, Ledger). Drops `web3.js` and `ethers.js` entirely from the dependency tree.

### Frappe HR + ERPNext (Phase 4)

The accounting backend. Custom `crypto_payroll` app sits inside the Frappe bench at `apps/backend/`. Frappe HR provides payee/employee models, payroll cycles, and payslip generation; ERPNext provides the double-entry GL into which our `accounting_bridge.py` posts journal entries. License compatibility is why this whole repo is GPL-3.0.

### Electron + `electron-vite`

The desktop runtime. electron-vite picked over `electron-builder + webpack` for Vite-native HMR and simpler config. Phase 1 has us running the WASM light client in the renderer with sandbox + contextIsolation enabled; the only main-process responsibility is window lifecycle + CSP/COOP/COEP headers + DevTools.

## Forks and vendored code

**None currently.** Every dependency is consumed from upstream npm with no patches.

The policy when this changes:

- Anything we fork lives under `vendor/<package>/` at the repo root with a top-level `VENDORING.md` recording: upstream version, patch summary, why we couldn't upstream, and a re-evaluation date.
- Cherry-picks via `patch-package` are preferred over vendoring when possible; the patch lives in `patches/` and gets a one-paragraph note in `patches/README.md`.
- If we vendor or patch `@nervosnetwork/ckb-light-client-js` (e.g. to land Phill's pending SQLite-backend PRs), the patch must be reproducible from upstream Git history. No "lost source" patches.

Known candidates for future patching:

- `@nervosnetwork/ckb-light-client-js` — two upstream-pending PRs (WITHOUT-ROWID + multi-block tx batching) speed up the native backend. They don't currently affect the WASM build. Re-evaluate if the WASM `db-worker` adopts equivalent changes.

## Repo layout

```
chain-pay/
├── apps/
│   ├── desktop/                Electron app
│   │   ├── electron/           main + preload processes
│   │   ├── src/
│   │   │   ├── App.tsx         App-level light-client auto-start
│   │   │   ├── features/       one folder per product surface
│   │   │   │   ├── dashboard/  tip block, peer count, sync status
│   │   │   │   ├── treasury/   list, setup wizard, detail (WIP)
│   │   │   │   ├── payroll/    (Phase 2.5)
│   │   │   │   ├── payments/   (Phase 2)
│   │   │   │   ├── employees/  (Phase 4 with Frappe)
│   │   │   │   └── settings/
│   │   │   ├── lib/
│   │   │   │   ├── chains/     ChainAdapter — ckb, evm; btc/sol stubs
│   │   │   │   │   ├── ckb/    multisig.ts, address.ts, adapter.ts
│   │   │   │   │   └── evm/    safe.ts, adapter.ts
│   │   │   │   ├── signers/    SignerTransport — JoyID, MetaMask, etc.
│   │   │   │   └── light-client/  renderer-side WASM host
│   │   │   ├── stores/         Zustand stores (sync, treasury)
│   │   │   └── components/     layout primitives
│   │   ├── electron.vite.config.ts
│   │   └── vitest.config.ts
│   └── backend/                Frappe bench (Phase 4)
│       └── apps/crypto_payroll/  custom Frappe app skeleton
├── packages/
│   └── shared/                 cross-cutting types and schemas
├── docs/                       architecture, security, payment flow
│   ├── architecture.md
│   ├── light-client-integration.md
│   ├── ckb-multisig-witness.md
│   ├── crypto-payment-flow.md
│   ├── accounting-model.md
│   ├── api-contract.md
│   ├── security-model.md
│   └── mvp-roadmap.md
├── docker/                     Frappe compose + Dockerfile (Phase 4)
├── PHASE-1.md                  current/recent phase deep-dive
├── CLAUDE.md                   AI assistant ground rules
└── README.md
```

## Quick start

```bash
# clone, install
git clone https://github.com/toastmanAu/chain-pay.git
cd chain-pay
npm install

# launch the desktop app with HMR
npm run dev:desktop

# run tests
npm test --workspaces --if-present

# typecheck across all workspaces
npm run typecheck
```

What to expect on first launch:

1. Window opens, Dashboard route.
2. Sidebar bottom: "CKB light client: starting" → "connecting" → "running".
3. "CKB tip block" tile fills with live mainnet height (~16M+) within ~30 s of bootnode contact.
4. Peer count > 0.

If the sidebar sits at "connecting" past a minute, DevTools console (auto-opens in dev) will tell you why — most likely a CSP / WSS / config issue documented in [docs/light-client-integration.md](docs/light-client-integration.md).

## Trust model

ChainPay **does not store private keys**. Treasuries are multisig:

- **CKB** — `secp256k1_blake160_multisig_all` system script (V1). Lock args = `blake160(S|R|M|N|pubkey_hashes...)` optionally `|| since(8)` for time-locked spends. Co-signers sign with their own wallet (JoyID, Ledger, ckb-cli keystore). See [docs/ckb-multisig-witness.md](docs/ckb-multisig-witness.md).
- **EVM** — Safe v1.4 contract. Owners sign EIP-712 `SafeTx` typed messages with their own wallet (MetaMask, WalletConnect, Ledger, Frame). Phase 3.

MetaMask is a **signer transport**, not a treasury. Safe is the multisig.

ChainPay v0.x specifically uses **`Secp256k1Multisig` V1** (`code_hash 0x5c5069eb...634e2a8`, `hashType "type"`) rather than V2 (`data1`), because every existing CKB signer wallet — JoyID, Ledger, ckb-cli, Neuron — already knows how to construct V1 witnesses. V2 is technically nicer (immutable code) but our co-signers' wallets would silently fail to sign.

Security model details: [docs/security-model.md](docs/security-model.md).

## Tested

```
Test Files  2 passed (2)
     Tests  23 passed (23)
  Coverage  98% statements, 100% functions, 86% branches
            (multisig encoding + address derivation)
```

UI components are not unit-tested yet; the encoding/decoding layer is the trust-critical surface and that's where coverage matters most. UI testing comes after Phase 2 ships and the surface stabilises.

## License

GPL-3.0-or-later — inherited from the ERPNext / Frappe HR ecosystem. ChainPay is intended to be modified and deployed by the orgs that use it; copyleft fits.

## Acknowledgements

- The Nervos / CKB team for the only WASM-portable light client in the ecosystem.
- The CCC team for a TypeScript SDK that doesn't fight you.
- The Safe team for making EVM multisig boring and predictable.
- Frappe / ERPNext for being a serious open-source ERP that crypto-native orgs can actually adopt.
