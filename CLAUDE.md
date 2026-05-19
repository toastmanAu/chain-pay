# ChainPay — Claude guidance

## What this project is

Crypto-native payroll/accounting suite. **CKB L1 multisig + EVM multisig (Safe)** treasuries, **embedded SQLite light client** for CKB self-custody, no private key custody anywhere. Electron + React + Vite frontend. Frappe / ERPNext backend (Phase 4).

## Hard rules

1. **Never custody private keys.** All signing happens in external wallets (JoyID, Ledger, MetaMask, WalletConnect). ChainPay coordinates partial signatures only.
2. **Light client first.** When tempted to call a third-party CKB RPC, stop. Use the embedded light client. Remote RPC is a fallback config flag, not the default.
3. **Adapters stay adapters.** Don't bake CKB or EVM logic into payroll/treasury/accounting code. The `ChainAdapter` interface in `apps/desktop/src/lib/chains/types.ts` is the only seam.
4. **Multisig is the trust root.** MetaMask is a signer transport, not a treasury. Safe is the EVM treasury. `secp256k1_blake160_multisig_all` is the CKB treasury. Don't conflate.
5. **Every confirmed payment posts a journal entry.** Salary expense debit, treasury asset credit, network fee expense, FX gain/loss. Phase 4 wires this up; Phase 2 already needs the data shape correct.

## CKB-specific guidance

Phill's CKB transaction rule: `~/.claude/rules/ckb-transactions.md` — read this before touching anything that builds a CKB transaction. Particular traps:

- JoyID witness placeholder under-counts by ~560 bytes on plain transfers, ~2.4 KB on mints. Pad witness[0] in the **caller** before `completeFeeBy`; signer.prepareTransaction is unreliable across CCC's clone path.
- Multisig witness lock layout is `multisig_script | Sig1 | Sig2 | ...` where `multisig_script = S(1)|R(1)|M(1)|N(1)|pubkey_hashes`. Lock args = `blake160(multisig_script)` ± 8 bytes since.
- Use `@ckb-ccc/core` for tx construction; mirror `SecpMultisigUnlocker` pattern from ckb-sdk-rust for the signing entries.

## EVM-specific guidance

- Safe contracts are deployed at the same address across all EVM chains via singleton deployer — chainId determines which one to call, not which contract to use.
- EIP-712 `SafeTx` typed message structure is canonical; don't invent your own. Use `@safe-global/protocol-kit`.
- MetaMask = injected EIP-1193 provider. WalletConnect = QR-based EIP-1193 provider. Ledger = USB/HID EIP-1193 provider via `@ledgerhq/hw-app-eth`. All are peers at the `SignerTransport` layer.

## File organisation rules

- One feature per `src/features/<name>/` folder. No shared "components" dumping ground.
- Chain code lives in `src/lib/chains/<chain>/`. Never in features.
- Signer transports in `src/lib/signers/`. Never in features.
- Light-client lifecycle lives in `electron/main/light-client-host.ts`. Renderer talks to it only via the typed IPC bridge in `src/lib/light-client/ipc.ts`.
- Shared types in `packages/shared/src/`. If a type is used in both desktop and backend, it belongs there.

## What's done in Phase 0

Repo scaffold only. No dependencies installed, no real implementations. Every "adapter" / "feature" file has a TODO marker. Phase 1 = wire the embedded light client.

## Conventions inherited from `~/.claude/rules/`

- Immutability — never mutate, always return new objects.
- Files <800 lines; functions <50 lines; nesting depth ≤4.
- TDD on Phase 2+ (treasury / multisig / payment logic must have tests before merge).
- Code review before commit; security review before any signing or tx-construction code lands.
