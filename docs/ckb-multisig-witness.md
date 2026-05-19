# CKB multisig witness layout

> Canonical reference for the `secp256k1_blake160_multisig_all` system script.
> Source: `~/ckb-wallet/research/ckb-ecosystem-locks/raw/ckb-system-scripts/c/secp256k1_blake160_multisig_all.c`

## Lock args (on-chain commitment)

```
lock.args = blake160(multisig_script)            // 20 bytes
          | [since: u64 LE]                      // optional 8 bytes for time-locked multisig
```

That's it. **20 bytes regardless of N.** A 7-of-10 treasury costs the same lock cell capacity as a 2-of-3. Discovery of the full `multisig_script` happens at spend time via the witness.

## multisig_script (revealed in witness)

```
+-------------+------------------------------------+-------+
| Field       | Description                        | Bytes |
+-------------+------------------------------------+-------+
| S           | reserved, must be zero             |     1 |
| R           | first N pubkeys that must match    |     1 |
| M           | threshold (M-of-N signatures)      |     1 |
| N           | total pubkeys                      |     1 |
| PubkeyHashN | blake160 of compressed pubkey      |    20 |
+-------------+------------------------------------+-------+
```

Total size: `4 + 20 * N` bytes.

### The `R` parameter

`R` is subtle and powerful. It means "the first R signatures in the witness must come from the first R pubkeys in `multisig_script`."

Use cases:
- **CFO veto:** `R=1, M=2, N=3` — CFO's pubkey is index 0. Any payroll requires CFO + one other.
- **Required compliance officer:** `R=1, M=3, N=5` — compliance is index 0. Three sigs, one of them must be compliance.
- **No required signer:** `R=0, M=2, N=3` — any 2 of 3 can sign.

ChainPay setup wizard exposes this as **"required signers"** (the first R) and **"any of the rest"** (the remaining N-R), with R defaulting to 0 to keep things flat.

## Witness lock (at spend time)

```
witness_lock = multisig_script | Sig1 | Sig2 | ... | SigM
```

Where each signature is 65 bytes: 64-byte compact recoverable signature + 1-byte recovery id.

**Total witness_lock size:** `(4 + 20 * N) + (65 * M)` bytes.

Examples:
- 2-of-3, R=0: `4 + 60 + 130` = 194 bytes
- 3-of-5, R=1: `4 + 100 + 195` = 299 bytes
- 5-of-9, R=2: `4 + 180 + 325` = 509 bytes

All well under the 32 KB witness max — no chunking concern for typical treasury sizes.

## Signing flow

1. **Build unsigned tx** with `@ckb-ccc/core`, treating the multisig output as a regular input.
2. **Prepare witness placeholder:** for the multisig input, set `witnessArgs.lock` to a placeholder of size `(4 + 20*N) + (65*M)`. This locks in the fee calculation.
3. **Compute sighash** per RFC-0022: hash the tx skeleton + witness sizes. This is the digest each signer signs.
4. **Distribute** the unsigned tx + sighash to co-signers (file, QR, or backend relay).
5. **Each signer** computes their 65-byte recoverable signature over the sighash using their private key (in JoyID, Ledger, etc.).
6. **Aggregate:** when M signatures arrive, replace the placeholder with `multisig_script | sigs...` in order. **Order matters** — signatures must be in the order of corresponding pubkey hashes in `multisig_script`.
7. **Broadcast** via embedded light client (Phase 1).

## Implementation notes from `~/.claude/rules/ckb-transactions.md`

These traps must be respected:

- **JoyID witness placeholder under-counts by ~560 bytes on plain transfers.** Pre-pad witness[0] in the caller before `completeFeeBy`. Signer.prepareTransaction may not survive CCC's clone path.
- **For multisig + JoyID** (a likely combination), witness-size drift scales with tx complexity. Mint listings showed +2.4 KB drift. Multisig over JoyID is untested as of 2026-04 — start with a generous `witness_lock` placeholder (e.g. 2 KB above the math) and tighten once measured.
- **Cell_deps for multisig:** include the secp256k1_data + secp256k1_blake160_multisig_all dep groups. These are in the canonical genesis cell deps; @ckb-ccc/core knows them as `system.MULTISIG_DEPS`.

## Verification before signing

Phase 2 UI **must** show the signer:

1. The full `multisig_script` (so they can verify the committed pubkey hashes).
2. The sighash they're about to sign, as a copy-paste hex string.
3. The decoded tx outputs (to address, amount, in their preferred display units).
4. The fee.

A signer who blindly approves a hash they can't read is the failure mode the security model defends against everywhere else. Don't undo it in the UI.
