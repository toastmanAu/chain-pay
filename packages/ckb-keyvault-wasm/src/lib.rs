mod error;
pub mod derive;
pub mod vault;

use js_sys::{Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, Zeroizing};

// ── Password utility ──────────────────────────────────────────────────────────

/// Returns a conservative entropy estimate (bits) for a UTF-8 password.
/// Used by the UI strength meter; does NOT touch any vault.
#[wasm_bindgen]
pub fn password_entropy_bits(password: &[u8]) -> u32 {
    derive::estimate_entropy_bits(password)
}

// ── Vault surface ─────────────────────────────────────────────────────────────
//
// DESIGN: the blob plaintext is the BIP39 mnemonic (UTF-8), NOT the 64-byte
// derived seed.  This makes export_seed_phrase possible (the seed is one-way)
// and matches the quantum-purse pattern.
//
// derive_lock_args / sign_digest both follow:
//   decrypt_seed(blob) → mnemonic bytes → mnemonic_to_seed → private_key_at

/// Validate and import a BIP39 mnemonic phrase, encrypting it with `password`.
///
/// Returns the opaque encrypted blob.  Caller must zeroize the password buffer.
#[wasm_bindgen]
pub fn import_seed_phrase(mnemonic: &[u8], password: &[u8]) -> Result<Vec<u8>, JsValue> {
    if !derive::validate_mnemonic(mnemonic) {
        return Err(error::VaultError::InvalidMnemonic.into());
    }
    // Store the mnemonic bytes (UTF-8) in the blob — not the 64-byte seed.
    Ok(vault::encrypt_seed(mnemonic, password)?)
}

/// Decrypt `blob` with `password` and return the mnemonic bytes (UTF-8).
///
/// The returned bytes must be shown once and then zeroized by the caller.
#[wasm_bindgen]
pub fn export_seed_phrase(blob: &[u8], password: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mnemonic = vault::decrypt_seed(blob, password)?;
    Ok(mnemonic.to_vec())
}

/// Derive the 20-byte CKB lock-args (blake160 of compressed secp256k1 pubkey) at
/// `m/44'/309'/0'/0/<index>` from the mnemonic stored in `blob`.
#[wasm_bindgen]
pub fn derive_lock_args(blob: &[u8], password: &[u8], index: u32) -> Result<Vec<u8>, JsValue> {
    let mnemonic = vault::decrypt_seed(blob, password)?;
    let seed = derive::mnemonic_to_seed(&mnemonic)?;
    let pk = derive::private_key_at(&seed[..], index)?;
    Ok(derive::blake160_pubkey(&pk).to_vec())
}

/// Sign a 32-byte `digest` with the key at `m/44'/309'/0'/0/<index>`.
///
/// Returns a 65-byte recoverable signature (`r || s || v`, v ∈ {0, 1}, low-s).
/// Caller must zeroize the password buffer immediately after the call.
#[wasm_bindgen]
pub fn sign_digest(
    blob: &[u8],
    password: &[u8],
    index: u32,
    digest: &[u8],
) -> Result<Vec<u8>, JsValue> {
    if digest.len() != 32 {
        return Err(error::VaultError::Derive("digest must be exactly 32 bytes").into());
    }
    let mnemonic = vault::decrypt_seed(blob, password)?;
    let seed = derive::mnemonic_to_seed(&mnemonic)?;
    let pk = derive::private_key_at(&seed[..], index)?;
    let mut d = [0u8; 32];
    d.copy_from_slice(digest);
    Ok(derive::sign_recoverable(&pk, &d).to_vec())
}

/// Generate a fresh 12-word BIP39 mnemonic, encrypt it with `password`, and
/// return a JS object `{ blob: Uint8Array, mnemonic: Uint8Array }`.
///
/// The mnemonic is returned **once** for the user to write down.  The caller
/// must zeroize both the password and the mnemonic Uint8Array after display.
#[wasm_bindgen]
pub fn generate_master_seed(password: &[u8]) -> Result<JsValue, JsValue> {
    let mut entropy = [0u8; 16]; // 128 bits → 12 BIP39 words
    getrandom::getrandom(&mut entropy).map_err(|_| error::VaultError::Corrupt("rng"))?;
    let m = bip39::Mnemonic::from_entropy(&entropy)
        .map_err(|_| error::VaultError::Corrupt("mnemonic-gen"))?;
    entropy.zeroize(); // erase entropy immediately after use
    // Zeroizing<String> ensures the WASM-side mnemonic copy is wiped on drop.
    let words = Zeroizing::new(m.to_string());
    // blob plaintext = mnemonic UTF-8 (consistent with import_seed_phrase)
    let blob = vault::encrypt_seed(words.as_bytes(), password)?;
    let obj = Object::new();
    Reflect::set(&obj, &"blob".into(), &bytes_to_uint8array(&blob)).unwrap();
    Reflect::set(
        &obj,
        &"mnemonic".into(),
        &bytes_to_uint8array(words.as_bytes()),
    )
    .unwrap();
    Ok(obj.into())
}

/// Re-encrypt the mnemonic stored in `blob` from `old` password to `new` password.
///
/// Returns the new encrypted blob.  The old blob is not mutated.
#[wasm_bindgen]
pub fn change_password(blob: &[u8], old: &[u8], new: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mnemonic = vault::decrypt_seed(blob, old)?;
    Ok(vault::encrypt_seed(&mnemonic, new)?)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Copy Rust bytes into a freshly allocated JS `Uint8Array` (no unsafe view).
fn bytes_to_uint8array(bytes: &[u8]) -> Uint8Array {
    let arr = Uint8Array::new_with_length(bytes.len() as u32);
    arr.copy_from(bytes);
    arr
}
