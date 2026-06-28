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
