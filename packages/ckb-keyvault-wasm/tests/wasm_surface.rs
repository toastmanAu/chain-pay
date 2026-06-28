// tests/wasm_surface.rs
//
// Composition guard for the wasm-bindgen surface (Task A4).
//
// These tests call the inner vault + derive fns directly (no #[wasm_bindgen] involved,
// so they run via `cargo test` without wasm-pack).  They prove that the composition
// logic implemented in lib.rs is correct:
//
//   import  → encrypt MNEMONIC bytes (not the 64-byte seed)
//   export  → decrypt to recover the MNEMONIC bytes
//   derive  → decrypt mnemonic → mnemonic_to_seed → private_key_at → blake160
//   sign    → decrypt mnemonic → mnemonic_to_seed → private_key_at → sign_recoverable
//   change  → decrypt mnemonic with old password → re-encrypt with new password
//
// The actual #[wasm_bindgen] exports are exercised by keyvault-host.test.ts in Phase B.

use ckb_keyvault_wasm::derive::{blake160_pubkey, mnemonic_to_seed, private_key_at, sign_recoverable};
use ckb_keyvault_wasm::vault::{decrypt_seed, encrypt_seed};

const M: &[u8] = b"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/// Core composition: import (encrypt mnemonic) → export (decrypt mnemonic) → derive → sign.
#[test]
fn import_derive_sign_compose() {
    // The blob plaintext is the mnemonic UTF-8, not the 64-byte BIP39 seed.
    let blob = encrypt_seed(M, b"pw").unwrap();
    let mnemonic = decrypt_seed(&blob, b"pw").unwrap();
    // export: we get back exactly the mnemonic bytes we put in
    assert_eq!(&mnemonic[..], M);
    // derive: mnemonic → 64-byte seed → private key → blake160
    let seed = mnemonic_to_seed(&mnemonic).unwrap();
    let pk = private_key_at(&seed[..], 0).unwrap();
    let args = blake160_pubkey(&pk);
    assert_eq!(args.len(), 20);
    // Regression: must match the same anchor as tests/derive.rs
    assert_eq!(hex::encode(args), "196f6c1f21f7dbf0df814539b840059facbafc24");
    // sign
    let sig = sign_recoverable(&pk, &[1u8; 32]);
    assert_eq!(sig.len(), 65);
    assert!(sig[64] <= 1, "recovery id must be 0 or 1");
}

/// Different derivation indices yield different keys.
#[test]
fn derive_index_varies_key() {
    let blob = encrypt_seed(M, b"pw").unwrap();
    let mnemonic = decrypt_seed(&blob, b"pw").unwrap();
    let seed = mnemonic_to_seed(&mnemonic).unwrap();
    let pk0 = private_key_at(&seed[..], 0).unwrap();
    let pk1 = private_key_at(&seed[..], 1).unwrap();
    assert_ne!(&pk0[..], &pk1[..]);
    assert_ne!(
        hex::encode(blake160_pubkey(&pk0)),
        hex::encode(blake160_pubkey(&pk1)),
    );
}

/// change_password: re-encrypt with new password yields the same mnemonic.
#[test]
fn change_password_compose() {
    let blob_old = encrypt_seed(M, b"old-pw").unwrap();
    let mnemonic_old = decrypt_seed(&blob_old, b"old-pw").unwrap();
    // re-encrypt (this is what change_password does internally)
    let blob_new = encrypt_seed(&mnemonic_old, b"new-pw").unwrap();
    let mnemonic_new = decrypt_seed(&blob_new, b"new-pw").unwrap();
    assert_eq!(&mnemonic_old[..], &mnemonic_new[..]);
    // same derived key
    let seed1 = mnemonic_to_seed(&mnemonic_old).unwrap();
    let seed2 = mnemonic_to_seed(&mnemonic_new).unwrap();
    let pk1 = private_key_at(&seed1[..], 0).unwrap();
    let pk2 = private_key_at(&seed2[..], 0).unwrap();
    assert_eq!(&pk1[..], &pk2[..]);
    // old password rejected on new blob
    assert!(decrypt_seed(&blob_new, b"old-pw").is_err());
}

/// wrong password during derive path is caught before any key material is used.
#[test]
fn wrong_password_in_derive_path() {
    let blob = encrypt_seed(M, b"correct").unwrap();
    let result = decrypt_seed(&blob, b"wrong");
    assert!(result.is_err());
}

/// Binding-level guard: import_seed_phrase validates the mnemonic before encrypting.
///
/// NOTE: the binding's *error* path constructs a `JsValue` (via
/// `From<VaultError> for JsValue` → `JsValue::from_str`), which is
/// "not implemented on non-wasm32 targets" and ABORTS the process (SIGABRT) under
/// native `cargo test` rather than returning `Err`. So we cannot assert
/// `import_seed_phrase(b"bad words", ..).is_err()` here. Instead we cover the guard
/// two ways that DO run natively:
///   (a) assert the exact predicate the binding branches on, and
///   (b) exercise the binding's success path (valid mnemonic → decryptable blob).
/// The full error-return shape is exercised by `keyvault-host.test.ts` in Phase B
/// against the real wasm pkg.
#[test]
fn import_rejects_invalid_mnemonic() {
    use ckb_keyvault_wasm::derive::validate_mnemonic;
    // (a) the predicate guarding the binding: `if !validate_mnemonic { return Err(..) }`
    assert!(!validate_mnemonic(b"bad words"), "binding must reject this mnemonic");
    assert!(validate_mnemonic(M), "binding must accept a valid mnemonic");
    // (b) success path runs natively (no JsValue constructed on Ok)
    let blob = ckb_keyvault_wasm::import_seed_phrase(M, b"pw").unwrap();
    let recovered = decrypt_seed(&blob, b"pw").unwrap();
    assert_eq!(&recovered[..], M, "blob plaintext must be the mnemonic bytes");
}
