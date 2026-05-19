# Security model

## Core promises

1. **ChainPay never sees or stores a private key.** Not in memory, not on disk, not in environment variables. All signing happens in external wallets owned by signers.
2. **The trust root is the multisig threshold.** Even ChainPay itself, fully compromised, cannot move funds without M signers cooperating.
3. **The CKB light client is the source of truth.** The desktop app verifies CKB mainnet headers directly — no Infura, no Etherscan, no remote indexer can lie to it about CKB state.
4. **The renderer is sandboxed.** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The only main-process surface the renderer reaches is the typed `window.ckb` bridge.
5. **No `eval`, no remote code.** CSP forbids `unsafe-eval`. All JavaScript is bundled at build time.

## Threat model

| Adversary | What they can do | What multisig + light client gives us |
|---|---|---|
| Compromised ChainPay binary | Show wrong data, fake-broadcast | Signers verify each sighash in their own wallet UI before signing. CKB light client refuses fake headers. |
| Compromised RPC provider | Lie about balances, replay txs | Embedded light client neutralises this on CKB. EVM read-only RPC risk is bounded: false balances mislead but cannot move funds (multisig sigs verify by Safe contract). |
| Compromised single signer (key theft, phishing) | Sign anything they're shown | M-of-N threshold means 1 compromise is not enough. R parameter on CKB lets you require *specific* signers always sign (e.g. CFO must approve every payroll). |
| Compromised SafeTxService (EVM) | Inject malicious tx into pending queue | Each signer's wallet shows the SafeTx hash; sighash verification by wallet detects tampering. Self-coordinate mode bypasses the service entirely. |
| Compromised partial-sig transport (file/QR) | Modify in transit | Sighash is committed to. Modified tx → mismatched sighash → other signers' sigs invalid. |
| Insider with ChainPay write access | Add malicious payee, falsify FX rate | All write actions log to `Crypto Audit Log` (Frappe). FX rate is captured per-batch with provider + timestamp; review at approval time. |

## What we explicitly do NOT defend against (yet)

- **Compromised signing device while signer is signing.** If you sign a malicious tx from a hijacked browser, multisig doesn't help — that's why we require **independent sighash verification** before signing. Phase 2 UI will surface the sighash explicitly.
- **Hardware key extraction.** Out of scope; rely on the hardware wallet's own security model.
- **Side-channel attacks on the local SQLite store.** It contains only public chain data; no value to extract.
- **Phishing of co-signers via social engineering.** Process control, not technical control.

## Per-component security checklist

### Electron shell
- [ ] `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` — set in `electron/main/index.ts`
- [ ] CSP in `index.html` blocks `unsafe-eval`
- [ ] External links open via `shell.openExternal`, never in a new BrowserWindow
- [ ] No file I/O in renderer; everything through typed IPC
- [ ] electron-builder code signing in dist pipeline (Phase 4)

### Light client (Phase 1)
- [ ] Store path under `app.getPath('userData')` (not configurable to arbitrary paths from renderer)
- [ ] Network selection (`mainnet` / `testnet`) cannot be changed without app restart
- [ ] Sync progress events serialise BigInt safely (no precision loss)

### CKB multisig (Phase 2)
- [ ] Witness placeholder padding follows `~/.claude/rules/ckb-transactions.md` § 1
- [ ] Multisig script hash double-checked: `blake160(S|R|M|N|hashes...)` must match `lock.args`
- [ ] Sighash recomputed locally before showing to signer — never trust a sighash from another peer

### EVM Safe (Phase 3)
- [ ] EIP-712 typed data uses the canonical SafeTx domain separator
- [ ] Safe nonce fetched from chain at propose-time, not cached
- [ ] When using SafeTxService, verify the returned tx hash matches locally-computed hash before showing to signer

### Frappe backend (Phase 4)
- [ ] No DocType field ever holds a private key, mnemonic, or signing seed
- [ ] REST endpoints validate signature payloads structurally; signatures are verified by chain contracts/scripts, not by Frappe
- [ ] Audit log immutable — no delete permission on `Crypto Audit Log` for any role

## Security review triggers

Per `~/.claude/rules/code-review.md`, **stop and use the security-reviewer agent when:**
- Any code touches a key store (must verify it's external)
- Any code constructs a tx
- Any code parses chain data into displayed money values (FX path, decimals path)
- Any code handles partial-sig import/export (transport tampering surface)
- Any IPC handler is added to the Electron main process
