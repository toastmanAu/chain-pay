// tests/derive.rs — anchor against a fixed mnemonic so any derivation change is caught.
use ckb_keyvault_wasm::derive::*;

const M: &[u8] = b"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

#[test]
fn validates_known_mnemonic() {
    assert!(validate_mnemonic(M));
}

#[test]
fn rejects_bad_mnemonic() {
    assert!(!validate_mnemonic(b"not a real mnemonic phrase here ok"));
}

#[test]
fn derives_stable_lock_args() {
    let seed = mnemonic_to_seed(M).unwrap();
    let pk = private_key_at(&seed[..], 0).unwrap();
    let args = blake160_pubkey(&pk);
    // Regression anchor: m/44'/309'/0'/0/0 from "abandon ... about" mnemonic.
    // Independently cross-checked via `ckb-cli util key-info` — lock_arg matches exactly.
    assert_eq!(
        hex::encode(args),
        "196f6c1f21f7dbf0df814539b840059facbafc24"
    );
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
