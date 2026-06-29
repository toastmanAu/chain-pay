use bip39::Mnemonic;
use hmac::{Hmac, Mac};
use sha2::Sha512;
use k256::ecdsa::{SigningKey, RecoveryId, Signature};
use zeroize::{Zeroize, Zeroizing};
use crate::error::VaultError;

type HmacSha512 = Hmac<Sha512>;

/// BIP44 hardened-index flag
const HARD: u32 = 0x8000_0000;
/// CKB coin-type path: m/44'/309'/0'/0/<index>
/// Elements 0-2 are hardened (purpose', coin_type', account'); 3-4 are normal.
const CKB_PATH: [u32; 5] = [44 + HARD, 309 + HARD, HARD, 0, 0];

// ── BIP39 ────────────────────────────────────────────────────────────────────

/// Returns `true` if `words` is a valid BIP39 mnemonic (UTF-8, correct checksum).
pub fn validate_mnemonic(words: &[u8]) -> bool {
    std::str::from_utf8(words)
        .ok()
        .and_then(|s| Mnemonic::parse(s.trim()).ok())
        .is_some()
}

/// Derive the 64-byte BIP39 seed from `words` with an empty passphrase.
///
/// Returns `VaultError::InvalidMnemonic` for invalid UTF-8 or a bad mnemonic.
pub fn mnemonic_to_seed(words: &[u8]) -> Result<Zeroizing<[u8; 64]>, VaultError> {
    let s = std::str::from_utf8(words).map_err(|_| VaultError::InvalidMnemonic)?;
    let m = Mnemonic::parse(s.trim()).map_err(|_| VaultError::InvalidMnemonic)?;
    let seed = m.to_seed(""); // empty BIP39 passphrase
    Ok(Zeroizing::new(seed))
}

// ── BIP32 / SLIP-0010 ────────────────────────────────────────────────────────

/// BIP32 / SLIP-0010 child key derivation for secp256k1 (hardened + normal).
///
/// Returns `(child_key, child_chain_code)`, both wrapped in `Zeroizing` so the
/// intermediate key material is overwritten when the caller drops them.
fn ckd_priv(
    key: &[u8; 32],
    chain: &[u8; 32],
    index: u32,
) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>) {
    let mut mac = HmacSha512::new_from_slice(chain).expect("HMAC accepts any key length");
    if index >= HARD {
        // Hardened child: HMAC-SHA512(chain, 0x00 || key || index_be)
        mac.update(&[0u8]);
        mac.update(key);
    } else {
        // Normal child: HMAC-SHA512(chain, compressed_pubkey || index_be)
        let sk = SigningKey::from_slice(key).expect("valid private key from CKD parent");
        let pubkey = sk.verifying_key().to_encoded_point(true); // 33-byte compressed
        mac.update(pubkey.as_bytes());
    }
    mac.update(&index.to_be_bytes());
    let mut i = mac.finalize().into_bytes();

    let il: [u8; 32] = i[..32].try_into().expect("split at 32");
    let mut ir = [0u8; 32];
    ir.copy_from_slice(&i[32..]);
    i.as_mut_slice().zeroize(); // HMAC output held IL (a candidate private scalar)

    // child_key = (IL + parent_key) mod n  — via k256 scalar arithmetic
    let child = k256_add_mod_n(&il, key);
    (Zeroizing::new(child), Zeroizing::new(ir))
}

/// Add two 32-byte big-endian scalars mod the secp256k1 order `n`.
///
/// Uses `k256::Scalar` (via `Reduce<U256>`) to stay entirely in safe Rust on
/// wasm32-unknown-unknown.  `Reduce::reduce_bytes` reduces mod n, then
/// `Scalar::add` is also mod n.
fn k256_add_mod_n(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    use k256::elliptic_curve::ops::Reduce;
    use k256::{Scalar, U256};
    // &[u8; 32] → &FieldBytes via the blanket From impl in generic-array 0.14.
    // NOTE: `reduce_bytes` reduces mod n, so an IL ≥ n input is folded into range
    // rather than rejected. Strict BIP32 says "if IL ≥ n, skip to the next index";
    // we deliberately deviate because the probability is ~2^-128 (negligible) and
    // reducing keeps derivation total/infallible for the fixed CKB path.
    let sa = <Scalar as Reduce<U256>>::reduce_bytes(a.into());
    let sb = <Scalar as Reduce<U256>>::reduce_bytes(b.into());
    // FieldBytes → [u8; 32] via From impl in generic-array 0.14
    (sa + sb).to_bytes().into()
}

/// Derive the private key at CKB path `m/44'/309'/0'/0/<index>` from a 64-byte BIP39 seed.
pub fn private_key_at(seed: &[u8], index: u32) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    debug_assert_eq!(seed.len(), 64, "BIP39 seeds are 64 bytes");

    // BIP32 / SLIP-0010 master key generation
    let mut mac = HmacSha512::new_from_slice(b"Bitcoin seed")
        .map_err(|_| VaultError::Derive("hmac init"))?;
    mac.update(seed);
    let mut i = mac.finalize().into_bytes();

    // Master private key (IL) + chain code (IR) — both held in Zeroizing.
    let mut key = Zeroizing::new([0u8; 32]);
    let mut chain = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&i[..32]);
    chain.copy_from_slice(&i[32..]);
    i.as_mut_slice().zeroize(); // master HMAC output held the master private key

    // Walk the derivation path, replacing the last index element with `index`
    let mut path = CKB_PATH;
    path[4] = index;
    for idx in path {
        let (k, c) = ckd_priv(&key, &chain, idx);
        key = k;
        chain = c;
    }
    Ok(key)
}

// ── CKB blake160 ─────────────────────────────────────────────────────────────

/// CKB blake160 of the compressed secp256k1 public key derived from `privkey`.
///
/// blake160 = first 20 bytes of blake2b-256 with `ckb-default-hash` personalization.
/// This is NOT blake2b(outlen=20) — the output length must be 32 and we truncate.
pub fn blake160_pubkey(privkey: &[u8; 32]) -> [u8; 20] {
    let sk = SigningKey::from_slice(privkey).expect("valid private key");
    let pubkey = sk.verifying_key().to_encoded_point(true); // 33-byte compressed
    let mut hasher = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    hasher.update(pubkey.as_bytes());
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    let mut args = [0u8; 20];
    args.copy_from_slice(&out[..20]);
    args
}

// ── secp256k1 recoverable signature ──────────────────────────────────────────

/// Sign `digest` (32 bytes) with `privkey`, returning a 65-byte `r || s || v`
/// recoverable signature.
///
/// `v` ∈ {0, 1}; k256 normalizes to low-s and adjusts the recovery ID accordingly.
pub fn sign_recoverable(privkey: &[u8; 32], digest: &[u8; 32]) -> [u8; 65] {
    let sk = SigningKey::from_slice(privkey).expect("valid private key");
    // sign_prehash_recoverable uses RFC 6979 deterministic k; k256 normalizes to low-s.
    let (sig, recid): (Signature, RecoveryId) = sk
        .sign_prehash_recoverable(digest)
        .expect("sign_prehash_recoverable is infallible for valid keys and 32-byte digests");
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = recid.to_byte();
    out
}

// ── Password entropy meter ────────────────────────────────────────────────────

/// Conservative Shannon-style entropy estimate for a UTF-8 password.
///
/// Counts the observed character classes (lower, upper, digit, symbol) and
/// returns `floor(len × log2(charset_size))`.  Used by the UI strength meter.
pub fn estimate_entropy_bits(password: &[u8]) -> u32 {
    let mut lower = false;
    let mut upper = false;
    let mut digit = false;
    let mut sym = false;
    for &b in password {
        match b {
            b'a'..=b'z' => lower = true,
            b'A'..=b'Z' => upper = true,
            b'0'..=b'9' => digit = true,
            _ => sym = true,
        }
    }
    let space = (lower as u32) * 26
        + (upper as u32) * 26
        + (digit as u32) * 10
        + (sym as u32) * 33;
    if space == 0 {
        return 0;
    }
    ((password.len() as f64) * (space as f64).log2()) as u32
}
