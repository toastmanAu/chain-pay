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
    let params = Params::new(19_456, 2, 1, Some(32))
        .map_err(|_| VaultError::Corrupt("params"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password, salt, key.as_mut_slice())
        .map_err(|_| VaultError::Corrupt("kdf"))?;
    Ok(key)
}

/// Encrypt `seed` (opaque bytes) with `password`.
///
/// Blob layout: `magic(4)="CKVT" | version(1)=1 | argon_salt(16) | nonce(12) | ciphertext(rest)`
///
/// Argon2id params: m=19456 KiB, t=2, p=1 (OWASP baseline), 32-byte output key.
pub fn encrypt_seed(seed: &[u8], password: &[u8]) -> Result<Vec<u8>, VaultError> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom(&mut salt).map_err(|_| VaultError::Corrupt("rng"))?;
    getrandom(&mut nonce_bytes).map_err(|_| VaultError::Corrupt("rng"))?;

    let key = derive_key(password, &salt)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), seed)
        .map_err(|_| VaultError::Corrupt("encrypt"))?;

    let mut blob = Vec::with_capacity(4 + 1 + SALT_LEN + NONCE_LEN + ct.len());
    blob.extend_from_slice(MAGIC);
    blob.push(VERSION);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ct);
    Ok(blob)
}

/// Decrypt a blob produced by `encrypt_seed`.
///
/// Returns `VaultError::WrongPassword` on AEAD tag mismatch (wrong password or corruption).
pub fn decrypt_seed(blob: &[u8], password: &[u8]) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    let header = 4 + 1 + SALT_LEN + NONCE_LEN;
    if blob.len() < header || &blob[0..4] != MAGIC {
        return Err(VaultError::Corrupt("magic"));
    }
    if blob[4] != VERSION {
        return Err(VaultError::Corrupt("version"));
    }
    let salt = &blob[5..5 + SALT_LEN];
    let nonce_bytes = &blob[5 + SALT_LEN..header];
    let ct = &blob[header..];

    let key = derive_key(password, salt)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|_| VaultError::WrongPassword)?; // AEAD tag mismatch => wrong password
    Ok(Zeroizing::new(pt))
}
