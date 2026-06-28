mod error;
pub mod vault;   // added in A2
mod derive;  // added in A3

use wasm_bindgen::prelude::*;

/// Returns a rough strength estimate (entropy bits) for a UTF-8 password.
/// Mirrors quantum-purse `password_checker`; the UI uses it for a meter and a
/// minimum-strength gate. Does NOT touch any vault.
#[wasm_bindgen]
pub fn password_entropy_bits(password: &[u8]) -> u32 {
    derive::estimate_entropy_bits(password)
}
