#[cfg(feature = "test-utils")]
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

pub struct Keychain {
    service: &'static str,
}

impl Keychain {
    pub const fn new(service: &'static str) -> Self {
        Self { service: service }
    }
}

#[cfg(not(feature = "test-utils"))]
impl Keychain {
    fn entry(&self, account_id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(self.service, account_id).map_err(|error| error.to_string())
    }

    pub fn save(&self, account_id: &str, secret: &str) -> Result<(), String> {
        self.entry(account_id)?
            .set_password(secret)
            .map_err(|error| error.to_string())
    }

    pub fn load(&self, account_id: &str) -> Result<Option<String>, String> {
        match self.entry(account_id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn clear(&self, account_id: &str) -> Result<(), String> {
        match self.entry(account_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(feature = "test-utils")]
#[derive(Hash, Eq, PartialEq)]
struct KeychainKey {
    service: &'static str,
    account_id: String,
}

#[cfg(feature = "test-utils")]
type FakeSecrets = HashMap<KeychainKey, String>;

#[cfg(feature = "test-utils")]
fn fake_secrets() -> Result<std::sync::MutexGuard<'static, FakeSecrets>, String> {
    static SECRETS: OnceLock<Mutex<FakeSecrets>> = OnceLock::new();
    SECRETS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "keychain lock poisoned".to_owned())
}

#[cfg(feature = "test-utils")]
impl Keychain {
    fn key(&self, account_id: &str) -> KeychainKey {
        KeychainKey {
            service: self.service,
            account_id: account_id.to_owned(),
        }
    }

    pub fn save(&self, account_id: &str, secret: &str) -> Result<(), String> {
        fake_secrets()?.insert(self.key(account_id), secret.to_owned());
        Ok(())
    }

    pub fn load(&self, account_id: &str) -> Result<Option<String>, String> {
        Ok(fake_secrets()?.get(&self.key(account_id)).cloned())
    }

    pub fn clear(&self, account_id: &str) -> Result<(), String> {
        fake_secrets()?.remove(&self.key(account_id));
        Ok(())
    }
}
