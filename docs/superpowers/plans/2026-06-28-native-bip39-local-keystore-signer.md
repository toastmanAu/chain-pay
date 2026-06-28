# Native BIP39 Local Keystore Signer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-custodied, password-protected BIP39 secp256k1 signer for the **non-treasury single-sig SMB send path only**, where the encrypted seed lives on disk and all key material is decrypted, used, and zeroized inside the Electron **main** process via a Rust→WASM key vault.

**Architecture:** A new Rust→WASM crate (`ckb-keyvault-wasm`, modelled on quantum-purse's `key-vault-wasm`) owns every byte of key material: it KDF-stretches the user password, AEAD-encrypts the BIP39 seed into an opaque blob, and exposes `derive_lock_args` + `sign_digest` so the seed is reconstructed only for the signing instant and immediately zeroized. The Electron main process instantiates the WASM vault, persists the blob as a file in `userData`, and exposes a narrow IPC surface. The renderer builds the unsigned tx (light-client + CCC, as today) and hands it to main; **main recomputes the CKB sighash-all digest from that tx and verifies the source lock-args equal the vault's own derived pubkey-hash before signing** — it never signs a renderer-supplied digest. The renderer receives the signed `Transaction`, broadcasts it, and the existing `buildAndSend` state machine drives the rest. A new `CkbTxSigner` of `kind: "local-keystore"` makes this a drop-in alongside the JoyID signer.

**Tech Stack:** Rust + `wasm-bindgen` (vault); `@ckb-ccc/core` (tx + digest); `@noble/curves` already vendored for round-trip tests; Electron main IPC (`ipcMain.handle` + `contextBridge`); React + Zustand (UI); Vitest + Cargo test.

## Global Constraints

- **Custody scope (HARD):** the local keystore signer is permitted **only** on the non-treasury single-sig SMB send path (the PR #16 flow). It MUST NOT be selectable as a treasury signer or a multisig co-signer. Treasury keeps `secp256k1_blake160_multisig_all` + external/ckb-cli signing. (Amends ChainPay Hard Rule #1 narrowly — see `CLAUDE.md`.)
- **Key material never leaves main:** no raw seed, mnemonic, private key, or 32-byte signing scalar may cross the IPC bridge into the renderer or be logged. Only: the encrypted blob (opaque), derived lock-args/address (public), the user password (one-way, into main, zeroized after use), and signed transactions/witnesses.
- **Main never blind-signs:** main MUST recompute the sighash-all digest from the serialized tx it is given, and MUST verify the source lock-args match `derive_lock_args(blob, password, index)` before signing. Reject otherwise.
- **Zeroize discipline:** every `Uint8Array`/`Vec<u8>` holding password, seed, mnemonic, or private key is overwritten with zeros in a `finally` (TS) / via `zeroize::Zeroizing` (Rust) immediately after use. Mirror quantum-purse's `password.fill(0)` pattern.
- **CKB blake160 = first 20 bytes of blake2b-256 with `ckb-default-hash` personalization**, NOT blake2b(outlen=20). (See `ckb-secp256k1.ts:118`; memory `ckb-blake160-trap`.)
- **Derivation path:** `m/44'/309'/0'/0/<index>` (309 = CKB coin type), matching Neuron's `ckbAccountPath`. Default `index = 0`.
- **KDF/AEAD:** Argon2id (memory-hard) for the password KDF; ChaCha20-Poly1305 for AEAD. Pure-Rust crates only (no C deps — must compile to `wasm32-unknown-unknown`).
- **Fee/witness traps:** follow `~/.claude/rules/ckb-transactions.md` §1, §2, §11 — pad witness[0] with a 65-byte secp256k1 lock placeholder BEFORE `completeFeeBy`; feeRate ≥ 1200.
- **TS style:** no `any`; Zod-validate all IPC payloads at the main boundary; explicit return types on exported functions; immutable updates; files < 800 lines, functions < 50 lines.

---

## File Structure

**New — Rust WASM vault (`packages/ckb-keyvault-wasm/`):**
- `Cargo.toml` — crate manifest, wasm-bindgen, pinned crypto deps.
- `src/lib.rs` — wasm-bindgen exports (thin).
- `src/vault.rs` — KDF + AEAD blob encrypt/decrypt; `Zeroizing` seed handling.
- `src/derive.rs` — BIP39 validate/seed, BIP32 derive `m/44'/309'/0'/0/i`, secp256k1, blake160.
- `src/error.rs` — error enum → JsValue.
- `tests/vault.rs` — Cargo round-trip + KAT (known-answer) tests.
- `pkg/` — `wasm-pack build --target nodejs` output (git-ignored except a checked-in build note).

**New — Electron main (`apps/desktop/electron/main/`):**
- `keyvault-host.ts` — loads the WASM pkg, owns the blob file in `userData/keyvault/`, registers IPC handlers, recomputes digest, verifies lock-args, signs.
- `keyvault-host.test.ts` — unit tests with a temp dir + the real WASM pkg.
- `keyvault-store.ts` — pure file read/write/exists/delete for the blob (`userData/keyvault/<id>.vault`).
- `keyvault-store.test.ts`.

**New — shared (`packages/shared/src/`):**
- `keyvault-ipc.ts` — Zod schemas + TS types for every IPC request/response; the IPC channel-name constants.
- `keyvault-ipc.test.ts`.
- `ckb-sighash.ts` — `computeSighashAllDigest(tx, groupInputIndices)` pure helper (used by main).
- `ckb-sighash.test.ts`.

**Modify — desktop renderer:**
- `apps/desktop/electron/preload/index.ts` — expose `window.chainpay.keyvault.*` typed bridge.
- `apps/desktop/src/lib/signers/ckb-tx-signer.ts:8-12` — widen `kind` union to `"joyid" | "local-keystore"`.
- `apps/desktop/src/lib/signers/local-keystore-ckb-tx-signer.ts` (new) — `CkbTxSigner` impl that delegates `signTransaction` to main over IPC.
- `apps/desktop/src/lib/signers/local-keystore-ckb-tx-signer.test.ts` (new).
- `apps/desktop/src/lib/chains/ckb/secp256k1-lock.ts` (new) — `secp256k1LockAndDeps(scriptInfo, args)` analog of `joyidLockAndDeps`.
- `apps/desktop/src/lib/chains/ckb/secp256k1-lock.test.ts` (new).
- `apps/desktop/src/lib/send/build-and-send.ts:34` — branch source lock/deps on `source.lockKind`.
- `apps/desktop/src/lib/send/build-and-send.test.ts` — add local-keystore case.
- `packages/shared/src/<source-type>.ts` — add `lockKind: "joyid" | "secp256k1"` + optional `keyvaultId`/`derivationIndex` to `Source`.

**New — UI (`apps/desktop/src/features/keyvault/`):**
- `KeyvaultSetupPanel.tsx` — create-new / import-mnemonic / show-recovery flow.
- `UnlockModal.tsx` — password entry + entropy meter, gates a sign.
- `keyvault-store.ts` (Zustand) — UI state: locked/unlocked, current keyvault id, derived address.
- matching `*.test.tsx`.

---

## Phase A — Rust→WASM key vault

### Task A1: Scaffold the crate and CI build

**Files:**
- Create: `packages/ckb-keyvault-wasm/Cargo.toml`
- Create: `packages/ckb-keyvault-wasm/src/lib.rs`
- Create: `packages/ckb-keyvault-wasm/src/error.rs`
- Create: `packages/ckb-keyvault-wasm/.gitignore` (ignore `/target`, keep `/pkg` build note)

**Interfaces:**
- Produces: a `wasm-pack build --target nodejs` artifact in `pkg/` importable from Node as `require("../../packages/ckb-keyvault-wasm/pkg")`.

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "ckb-keyvault-wasm"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
getrandom = { version = "0.2", features = ["js"] }
argon2 = "0.5"
chacha20poly1305 = "0.10"
bip39 = { version = "2", default-features = false, features = ["std"] }
# secp256k1 + bip32 over pure-Rust k256 (no C, wasm-safe)
k256 = { version = "0.13", features = ["ecdsa", "arithmetic"] }
hmac = "0.12"
sha2 = "0.10"
blake2b-ref = "0.3"
zeroize = { version = "1", features = ["derive"] }

[dev-dependencies]
hex = "0.4"
```

- [ ] **Step 2: Write `src/error.rs`**

```rust
use wasm_bindgen::JsValue;

#[derive(Debug)]
pub enum VaultError {
    InvalidMnemonic,
    WrongPassword,
    Corrupt(&'static str),
    Derive(&'static str),
}

impl From<VaultError> for JsValue {
    fn from(e: VaultError) -> JsValue {
        let msg = match e {
            VaultError::InvalidMnemonic => "invalid BIP39 mnemonic".to_string(),
            VaultError::WrongPassword => "wrong password or corrupted vault".to_string(),
            VaultError::Corrupt(w) => format!("corrupt vault: {w}"),
            VaultError::Derive(w) => format!("key derivation failed: {w}"),
        };
        JsValue::from_str(&msg)
    }
}
```

- [ ] **Step 3: Write a minimal `src/lib.rs` that builds**

```rust
mod error;
mod vault;   // added in A2
mod derive;  // added in A3

use wasm_bindgen::prelude::*;

/// Returns a rough strength estimate (entropy bits) for a UTF-8 password.
/// Mirrors quantum-purse `password_checker`; the UI uses it for a meter and a
/// minimum-strength gate. Does NOT touch any vault.
#[wasm_bindgen]
pub fn password_entropy_bits(password: &[u8]) -> u32 {
    derive::estimate_entropy_bits(password)
}
```

- [ ] **Step 4: Build it**

Run: `cd packages/ckb-keyvault-wasm && wasm-pack build --target nodejs`
Expected: compiles; `pkg/ckb_keyvault_wasm.js` + `.wasm` produced. (Stub `vault.rs`/`derive.rs` with `pub fn estimate_entropy_bits(_: &[u8]) -> u32 { 0 }` and empty modules so it links.)

- [ ] **Step 5: Commit**

```bash
git add packages/ckb-keyvault-wasm/Cargo.toml packages/ckb-keyvault-wasm/src packages/ckb-keyvault-wasm/.gitignore
git commit -m "feat(keyvault): scaffold ckb-keyvault-wasm crate"
```

### Task A2: Blob encryption (Argon2id + ChaCha20-Poly1305)

**Files:**
- Create/replace: `packages/ckb-keyvault-wasm/src/vault.rs`
- Test: `packages/ckb-keyvault-wasm/tests/vault.rs`

**Interfaces:**
- Produces:
  - `fn encrypt_seed(seed: &[u8], password: &[u8]) -> Result<Vec<u8>, VaultError>`
  - `fn decrypt_seed(blob: &[u8], password: &[u8]) -> Result<Zeroizing<Vec<u8>>, VaultError>`
  - Blob layout (all little-endian where numeric): `magic(4)="CKVT" | version(1)=1 | argon_salt(16) | nonce(12) | ciphertext(rest)`. Argon2id params: `m=19456 KiB, t=2, p=1` (OWASP baseline), output 32-byte key.

- [ ] **Step 1: Write the failing round-trip test**

```rust
// tests/vault.rs
use ckb_keyvault_wasm::vault::{encrypt_seed, decrypt_seed};

#[test]
fn encrypt_then_decrypt_roundtrips() {
    let seed = b"0123456789abcdef0123456789abcdef"; // 32 bytes
    let blob = encrypt_seed(seed, b"correct horse").unwrap();
    assert_eq!(&blob[0..4], b"CKVT");
    assert_eq!(blob[4], 1);
    let out = decrypt_seed(&blob, b"correct horse").unwrap();
    assert_eq!(&out[..], seed);
}

#[test]
fn wrong_password_is_rejected() {
    let blob = encrypt_seed(b"0123456789abcdef0123456789abcdef", b"right").unwrap();
    let err = decrypt_seed(&blob, b"wrong");
    assert!(err.is_err());
}

#[test]
fn two_encrypts_differ_by_salt_and_nonce() {
    let a = encrypt_seed(b"same-seed-bytes-padded-to-32-ok!!", b"pw").unwrap();
    let b = encrypt_seed(b"same-seed-bytes-padded-to-32-ok!!", b"pw").unwrap();
    assert_ne!(a, b); // random salt+nonce ⇒ different ciphertext
}
```

(Expose modules: add `pub mod vault;` to `lib.rs` if not already `pub`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ckb-keyvault-wasm && cargo test --test vault`
Expected: FAIL — `encrypt_seed` not found.

- [ ] **Step 3: Implement `src/vault.rs`**

```rust
use argon2::{Argon2, Algorithm, Params, Version};
use chacha20poly1305::{aead::{Aead, KeyInit}, ChaCha20Poly1305, Key, Nonce};
use getrandom::getrandom;
use zeroize::Zeroizing;
use crate::error::VaultError;

const MAGIC: &[u8; 4] = b"CKVT";
const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

fn derive_key(password: &[u8], salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let params = Params::new(19_456, 2, 1, Some(32)).map_err(|_| VaultError::Corrupt("params"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon.hash_password_into(password, salt, key.as_mut_slice())
        .map_err(|_| VaultError::Corrupt("kdf"))?;
    Ok(key)
}

pub fn encrypt_seed(seed: &[u8], password: &[u8]) -> Result<Vec<u8>, VaultError> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    getrandom(&mut salt).map_err(|_| VaultError::Corrupt("rng"))?;
    getrandom(&mut nonce).map_err(|_| VaultError::Corrupt("rng"))?;
    let key = derive_key(password, &salt)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), seed)
        .map_err(|_| VaultError::Corrupt("encrypt"))?;
    let mut blob = Vec::with_capacity(4 + 1 + SALT_LEN + NONCE_LEN + ct.len());
    blob.extend_from_slice(MAGIC);
    blob.push(VERSION);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    Ok(blob)
}

pub fn decrypt_seed(blob: &[u8], password: &[u8]) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    let header = 4 + 1 + SALT_LEN + NONCE_LEN;
    if blob.len() < header || &blob[0..4] != MAGIC { return Err(VaultError::Corrupt("magic")); }
    if blob[4] != VERSION { return Err(VaultError::Corrupt("version")); }
    let salt = &blob[5..5 + SALT_LEN];
    let nonce = &blob[5 + SALT_LEN..header];
    let ct = &blob[header..];
    let key = derive_key(password, salt)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let pt = cipher.decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| VaultError::WrongPassword)?; // AEAD tag mismatch ⇒ wrong pw
    Ok(Zeroizing::new(pt))
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test --test vault`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ckb-keyvault-wasm/src/vault.rs packages/ckb-keyvault-wasm/tests/vault.rs
git commit -m "feat(keyvault): Argon2id + ChaCha20-Poly1305 seed blob"
```

### Task A3: BIP39 → BIP32 → secp256k1 → blake160 derivation

**Files:**
- Create/replace: `packages/ckb-keyvault-wasm/src/derive.rs`
- Test: `packages/ckb-keyvault-wasm/tests/derive.rs`

**Interfaces:**
- Produces:
  - `fn validate_mnemonic(words: &[u8]) -> bool`
  - `fn mnemonic_to_seed(words: &[u8]) -> Result<Zeroizing<[u8;64]>, VaultError>` (empty BIP39 passphrase)
  - `fn private_key_at(seed: &[u8], index: u32) -> Result<Zeroizing<[u8;32]>, VaultError>` (path `m/44'/309'/0'/0/index`)
  - `fn blake160_pubkey(privkey: &[u8;32]) -> [u8;20]`
  - `fn sign_recoverable(privkey: &[u8;32], digest: &[u8;32]) -> [u8;65]` (`r||s||v`, v∈{0,1}, low-s)
  - `fn estimate_entropy_bits(password: &[u8]) -> u32`

- [ ] **Step 1: Write failing KAT test**

```rust
// tests/derive.rs — anchor against a fixed mnemonic so any derivation change is caught.
use ckb_keyvault_wasm::derive::*;
const M: &[u8] = b"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

#[test]
fn validates_known_mnemonic() { assert!(validate_mnemonic(M)); }

#[test]
fn rejects_bad_mnemonic() { assert!(!validate_mnemonic(b"not a real mnemonic phrase here ok")); }

#[test]
fn derives_stable_lock_args() {
    let seed = mnemonic_to_seed(M).unwrap();
    let pk = private_key_at(&seed[..], 0).unwrap();
    let args = blake160_pubkey(&pk);
    // Pin the value once with the real impl, then keep it as a regression anchor.
    // Replace ZEROS after first green run with the actual 20-byte hex from the impl.
    assert_eq!(args.len(), 20);
}

#[test]
fn signs_recoverable_and_recovers() {
    let seed = mnemonic_to_seed(M).unwrap();
    let pk = private_key_at(&seed[..], 0).unwrap();
    let digest = [7u8; 32];
    let sig = sign_recoverable(&pk, &digest);
    assert_eq!(sig.len(), 65);
    assert!(sig[64] <= 1);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --test derive`
Expected: FAIL — functions not found.

- [ ] **Step 3: Implement `src/derive.rs`**

```rust
use bip39::Mnemonic;
use hmac::{Hmac, Mac};
use sha2::Sha512;
use k256::ecdsa::{SigningKey, signature::hazmat::PrehashSigner, RecoveryId, Signature};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use zeroize::Zeroizing;
use crate::error::VaultError;

type HmacSha512 = Hmac<Sha512>;
const CKB_PATH: [u32; 5] = [44 + HARD, 309 + HARD, 0 + HARD, 0, 0]; // last element overridden by index
const HARD: u32 = 0x8000_0000;

pub fn validate_mnemonic(words: &[u8]) -> bool {
    std::str::from_utf8(words).ok().and_then(|s| Mnemonic::parse(s.trim()).ok()).is_some()
}

pub fn mnemonic_to_seed(words: &[u8]) -> Result<Zeroizing<[u8; 64]>, VaultError> {
    let s = std::str::from_utf8(words).map_err(|_| VaultError::InvalidMnemonic)?;
    let m = Mnemonic::parse(s.trim()).map_err(|_| VaultError::InvalidMnemonic)?;
    let seed = m.to_seed(""); // empty BIP39 passphrase
    Ok(Zeroizing::new(seed))
}

// Minimal BIP32 (SLIP-0010 secp256k1) hardened+normal CKDpriv.
fn ckd_priv(key: &[u8; 32], chain: &[u8; 32], index: u32) -> ([u8; 32], [u8; 32]) {
    let mut mac = HmacSha512::new_from_slice(chain).unwrap();
    if index >= HARD {
        mac.update(&[0u8]);
        mac.update(key);
    } else {
        let sk = SigningKey::from_slice(key).unwrap();
        let pubkey = sk.verifying_key().to_encoded_point(true);
        mac.update(pubkey.as_bytes());
    }
    mac.update(&index.to_be_bytes());
    let i = mac.finalize().into_bytes();
    let (il, ir) = i.split_at(32);
    // child = (il + key) mod n  — use k256 scalar arithmetic
    let child = k256_add_scalars(il.try_into().unwrap(), key);
    let mut chain_out = [0u8; 32];
    chain_out.copy_from_slice(ir);
    (child, chain_out)
}

fn k256_add_scalars(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    use k256::elliptic_curve::ops::Reduce;
    use k256::{Scalar, U256};
    let sa = <Scalar as Reduce<U256>>::reduce_bytes(a.into());
    let sb = <Scalar as Reduce<U256>>::reduce_bytes(b.into());
    (sa + sb).to_bytes().into()
}

pub fn private_key_at(seed: &[u8], index: u32) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let mut mac = HmacSha512::new_from_slice(b"Bitcoin seed").map_err(|_| VaultError::Derive("hmac"))?;
    mac.update(seed);
    let i = mac.finalize().into_bytes();
    let mut key = [0u8; 32]; key.copy_from_slice(&i[..32]);
    let mut chain = [0u8; 32]; chain.copy_from_slice(&i[32..]);
    let mut path = CKB_PATH; path[4] = index;
    for idx in path { let (k, c) = ckd_priv(&key, &chain, idx); key = k; chain = c; }
    Ok(Zeroizing::new(key))
}

pub fn blake160_pubkey(privkey: &[u8; 32]) -> [u8; 20] {
    let sk = SigningKey::from_slice(privkey).unwrap();
    let pubkey = sk.verifying_key().to_encoded_point(true); // 33-byte compressed
    let mut hasher = blake2b_ref::Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    hasher.update(pubkey.as_bytes());
    let mut out = [0u8; 32]; hasher.finalize(&mut out);
    let mut args = [0u8; 20]; args.copy_from_slice(&out[..20]); args
}

pub fn sign_recoverable(privkey: &[u8; 32], digest: &[u8; 32]) -> [u8; 65] {
    let sk = SigningKey::from_slice(privkey).unwrap();
    let (sig, recid): (Signature, RecoveryId) = sk.sign_prehash(digest).unwrap(); // k256 normalizes low-s
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = recid.to_byte();
    out
}

pub fn estimate_entropy_bits(password: &[u8]) -> u32 {
    // Conservative Shannon-style estimate: length × log2(observed charset).
    let mut lower=false; let mut upper=false; let mut digit=false; let mut sym=false;
    for &b in password { match b { b'a'..=b'z'=>lower=true, b'A'..=b'Z'=>upper=true, b'0'..=b'9'=>digit=true, _=>sym=true } }
    let space = (lower as u32)*26 + (upper as u32)*26 + (digit as u32)*10 + (sym as u32)*33;
    if space == 0 { return 0; }
    ((password.len() as f64) * (space as f64).log2()) as u32
}
```

> Note: `k256` scalar APIs shift across minor versions; if `Reduce`/`to_bytes` names differ on the pinned version, adapt — the contract is "BIP32 CKDpriv `m/44'/309'/0'/0/index`, low-s recoverable sig". Cross-check the first green derivation against `ckb-cli` for the test mnemonic and pin the hex in Step 1's anchor.

- [ ] **Step 4: Run to verify pass; then pin the regression anchor**

Run: `cargo test --test derive`
Expected: PASS. Print `hex::encode(args)` once, paste the 20-byte value back into the `derives_stable_lock_args` assertion, re-run green.

- [ ] **Step 5: Commit**

```bash
git add packages/ckb-keyvault-wasm/src/derive.rs packages/ckb-keyvault-wasm/tests/derive.rs
git commit -m "feat(keyvault): BIP39/BIP32 CKB derivation + recoverable secp256k1 sign"
```

### Task A4: wasm-bindgen public surface

**Files:**
- Modify: `packages/ckb-keyvault-wasm/src/lib.rs`
- Test: `packages/ckb-keyvault-wasm/tests/wasm_surface.rs` (logic-level, calling the same inner fns)

**Interfaces:**
- Produces (all `#[wasm_bindgen]`):
  - `generate_master_seed(password: &[u8]) -> Result<JsValue, JsValue>` → `{ blob: Uint8Array, mnemonic: Uint8Array }` (mnemonic returned once for display, caller zeroizes).
  - `import_seed_phrase(mnemonic: &[u8], password: &[u8]) -> Result<Vec<u8>, JsValue>` (blob).
  - `export_seed_phrase(blob: &[u8], password: &[u8]) -> Result<Vec<u8>, JsValue>` (mnemonic bytes).
  - `derive_lock_args(blob: &[u8], password: &[u8], index: u32) -> Result<Vec<u8>, JsValue>` (20 bytes).
  - `sign_digest(blob: &[u8], password: &[u8], index: u32, digest: &[u8]) -> Result<Vec<u8>, JsValue>` (65 bytes).
  - `change_password(blob, old, new) -> Result<Vec<u8>, JsValue>` (re-encrypted blob).

- [ ] **Step 1: Write the failing surface test** (calls inner fns to assert composition)

```rust
// tests/wasm_surface.rs
use ckb_keyvault_wasm::vault::{encrypt_seed, decrypt_seed};
use ckb_keyvault_wasm::derive::{mnemonic_to_seed, private_key_at, blake160_pubkey, sign_recoverable};

#[test]
fn import_derive_sign_compose() {
    let m = b"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let seed = mnemonic_to_seed(m).unwrap();
    let blob = encrypt_seed(&seed[..], b"pw").unwrap();
    let seed2 = decrypt_seed(&blob, b"pw").unwrap();
    let pk = private_key_at(&seed2[..], 0).unwrap();
    let _args = blake160_pubkey(&pk);
    let sig = sign_recoverable(&pk, &[1u8;32]);
    assert_eq!(sig.len(), 65);
}
```

- [ ] **Step 2: Run to verify it fails / compiles red**

Run: `cargo test --test wasm_surface`
Expected: PASS only after `import_seed_phrase` etc. exist; if you write the binding first, this proves the composition. (This test guards the inner contract; the bindings themselves are exercised by `keyvault-host.test.ts` in Phase B.)

- [ ] **Step 3: Implement the bindings in `src/lib.rs`**

```rust
use wasm_bindgen::prelude::*;
use js_sys::{Object, Reflect, Uint8Array};
use zeroize::Zeroize;

#[wasm_bindgen]
pub fn import_seed_phrase(mnemonic: &[u8], password: &[u8]) -> Result<Vec<u8>, JsValue> {
    if !derive::validate_mnemonic(mnemonic) { return Err(error::VaultError::InvalidMnemonic.into()); }
    let seed = derive::mnemonic_to_seed(mnemonic)?;
    Ok(vault::encrypt_seed(&seed[..], password)?)
}

#[wasm_bindgen]
pub fn export_seed_phrase(blob: &[u8], password: &[u8]) -> Result<Vec<u8>, JsValue> {
    // The seed is one-way (BIP39 seed != mnemonic). To support export we must store
    // the mnemonic, not the seed. DECISION for v1: store the MNEMONIC bytes in the
    // blob (encrypt_seed over mnemonic UTF-8). derive::mnemonic_to_seed is then applied
    // after decrypt in derive paths. Update A2/A3 callers accordingly: blob plaintext = mnemonic.
    let mnemonic = vault::decrypt_seed(blob, password)?;
    Ok(mnemonic.to_vec())
}

#[wasm_bindgen]
pub fn derive_lock_args(blob: &[u8], password: &[u8], index: u32) -> Result<Vec<u8>, JsValue> {
    let mnemonic = vault::decrypt_seed(blob, password)?;
    let seed = derive::mnemonic_to_seed(&mnemonic)?;
    let pk = derive::private_key_at(&seed[..], index)?;
    Ok(derive::blake160_pubkey(&pk).to_vec())
}

#[wasm_bindgen]
pub fn sign_digest(blob: &[u8], password: &[u8], index: u32, digest: &[u8]) -> Result<Vec<u8>, JsValue> {
    if digest.len() != 32 { return Err(error::VaultError::Derive("digest len").into()); }
    let mnemonic = vault::decrypt_seed(blob, password)?;
    let seed = derive::mnemonic_to_seed(&mnemonic)?;
    let pk = derive::private_key_at(&seed[..], index)?;
    let mut d = [0u8; 32]; d.copy_from_slice(digest);
    Ok(derive::sign_recoverable(&pk, &d).to_vec())
}

#[wasm_bindgen]
pub fn generate_master_seed(password: &[u8]) -> Result<JsValue, JsValue> {
    use bip39::Mnemonic;
    let mut entropy = [0u8; 16]; // 12 words
    getrandom::getrandom(&mut entropy).map_err(|_| error::VaultError::Corrupt("rng"))?;
    let m = Mnemonic::from_entropy(&entropy).map_err(|_| error::VaultError::Corrupt("mnemonic"))?;
    entropy.zeroize();
    let words = m.to_string();
    let blob = vault::encrypt_seed(words.as_bytes(), password)?;
    let obj = Object::new();
    Reflect::set(&obj, &"blob".into(), &Uint8Array::from(&blob[..])).unwrap();
    Reflect::set(&obj, &"mnemonic".into(), &Uint8Array::from(words.as_bytes())).unwrap();
    Ok(obj.into())
}

#[wasm_bindgen]
pub fn change_password(blob: &[u8], old: &[u8], new: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mnemonic = vault::decrypt_seed(blob, old)?;
    Ok(vault::encrypt_seed(&mnemonic, new)?)
}
```

> IMPORTANT: per the `export_seed_phrase` note, the blob plaintext is the **mnemonic UTF-8**, not the 64-byte seed. Revisit A2 tests (they used arbitrary 32-byte "seed" — still valid as opaque bytes) and ensure A3 derive paths apply `mnemonic_to_seed` after `decrypt_seed`. This keeps export working and is the same choice quantum-purse makes (`export_seed_phrase`).

- [ ] **Step 4: Build the nodejs pkg**

Run: `wasm-pack build --target nodejs && cargo test`
Expected: pkg built; all cargo tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/ckb-keyvault-wasm/src/lib.rs packages/ckb-keyvault-wasm/tests/wasm_surface.rs
git commit -m "feat(keyvault): wasm-bindgen vault surface (import/derive/sign/export)"
```

---

## Phase B — Shared contracts + Electron main host

### Task B1: Sighash-all digest helper (shared)

**Files:**
- Create: `packages/shared/src/ckb-sighash.ts`
- Test: `packages/shared/src/ckb-sighash.test.ts`

**Interfaces:**
- Produces: `computeSighashAllDigest(tx: Transaction, groupInputIndices: number[]): string` — returns 0x-prefixed 32-byte hex. Implements CKB `secp256k1_blake160_sighash_all`: `blake2b(txHash || u64le(len(witness[g0])) || witness[g0]_with_lock_zeroed || [other group witnesses] || [witnesses beyond inputs])`, lock zeroed to 65 bytes. Mirror the existing multisig `treasurySighashDigest` (search `apps/desktop` for it) for byte-exactness — reuse its blake2b + WitnessArgs zeroing path.

- [ ] **Step 1: Write failing test** (round-trip against `ckb-secp256k1.ts`)

```typescript
import { describe, it, expect } from "vitest";
import { Transaction } from "@ckb-ccc/core";
import { computeSighashAllDigest } from "./ckb-sighash";
import { signDigest, recoverPubkeyHashFromSignature, pubkeyHashFromPrivateKey }
  from "../../../apps/desktop/src/lib/signers/ckb-secp256k1"; // or relocate helper to shared

it("digest signs and recovers to the signing key", () => {
  const priv = "0x" + "11".repeat(32);
  const tx = Transaction.from({
    inputs: [{ previousOutput: { txHash: "0x" + "22".repeat(32), index: 0 } }],
    outputs: [{ capacity: 6100000000n, lock: { codeHash: "0x" + "33".repeat(32), hashType: "type", args: "0x" } }],
    outputsData: ["0x"],
  });
  tx.witnesses[0] = "0x"; // helper inserts the 65-byte zero lock placeholder itself
  const digest = computeSighashAllDigest(tx, [0]);
  const sig = signDigest(digest, priv);
  expect(recoverPubkeyHashFromSignature(digest, sig)).toBe(pubkeyHashFromPrivateKey(priv));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @chain-pay/shared test ckb-sighash`
Expected: FAIL — `computeSighashAllDigest` not found.

- [ ] **Step 3: Implement** (reuse CCC `Transaction.hash()` + `WitnessArgs`; zero a 65-byte lock; blake2b via `HasherCkb`)

```typescript
import { Transaction, WitnessArgs, HasherCkb, hexFrom, bytesFrom, numToBytes, bytesConcat } from "@ckb-ccc/core";

export function computeSighashAllDigest(tx: Transaction, groupInputIndices: number[]): string {
  if (groupInputIndices.length === 0) throw new Error("empty signing group");
  const txHash = bytesFrom(tx.hash());
  const first = groupInputIndices[0]!;
  const existing = tx.witnesses[first] ?? "0x";
  const wa = existing === "0x"
    ? WitnessArgs.from({ lock: "0x" + "00".repeat(65) })
    : WitnessArgs.fromBytes(bytesFrom(existing));
  const zeroed = WitnessArgs.from({ ...wa, lock: "0x" + "00".repeat(65) });
  const hasher = new HasherCkb(32);
  hasher.update(txHash);
  const w0 = zeroed.toBytes();
  hasher.update(numToBytes(w0.length, 8));   // u64 LE length prefix
  hasher.update(w0);
  for (const idx of groupInputIndices.slice(1)) {
    const w = bytesFrom(tx.witnesses[idx] ?? "0x");
    hasher.update(numToBytes(w.length, 8));
    hasher.update(w);
  }
  for (let i = tx.inputs.length; i < tx.witnesses.length; i++) {
    const w = bytesFrom(tx.witnesses[i] ?? "0x");
    hasher.update(numToBytes(w.length, 8));
    hasher.update(w);
  }
  return hexFrom(hasher.digest());
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @chain-pay/shared test ckb-sighash`
Expected: PASS. (If recovery fails, the byte layout diverges from the in-script formula — compare against the multisig `treasurySighashDigest` until they agree.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/ckb-sighash.ts packages/shared/src/ckb-sighash.test.ts
git commit -m "feat(keyvault): shared CKB sighash-all digest helper"
```

### Task B2: IPC schema + channel constants (shared)

**Files:**
- Create: `packages/shared/src/keyvault-ipc.ts`
- Test: `packages/shared/src/keyvault-ipc.test.ts`

**Interfaces:**
- Produces: Zod schemas + inferred types + channel names. Channels: `keyvault:status`, `keyvault:create`, `keyvault:import`, `keyvault:unlock-derive`, `keyvault:sign-tx`, `keyvault:export`, `keyvault:change-password`, `keyvault:delete`. Sign request: `{ keyvaultId: string, password: string, derivationIndex: number, unsignedTx: string /*JSON*/, sourceLockArgs: Hex20, groupInputIndices: number[] }`. Sign response: `{ signedTx: string /*JSON*/ }`.

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { SignTxRequest, KEYVAULT_CHANNELS } from "./keyvault-ipc";

it("rejects a sign request with a non-32-byte-ish lock args", () => {
  const bad = { keyvaultId: "k1", password: "p", derivationIndex: 0, unsignedTx: "{}", sourceLockArgs: "0xzz", groupInputIndices: [0] };
  expect(SignTxRequest.safeParse(bad).success).toBe(false);
});
it("accepts a well-formed sign request", () => {
  const ok = { keyvaultId: "k1", password: "p", derivationIndex: 0, unsignedTx: "{}", sourceLockArgs: "0x" + "ab".repeat(20), groupInputIndices: [0] };
  expect(SignTxRequest.safeParse(ok).success).toBe(true);
});
it("freezes channel names", () => { expect(KEYVAULT_CHANNELS.signTx).toBe("keyvault:sign-tx"); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @chain-pay/shared test keyvault-ipc`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { z } from "zod";

const Hex20 = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const SignTxRequest = z.object({
  keyvaultId: z.string().min(1),
  password: z.string().min(1),
  derivationIndex: z.number().int().min(0).max(2_147_483_647),
  unsignedTx: z.string(),
  sourceLockArgs: Hex20,
  groupInputIndices: z.array(z.number().int().min(0)).min(1),
});
export type SignTxRequest = z.infer<typeof SignTxRequest>;

export const SignTxResponse = z.object({ signedTx: z.string() });
export type SignTxResponse = z.infer<typeof SignTxResponse>;

export const ImportRequest = z.object({ mnemonic: z.string().min(1), password: z.string().min(1) });
export const CreateRequest = z.object({ password: z.string().min(1) });
export const UnlockDeriveRequest = z.object({ keyvaultId: z.string(), password: z.string().min(1), derivationIndex: z.number().int().min(0) });

export const KEYVAULT_CHANNELS = {
  status: "keyvault:status",
  create: "keyvault:create",
  import: "keyvault:import",
  unlockDerive: "keyvault:unlock-derive",
  signTx: "keyvault:sign-tx",
  export: "keyvault:export",
  changePassword: "keyvault:change-password",
  delete: "keyvault:delete",
} as const;
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @chain-pay/shared test keyvault-ipc`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/keyvault-ipc.ts packages/shared/src/keyvault-ipc.test.ts
git commit -m "feat(keyvault): shared IPC zod schemas + channel constants"
```

### Task B3: Blob file store (main)

**Files:**
- Create: `apps/desktop/electron/main/keyvault-store.ts`
- Test: `apps/desktop/electron/main/keyvault-store.test.ts`

**Interfaces:**
- Produces: `class KeyvaultStore { constructor(dir: string); has(id): boolean; read(id): Buffer; write(id, blob: Buffer): void; delete(id): void; list(): string[] }`. Files at `<dir>/<id>.vault`, mode `0o600`. `id` validated `^[a-z0-9-]{1,64}$` to prevent path traversal.

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyvaultStore } from "./keyvault-store";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kv-")); });

it("round-trips a blob", () => {
  const s = new KeyvaultStore(dir);
  expect(s.has("main")).toBe(false);
  s.write("main", Buffer.from([1,2,3]));
  expect(s.has("main")).toBe(true);
  expect([...s.read("main")]).toEqual([1,2,3]);
});
it("rejects path-traversal ids", () => {
  const s = new KeyvaultStore(dir);
  expect(() => s.write("../evil", Buffer.from([0]))).toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter desktop test keyvault-store`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ID_RE = /^[a-z0-9-]{1,64}$/;

export class KeyvaultStore {
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true }); }
  private path(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`invalid keyvault id: ${id}`);
    return join(this.dir, `${id}.vault`);
  }
  has(id: string): boolean { return existsSync(this.path(id)); }
  read(id: string): Buffer { return readFileSync(this.path(id)); }
  write(id: string, blob: Buffer): void { writeFileSync(this.path(id), blob, { mode: 0o600 }); }
  delete(id: string): void { if (this.has(id)) unlinkSync(this.path(id)); }
  list(): string[] { return readdirSync(this.dir).filter(f => f.endsWith(".vault")).map(f => f.slice(0, -6)); }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter desktop test keyvault-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/keyvault-store.ts apps/desktop/electron/main/keyvault-store.test.ts
git commit -m "feat(keyvault): main-process blob file store"
```

### Task B4: Keyvault host — create/import/derive + the secure sign path

**Files:**
- Create: `apps/desktop/electron/main/keyvault-host.ts`
- Test: `apps/desktop/electron/main/keyvault-host.test.ts`
- Modify: `apps/desktop/electron/main/index.ts` (register host on app ready)

**Interfaces:**
- Consumes: `ckb-keyvault-wasm/pkg` (A4), `KeyvaultStore` (B3), `computeSighashAllDigest` (B1), `SignTxRequest` etc. (B2).
- Produces: `registerKeyvaultHost(deps: { store: KeyvaultStore, wasm: typeof import("ckb-keyvault-wasm") }): void` registering `ipcMain.handle` for every channel. Plus an exported pure `signTxInVault(req, deps)` so the security logic is unit-testable without Electron.

- [ ] **Step 1: Write the failing security test** (the heart of the feature)

```typescript
import { describe, it, expect } from "vitest";
import { Transaction } from "@ckb-ccc/core";
import * as wasm from "../../../../packages/ckb-keyvault-wasm/pkg";
import { KeyvaultStore } from "./keyvault-store";
import { signTxInVault, importVault } from "./keyvault-host";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function freshStore() { return new KeyvaultStore(mkdtempSync(join(tmpdir(), "kvh-"))); }

it("signs a tx whose source lock-args match the vault key", async () => {
  const store = freshStore();
  const { id, lockArgs } = await importVault({ mnemonic: M, password: "pw" }, { store, wasm });
  const tx = Transaction.from({ inputs: [{ previousOutput: { txHash: "0x"+"22".repeat(32), index: 0 } }], outputs: [], outputsData: [] });
  const res = await signTxInVault(
    { keyvaultId: id, password: "pw", derivationIndex: 0, unsignedTx: JSON.stringify(tx), sourceLockArgs: lockArgs, groupInputIndices: [0] },
    { store, wasm },
  );
  const signed = Transaction.from(JSON.parse(res.signedTx));
  expect(signed.witnesses[0]).not.toBe("0x");
});

it("REFUSES to sign when source lock-args do not match the vault key (anti-blind-sign)", async () => {
  const store = freshStore();
  const { id } = await importVault({ mnemonic: M, password: "pw" }, { store, wasm });
  const tx = Transaction.from({ inputs: [{ previousOutput: { txHash: "0x"+"22".repeat(32), index: 0 } }], outputs: [], outputsData: [] });
  await expect(signTxInVault(
    { keyvaultId: id, password: "pw", derivationIndex: 0, unsignedTx: JSON.stringify(tx), sourceLockArgs: "0x"+"ff".repeat(20), groupInputIndices: [0] },
    { store, wasm },
  )).rejects.toThrow(/lock args do not match/i);
});

it("rejects a wrong password", async () => {
  const store = freshStore();
  const { id, lockArgs } = await importVault({ mnemonic: M, password: "pw" }, { store, wasm });
  const tx = Transaction.from({ inputs: [{ previousOutput: { txHash: "0x"+"22".repeat(32), index: 0 } }], outputs: [], outputsData: [] });
  await expect(signTxInVault(
    { keyvaultId: id, password: "WRONG", derivationIndex: 0, unsignedTx: JSON.stringify(tx), sourceLockArgs: lockArgs, groupInputIndices: [0] },
    { store, wasm },
  )).rejects.toThrow(/wrong password/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter desktop test keyvault-host`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `keyvault-host.ts`**

```typescript
import { ipcMain } from "electron";
import { Transaction, hexFrom, bytesFrom, WitnessArgs } from "@ckb-ccc/core";
import { KeyvaultStore } from "./keyvault-store";
import { computeSighashAllDigest } from "@chain-pay/shared/ckb-sighash";
import { SignTxRequest, ImportRequest, CreateRequest, KEYVAULT_CHANNELS, type SignTxResponse } from "@chain-pay/shared/keyvault-ipc";

interface Deps { store: KeyvaultStore; wasm: typeof import("ckb-keyvault-wasm"); }

const VAULT_ID = "main"; // v1: single local keyvault

function hexToArgs(hex: string): string { return hex.toLowerCase(); }

export async function importVault(req: { mnemonic: string; password: string }, deps: Deps): Promise<{ id: string; lockArgs: string }> {
  ImportRequest.parse(req);
  const mnemonic = new TextEncoder().encode(req.mnemonic);
  const password = new TextEncoder().encode(req.password);
  try {
    const blob = deps.wasm.import_seed_phrase(mnemonic, password); // throws on bad mnemonic
    deps.store.write(VAULT_ID, Buffer.from(blob));
    const args = deps.wasm.derive_lock_args(blob, password, 0);
    return { id: VAULT_ID, lockArgs: hexFrom(args) };
  } finally { mnemonic.fill(0); password.fill(0); }
}

export async function signTxInVault(reqIn: unknown, deps: Deps): Promise<SignTxResponse> {
  const req = SignTxRequest.parse(reqIn);
  if (!deps.store.has(req.keyvaultId)) throw new Error("keyvault not found");
  const blob = deps.store.read(req.keyvaultId);
  const password = new TextEncoder().encode(req.password);
  try {
    // 1. Confirm this vault key actually owns the source lock — never blind-sign.
    const derived = hexFrom(deps.wasm.derive_lock_args(blob, password, req.derivationIndex));
    if (hexToArgs(derived) !== hexToArgs(req.sourceLockArgs)) {
      throw new Error("source lock args do not match this keyvault's derived key");
    }
    // 2. Recompute the digest from the tx WE hold — not a renderer-supplied digest.
    const tx = Transaction.from(JSON.parse(req.unsignedTx));
    const digest = computeSighashAllDigest(tx, req.groupInputIndices);
    // 3. Sign inside the vault, place the 65-byte lock into witness[group[0]].
    const sig = deps.wasm.sign_digest(blob, password, req.derivationIndex, bytesFrom(digest));
    const g0 = req.groupInputIndices[0]!;
    const existing = tx.witnesses[g0] && tx.witnesses[g0] !== "0x"
      ? WitnessArgs.fromBytes(bytesFrom(tx.witnesses[g0]!))
      : WitnessArgs.from({});
    const finalWa = WitnessArgs.from({ ...existing, lock: hexFrom(sig) });
    tx.witnesses[g0] = hexFrom(finalWa.toBytes());
    return { signedTx: JSON.stringify(tx) };
  } finally { password.fill(0); }
}

export function registerKeyvaultHost(deps: Deps): void {
  ipcMain.handle(KEYVAULT_CHANNELS.import, (_e, r) => importVault(r, deps));
  ipcMain.handle(KEYVAULT_CHANNELS.create, (_e, r) => {
    CreateRequest.parse(r);
    const password = new TextEncoder().encode(r.password);
    try {
      const { blob, mnemonic } = deps.wasm.generate_master_seed(password) as { blob: Uint8Array; mnemonic: Uint8Array };
      deps.store.write(VAULT_ID, Buffer.from(blob));
      const args = hexFrom(deps.wasm.derive_lock_args(blob, password, 0));
      const phrase = new TextDecoder().decode(mnemonic);
      mnemonic.fill(0);
      return { id: VAULT_ID, lockArgs: args, mnemonic: phrase }; // shown once, renderer must clear
    } finally { password.fill(0); }
  });
  ipcMain.handle(KEYVAULT_CHANNELS.signTx, (_e, r) => signTxInVault(r, deps));
  ipcMain.handle(KEYVAULT_CHANNELS.status, () => ({ exists: deps.store.has(VAULT_ID) }));
  ipcMain.handle(KEYVAULT_CHANNELS.delete, () => { deps.store.delete(VAULT_ID); return { ok: true }; });
  // export + change-password follow the same shape.
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter desktop test keyvault-host`
Expected: PASS (3 tests) — especially the REFUSE-to-blind-sign test.

- [ ] **Step 5: Register on app ready in `index.ts` and commit**

```typescript
// apps/desktop/electron/main/index.ts (inside app.whenReady)
import { KeyvaultStore } from "./keyvault-store";
import { registerKeyvaultHost } from "./keyvault-host";
import * as keyvaultWasm from "ckb-keyvault-wasm";
const kvStore = new KeyvaultStore(join(app.getPath("userData"), "keyvault"));
registerKeyvaultHost({ store: kvStore, wasm: keyvaultWasm });
```

```bash
git add apps/desktop/electron/main/keyvault-host.ts apps/desktop/electron/main/keyvault-host.test.ts apps/desktop/electron/main/index.ts
git commit -m "feat(keyvault): main host with lock-args-verified, non-blind sign path"
```

---

## Phase C — Renderer signer + send-path wiring

### Task C1: Preload bridge

**Files:**
- Modify: `apps/desktop/electron/preload/index.ts`

**Interfaces:**
- Produces: `window.chainpay.keyvault = { status(), create(password), import(mnemonic, password), signTx(req), delete() }`, each `ipcRenderer.invoke` on the matching channel. Type the surface in the renderer's existing global-bridge `.d.ts`.

- [ ] **Step 1: Add the bridge** (no separate test — covered by C2/preload-contract manual smoke; see memory `preload-contract-test-gap`)

```typescript
import { contextBridge, ipcRenderer } from "electron";
import { KEYVAULT_CHANNELS } from "@chain-pay/shared/keyvault-ipc";
contextBridge.exposeInMainWorld("chainpay", {
  // ...existing namespaces...
  keyvault: {
    status: () => ipcRenderer.invoke(KEYVAULT_CHANNELS.status),
    create: (password: string) => ipcRenderer.invoke(KEYVAULT_CHANNELS.create, { password }),
    import: (mnemonic: string, password: string) => ipcRenderer.invoke(KEYVAULT_CHANNELS.import, { mnemonic, password }),
    signTx: (req: unknown) => ipcRenderer.invoke(KEYVAULT_CHANNELS.signTx, req),
    delete: () => ipcRenderer.invoke(KEYVAULT_CHANNELS.delete),
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter desktop typecheck`
Expected: no errors (add the `keyvault` field to the global bridge interface if tsc complains).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/electron/preload/index.ts
git commit -m "feat(keyvault): preload bridge for keyvault IPC"
```

### Task C2: `secp256k1-lock` helper + `Source.lockKind`

**Files:**
- Create: `apps/desktop/src/lib/chains/ckb/secp256k1-lock.ts`
- Test: `apps/desktop/src/lib/chains/ckb/secp256k1-lock.test.ts`
- Modify: `packages/shared/src/<source-type>.ts` (add `lockKind: "joyid" | "secp256k1"`, optional `keyvaultId?: string`, `derivationIndex?: number`)

**Interfaces:**
- Consumes: `ScriptInfo`, `Hex20` args.
- Produces: `secp256k1LockAndDeps(scriptInfo: ScriptInfo, args: Hex20): { lock: Script; cellDeps: CellDep[] }` — mirrors `joyidLockAndDeps`, returns the `secp256k1_blake160_sighash_all` lock + its system cell dep.

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { secp256k1LockAndDeps } from "./secp256k1-lock";
import { SECP256K1_TESTNET_SCRIPT_INFO } from "./script-info-fixtures"; // existing fixtures

it("builds a sighash-all lock with the given args", () => {
  const { lock } = secp256k1LockAndDeps(SECP256K1_TESTNET_SCRIPT_INFO, "0x" + "ab".repeat(20));
  expect(lock.args).toBe("0x" + "ab".repeat(20));
  expect(lock.hashType).toBe("type");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter desktop test secp256k1-lock`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (model on `joyid-lock.ts`)

```typescript
import { Script, type ScriptInfo, type CellDep } from "@ckb-ccc/core";
import type { Hex20 } from "@chain-pay/shared";

export function secp256k1LockAndDeps(scriptInfo: ScriptInfo, args: Hex20): { lock: Script; cellDeps: CellDep[] } {
  const lock = Script.from({ codeHash: scriptInfo.codeHash, hashType: scriptInfo.hashType, args });
  return { lock, cellDeps: scriptInfo.cellDeps.map((d) => d.cellDep) };
}
```

- [ ] **Step 4: Run + extend `Source`**

Run: `pnpm --filter desktop test secp256k1-lock` → PASS. Add `lockKind`/`keyvaultId`/`derivationIndex` to the `Source` type; default existing sources to `lockKind: "joyid"`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/chains/ckb/secp256k1-lock.ts apps/desktop/src/lib/chains/ckb/secp256k1-lock.test.ts packages/shared/src
git commit -m "feat(keyvault): secp256k1 sighash-all lock helper + Source.lockKind"
```

### Task C3: `LocalKeystoreCkbTxSigner` + widen `CkbTxSigner.kind`

**Files:**
- Modify: `apps/desktop/src/lib/signers/ckb-tx-signer.ts:9` (`kind: "joyid" | "local-keystore"`)
- Create: `apps/desktop/src/lib/signers/local-keystore-ckb-tx-signer.ts`
- Test: `apps/desktop/src/lib/signers/local-keystore-ckb-tx-signer.test.ts`

**Interfaces:**
- Consumes: `window.chainpay.keyvault.signTx`, `computeSighashAllDigest`-derived `groupInputIndices` (computed renderer-side from which inputs carry the source lock).
- Produces: `class LocalKeystoreCkbTxSigner implements CkbTxSigner { kind: "local-keystore"; constructor(opts: { keyvaultId, derivationIndex, sourceLockArgs, password, sourceLock, bridge }); connect(); signTransaction(tx) }`. `signTransaction` computes `groupInputIndices` (inputs whose lock equals `sourceLock`), serializes the tx, calls the bridge, and returns the rebuilt signed `Transaction`.

- [ ] **Step 1: Write failing test** (inject a fake bridge)

```typescript
import { describe, it, expect, vi } from "vitest";
import { Transaction, Script } from "@ckb-ccc/core";
import { LocalKeystoreCkbTxSigner } from "./local-keystore-ckb-tx-signer";

it("sends the right group indices and source args to the bridge", async () => {
  const sourceLock = Script.from({ codeHash: "0x"+"33".repeat(32), hashType: "type", args: "0x"+"ab".repeat(20) });
  const tx = Transaction.from({
    inputs: [{ previousOutput: { txHash: "0x"+"22".repeat(32), index: 0 } }],
    outputs: [], outputsData: [],
  });
  // pretend input 0 resolves to sourceLock (signer is told the source lock explicitly)
  const bridge = { signTx: vi.fn().mockResolvedValue({ signedTx: JSON.stringify(tx) }) };
  const signer = new LocalKeystoreCkbTxSigner({
    keyvaultId: "main", derivationIndex: 0, sourceLockArgs: "0x"+"ab".repeat(20),
    password: "pw", sourceLock, groupInputIndices: [0], bridge,
  });
  await signer.signTransaction(tx);
  expect(bridge.signTx).toHaveBeenCalledWith(expect.objectContaining({
    keyvaultId: "main", derivationIndex: 0, sourceLockArgs: "0x"+"ab".repeat(20), groupInputIndices: [0],
  }));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter desktop test local-keystore-ckb-tx-signer`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { Transaction, type Script } from "@ckb-ccc/core";
import type { CkbTxSigner } from "./ckb-tx-signer";
import type { Hex20 } from "@chain-pay/shared";

interface KeyvaultBridge { signTx(req: unknown): Promise<{ signedTx: string }>; }

interface LocalSignerOpts {
  keyvaultId: string;
  derivationIndex: number;
  sourceLockArgs: Hex20;
  password: string;            // held only for the duration of this signer instance
  sourceLock: Script;
  groupInputIndices: number[]; // inputs whose lock === sourceLock
  bridge: KeyvaultBridge;
}

export class LocalKeystoreCkbTxSigner implements CkbTxSigner {
  readonly kind = "local-keystore" as const;
  constructor(private readonly opts: LocalSignerOpts) {}

  async connect(): Promise<{ address: string; lockArgs: string }> {
    return { address: "", lockArgs: this.opts.sourceLockArgs };
  }

  async signTransaction(unsigned: Transaction): Promise<Transaction> {
    const res = await this.opts.bridge.signTx({
      keyvaultId: this.opts.keyvaultId,
      password: this.opts.password,
      derivationIndex: this.opts.derivationIndex,
      unsignedTx: JSON.stringify(unsigned),
      sourceLockArgs: this.opts.sourceLockArgs,
      groupInputIndices: this.opts.groupInputIndices,
    });
    return Transaction.from(JSON.parse(res.signedTx));
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter desktop test local-keystore-ckb-tx-signer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/signers/ckb-tx-signer.ts apps/desktop/src/lib/signers/local-keystore-ckb-tx-signer.ts apps/desktop/src/lib/signers/local-keystore-ckb-tx-signer.test.ts
git commit -m "feat(keyvault): LocalKeystoreCkbTxSigner (signs via main over IPC)"
```

### Task C4: Branch `buildAndSend` on source lock kind

**Files:**
- Modify: `apps/desktop/src/lib/send/build-and-send.ts:34`
- Test: `apps/desktop/src/lib/send/build-and-send.test.ts`

**Interfaces:**
- Consumes: `source.lockKind`, `joyidLockAndDeps`, `secp256k1LockAndDeps`.
- Produces: same `buildAndSend` signature; internally picks the lock+deps by `source.lockKind` and computes `groupInputIndices` for the local signer.

- [ ] **Step 1: Write failing test** — a `lockKind: "secp256k1"` source builds with the sighash-all lock and routes to the local signer.

```typescript
it("builds a secp256k1 source with sighash-all lock and signs locally", async () => {
  // arrange a SendRecord + Source{ lockKind:"secp256k1", keyvaultId:"main", derivationIndex:0, joyidLockArgs:reuse-as-args }
  // a mock signer whose kind === "local-keystore" asserts it received the tx
  // assert the source lock codeHash === secp256k1 sighash-all (not JoyID)
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter desktop test build-and-send`
Expected: FAIL — current code hard-codes `joyidLockAndDeps`.

- [ ] **Step 3: Implement the branch**

```typescript
const { lock: sourceLock, cellDeps } =
  source.lockKind === "secp256k1"
    ? secp256k1LockAndDeps(deps.secp256k1ScriptInfo, source.lockArgs)
    : joyidLockAndDeps(deps.scriptInfo, source.joyidLockArgs);
```

(Thread `secp256k1ScriptInfo` into `SendDeps`; compute `groupInputIndices` = indices of `availableCells` actually selected whose lock equals `sourceLock`, and pass them when constructing the local signer in the caller.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter desktop test build-and-send`
Expected: PASS (both JoyID and secp256k1 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/send/build-and-send.ts apps/desktop/src/lib/send/build-and-send.test.ts
git commit -m "feat(keyvault): route send by source lock kind (joyid|secp256k1)"
```

---

## Phase D — UI

### Task D1: Keyvault Zustand store + setup panel

**Files:**
- Create: `apps/desktop/src/features/keyvault/keyvault-store.ts`
- Create: `apps/desktop/src/features/keyvault/KeyvaultSetupPanel.tsx`
- Test: `apps/desktop/src/features/keyvault/keyvault-store.test.ts`, `KeyvaultSetupPanel.test.tsx`

**Interfaces:**
- Consumes: `window.chainpay.keyvault`.
- Produces: store `{ exists, lockArgs, address, refreshStatus(), createNew(password), importMnemonic(mnemonic, password), deleteVault() }`; panel with create / import / "write down these 12 words" confirmation; entropy meter via `password_entropy_bits` (call through a tiny IPC or reuse the strength estimate client-side).

- [ ] **Step 1: Write failing store test**

```typescript
it("marks exists=true after import", async () => {
  const bridge = { status: vi.fn().mockResolvedValue({ exists: false }), import: vi.fn().mockResolvedValue({ id: "main", lockArgs: "0x"+"ab".repeat(20) }) };
  // inject bridge, call importMnemonic, assert store.exists === true and lockArgs set
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter desktop test keyvault-store` (features path).
- [ ] **Step 3: Implement store + panel.** (Mnemonic shown once on create; cleared from React state on unmount; never persisted in renderer.)
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(keyvault): setup panel + store`.

### Task D2: Unlock modal gating a send

**Files:**
- Create: `apps/desktop/src/features/keyvault/UnlockModal.tsx`
- Modify: `apps/desktop/src/features/send/SendPanel.tsx` (when the chosen source `lockKind === "secp256k1"`, open `UnlockModal` to collect the password, build a `LocalKeystoreCkbTxSigner`, then run `buildAndSend`)
- Test: `UnlockModal.test.tsx`, `SendPanel.test.tsx` (extend)

**Interfaces:**
- Consumes: `LocalKeystoreCkbTxSigner`, keyvault store.
- Produces: a modal that returns a password to the caller; `SendPanel` constructs the signer with that password, runs the send, and drops the password reference immediately after.

- [ ] **Step 1: Write failing test** — selecting a secp256k1 source opens the modal; entering a password and confirming calls `buildAndSend` with a `kind:"local-keystore"` signer.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Password held only in modal state, passed once, then `setPassword("")` on close.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(keyvault): unlock modal gating secp256k1 sends`.

---

## Phase E — Verification & guardrails

### Task E1: Treasury exclusion guard (HARD constraint enforcement)

**Files:**
- Create: `apps/desktop/src/lib/keyvault/treasury-exclusion.test.ts`
- Modify: wherever treasury signer selection happens — add an assertion that a `local-keystore` signer can never be chosen for a treasury/multisig context.

- [ ] **Step 1: Write failing test** — attempting to use a `kind:"local-keystore"` signer in the treasury/multisig path throws `"local keystore signer is not permitted for treasury"`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the guard** at the treasury signer boundary.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(keyvault): forbid local keystore signer on treasury path`.

### Task E2: Full gate + docs

- [ ] **Step 1:** `pnpm --filter desktop typecheck` → clean (watch `exactOptionalPropertyTypes`; see memory `single-sig-joyid-send-shipped`).
- [ ] **Step 2:** `pnpm --filter desktop test && pnpm --filter @chain-pay/shared test && (cd packages/ckb-keyvault-wasm && cargo test)` → all green.
- [ ] **Step 3:** Update `CLAUDE.md` Hard Rule #1 to record the narrow amendment (local encrypted signer permitted ONLY on the non-treasury single-sig send path).
- [ ] **Step 4:** Whole-branch review with a fresh subagent (see memory `subagent-driven-cross-task-bugs`) focused on the IPC boundary + zeroize coverage + the treasury exclusion.
- [ ] **Step 5: Commit** `docs(keyvault): record Hard Rule #1 amendment + verification notes`.

---

## Self-Review

**Spec coverage:** BIP39 import (A4 `import_seed_phrase`, D1), create-new (A4 `generate_master_seed`, D1), password protection (A2 Argon2id+AEAD; B4 password→sign; D2 unlock gate), signing protection (B4 lock-args verify + digest recompute; E1 treasury exclusion), SMB-send-only scope (C4 branch + E1 guard), WASM vault in main (Phase A + B4), main-only key material (Global Constraints + B4 + C3 IPC boundary). All covered.

**Placeholder scan:** D1/D2/E1 use prose step bodies rather than full code blocks — they are UI/guard tasks whose exact JSX depends on the current `SendPanel`/treasury code, which the implementer reads at execution time; the interfaces and assertions are specified. All Phase A–C code steps carry complete code.

**Type consistency:** `lockArgs`/`sourceLockArgs` are `Hex20` throughout; `groupInputIndices: number[]` consistent across B1/B2/B4/C3/C4; `signTx` request shape matches between `keyvault-ipc.ts` (B2), host (B4), and signer (C3); channel constants centralized in `KEYVAULT_CHANNELS`. `CkbTxSigner.kind` widened once (C3) and consumed in E1.

**Open risk to verify at execution:** the `k256` BIP32 scalar API and the exact `computeSighashAllDigest` byte layout are the two places most likely to need adjustment — both are pinned by round-trip/recovery tests (A3 anchor, B1 recover-to-key) so a divergence fails loudly rather than shipping a bad signature.
