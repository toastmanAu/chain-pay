/* tslint:disable */
/* eslint-disable */

/**
 * Re-encrypt the mnemonic stored in `blob` from `old` password to `new` password.
 *
 * Returns the new encrypted blob.  The old blob is not mutated.
 */
export function change_password(blob: Uint8Array, old: Uint8Array, _new: Uint8Array): Uint8Array;

/**
 * Derive the 20-byte CKB lock-args (blake160 of compressed secp256k1 pubkey) at
 * `m/44'/309'/0'/0/<index>` from the mnemonic stored in `blob`.
 */
export function derive_lock_args(blob: Uint8Array, password: Uint8Array, index: number): Uint8Array;

/**
 * Decrypt `blob` with `password` and return the mnemonic bytes (UTF-8).
 *
 * The returned bytes must be shown once and then zeroized by the caller.
 */
export function export_seed_phrase(blob: Uint8Array, password: Uint8Array): Uint8Array;

/**
 * Generate a fresh 12-word BIP39 mnemonic, encrypt it with `password`, and
 * return a JS object `{ blob: Uint8Array, mnemonic: Uint8Array }`.
 *
 * The mnemonic is returned **once** for the user to write down.  The caller
 * must zeroize both the password and the mnemonic Uint8Array after display.
 */
export function generate_master_seed(password: Uint8Array): any;

/**
 * Validate and import a BIP39 mnemonic phrase, encrypting it with `password`.
 *
 * Returns the opaque encrypted blob.  Caller must zeroize the password buffer.
 */
export function import_seed_phrase(mnemonic: Uint8Array, password: Uint8Array): Uint8Array;

/**
 * Returns a conservative entropy estimate (bits) for a UTF-8 password.
 * Used by the UI strength meter; does NOT touch any vault.
 */
export function password_entropy_bits(password: Uint8Array): number;

/**
 * Sign a 32-byte `digest` with the key at `m/44'/309'/0'/0/<index>`.
 *
 * Returns a 65-byte recoverable signature (`r || s || v`, v ∈ {0, 1}, low-s).
 * Caller must zeroize the password buffer immediately after the call.
 */
export function sign_digest(blob: Uint8Array, password: Uint8Array, index: number, digest: Uint8Array): Uint8Array;
