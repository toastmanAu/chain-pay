# MVP roadmap

## Snapshot

| Phase | Theme | Verification gate |
|---|---|---|
| 0 | Repo scaffold | `tree -L 4` matches `docs/architecture.md`, this file is being read |
| 1 | Embedded CKB light client | App shows live mainnet tip block with zero third-party RPC config |
| 2 | CKB multisig treasury | 2-of-3 testnet treasury can pay one address end-to-end |
| 2.5 | Payroll batch over CKB multisig | N-to-many payroll tx broadcast from a treasury |
| 3 | EVM (Safe) treasury | 2-of-3 Safe on Sepolia can pay one address; MetaMask + WalletConnect both work as signers |
| 4 | Accounting bridge | CKB complete: submitted source record + server-derived JE; EVM follows Phase 3 |
| 5+ | Adapter expansion | BTC watch-only, SOL adapter, fiat ramp providers, compliance exports |

## Phase 0 — Scaffold (done)

Repo layout, package manifests, ChainAdapter / SignerTransport interfaces, DocType JSON schemas, docs.

## Phase 1 — Embedded CKB light client

See [PHASE-1.md](../PHASE-1.md) for the next-session checklist. Highlights:

- Wire `ckb-light-client-js` into Electron main
- IPC: `start`, `stop`, `status`, `tipHeader`, `getCellsCapacity`, `getTransactions`, `sync-progress` events
- Renderer wrapper in `src/lib/light-client/ipc.ts` (TanStack Query)
- Dashboard shows tip header + sync progress

**Verification gate:** With no `CKB_REMOTE_RPC_URL` set, the dashboard shows live mainnet tip block within ~10 min of first launch (after initial sync).

## Phase 2 — CKB multisig treasury

- Multisig setup wizard: collect S/R/M/N + pubkey hashes, derive lock args, derive CKB address
- Save treasury in renderer-side Zustand store (Phase 4 persists to Frappe)
- Build CKB tx with `@ckb-ccc/core`, multisig unlocker pattern from `ckb-sdk-rust`
- Witness padding follows `~/.claude/rules/ckb-transactions.md` — pre-pad witness[0] before `completeFeeBy`
- Partial-sig collection via JSON file or QR initially
- Signer transports: JoyID redirect-relay first, then ckb-cli keystore import, then Ledger CKB

**Verification gate:** Testnet 2-of-3 treasury, propose tx, sign in JoyID twice, broadcast, confirm via embedded light client.

## Phase 2.5 — Payroll batch over CKB

- "Payroll batch" model — one tx, multiple outputs
- Payee profile model (fiat salary, CKB address)
- FX snapshot at calc time
- Approval queue + status machine: `draft → calculated → pending_approval → approved → awaiting_signature → broadcasted → confirming → confirmed`

**Verification gate:** Real testnet batch paying 3 addresses from a multisig treasury.

## Phase 3 — EVM (Safe) treasury

- ✅ Slice A: import an existing Sepolia Safe, validate its contract interface,
  and monitor live balance, owners, threshold, version, and block height
- ✅ Slice B: build and review a native-ETH SafeTx, derive its canonical EIP-712
  hash, collect one injected-wallet owner signature, and persist the approval
- ✅ Slice C: revalidate and assemble threshold signatures, execute through an
  injected owner wallet, persist the outer tx hash, and track its receipt
- ✅ Slice D: persist immutable SafeTx + outer transaction receipt evidence,
  derive one idempotent ERPNext Journal Entry server-side, and recover posting
  failures without re-executing the Safe transaction
- ✅ Slice E: WalletConnect v2 owner sessions with QR/deep-link pairing,
  restart recovery, and strict signature-only approval interchange between
  instances holding the same canonical SafeTx
- `@safe-global/protocol-kit` integration
- EIP-712 SafeTx signing
- viem + wagmi for read calls and signer transport
- Self-coordinate partial sigs by default; Safe Transaction Service as optional config
- Multi-chain support (Ethereum, Arbitrum, Optimism, Base, Polygon)

**Verification gate:** Sepolia 2-of-3 Safe; MetaMask owner signs from one app
instance, WalletConnect owner signs from another, signature files are exchanged,
and the tx executes. Automated Slice E coverage is complete; run the two-instance
smoke playbook for the live gate.

## Phase 4 — Frappe accounting bridge

- ✅ Stand up local Frappe/ERPNext via Docker Compose
- ✅ Persist confirmed CKB payment records and child lines as submitted DocTypes
- ✅ Derive Journal Entries server-side without caller-selected accounts/amounts
- ✅ Enforce immutable-record, batch-ID, and transaction-hash idempotency
- ✅ Sepolia Safe confirmed-payment ingestion with SafeTx + outer-hash
  idempotency and executor-paid gas metadata
- Compliance export: CSV/PDF with payslip + crypto + FX + tx hash + network fee
- REST endpoints wired per [api-contract.md](./api-contract.md)

**Accounting verification gate:** A confirmed testnet payment produces one persisted
source record and one balanced submitted Journal Entry; replay returns both
existing records. Automated coverage now spans CKB and Sepolia Safe sources;
run the Slice D smoke playbook for the live EVM gate.

## Phase 5+ — Adapter expansion

- BTC adapter (watch-only first, then manual broadcast)
- SOL adapter (RPC + nonce account multisig)
- Fiat ramp adapters: Stripe / Coinbase Commerce / Transak / MoonPay / Banxa
- Hardware wallet signer transport for both CKB and EVM
- MPC custody provider integration (optional, alternative to multisig for some orgs)
- Mobile companion app (signer-only) — reuse the SignerTransport interface
