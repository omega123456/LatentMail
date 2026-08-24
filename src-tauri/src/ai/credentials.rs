#[cfg(feature = "test-utils")]
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

#[cfg(all(not(feature = "test-utils"), not(debug_assertions)))]
const KEYCHAIN_SERVICE: &str = "com.latentmail.ai-api-key";
#[cfg(all(not(feature = "test-utils"), debug_assertions))]
const KEYCHAIN_SERVICE: &str = "com.latentmail.desktop.dev.ai-api-key";

#[cfg(feature = "test-utils")]
fn keys() -> &'static Mutex<HashMap<String, String>> {
    static KEYS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    KEYS.get_or_init(|| Mutex::new(HashMap::new()))
}
#[cfg(feature = "test-utils")]
pub fn save(account_id: &str, value: &str) -> Result<(), String> {
    keys()
        .lock()
        .map_err(|_| "keychain lock poisoned".to_owned())?
        .insert(account_id.to_owned(), value.to_owned());
    Ok(())
}
#[cfg(feature = "test-utils")]
pub fn load(account_id: &str) -> Result<Option<String>, String> {
    Ok(keys()
        .lock()
        .map_err(|_| "keychain lock poisoned".to_owned())?
        .get(account_id)
        .cloned())
}
#[cfg(feature = "test-utils")]
pub fn clear(account_id: &str) -> Result<(), String> {
    keys()
        .lock()
        .map_err(|_| "keychain lock poisoned".to_owned())?
        .remove(account_id);
    Ok(())
}

#[cfg(not(feature = "test-utils"))]
pub fn save(account_id: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account_id)
        .map_err(|error| error.to_string())?
        .set_password(value)
        .map_err(|error| error.to_string())
}
#[cfg(not(feature = "test-utils"))]
pub fn load(account_id: &str) -> Result<Option<String>, String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, account_id)
        .map_err(|error| error.to_string())?
        .get_password()
    {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
#[cfg(not(feature = "test-utils"))]
pub fn clear(account_id: &str) -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, account_id)
        .map_err(|error| error.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
