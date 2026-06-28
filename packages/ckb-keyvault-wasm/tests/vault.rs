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
    assert_ne!(a, b); // random salt+nonce => different ciphertext
}
