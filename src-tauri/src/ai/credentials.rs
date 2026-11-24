use crate::keychain::Keychain;

#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "com.latentmail.ai-api-key";
#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE: &str = "com.latentmail.desktop.dev.ai-api-key";

const API_KEYS: Keychain = Keychain::new(KEYCHAIN_SERVICE);

pub fn save(account_id: &str, api_key: &str) -> Result<(), String> {
    API_KEYS.save(account_id, api_key)
}

pub fn load(account_id: &str) -> Result<Option<String>, String> {
    API_KEYS.load(account_id)
}

pub fn clear(account_id: &str) -> Result<(), String> {
    API_KEYS.clear(account_id)
}
