use std::{collections::HashMap, sync::Arc, time::Duration};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

pub const DNS_LOOKUP_BUDGET: Duration = Duration::from_secs(5);
pub const DOWNLOAD_BUDGET: Duration = Duration::from_secs(10);
pub const MAX_SIMULTANEOUS_RESOLUTIONS: usize = 4;

pub struct Scheduler {
    permits: Arc<Semaphore>,
    locks: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            permits: Arc::new(Semaphore::new(MAX_SIMULTANEOUS_RESOLUTIONS)),
            locks: AsyncMutex::new(HashMap::new()),
        }
    }

    pub async fn key_guard(&self, key: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().await;
            Arc::clone(
                locks
                    .entry(key.to_owned())
                    .or_insert_with(|| Arc::new(AsyncMutex::new(()))),
            )
        };
        lock.lock_owned().await
    }

    pub async fn acquire_permit(&self) -> OwnedSemaphorePermit {
        Arc::clone(&self.permits)
            .acquire_owned()
            .await
            .expect("resolver semaphore is never closed")
    }
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(not(feature = "test-utils"))]
pub async fn lookup_txt(domain: &str) -> Vec<String> {
    use hickory_resolver::proto::rr::{RData, RecordType};

    let Some(resolver) = system_resolver() else {
        return Vec::new();
    };
    let fqdn = format!("{domain}.");
    let Ok(Ok(lookup)) =
        tokio::time::timeout(DNS_LOOKUP_BUDGET, resolver.lookup(fqdn, RecordType::TXT)).await
    else {
        return Vec::new();
    };
    lookup
        .answers()
        .iter()
        .filter_map(|record| match &record.data {
            RData::TXT(txt) => Some(
                txt.txt_data
                    .iter()
                    .map(|chunk| String::from_utf8_lossy(chunk))
                    .collect::<String>(),
            ),
            _ => None,
        })
        .collect()
}

#[cfg(not(feature = "test-utils"))]
fn system_resolver() -> Option<&'static hickory_resolver::TokioResolver> {
    static RESOLVER: std::sync::OnceLock<Option<hickory_resolver::TokioResolver>> =
        std::sync::OnceLock::new();
    RESOLVER
        .get_or_init(|| {
            hickory_resolver::TokioResolver::builder_tokio()
                .ok()
                .and_then(|builder| builder.build().ok())
        })
        .as_ref()
}

#[cfg(not(feature = "test-utils"))]
pub async fn download(url: &str) -> Option<Vec<u8>> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let response = tokio::time::timeout(DOWNLOAD_BUDGET, crate::http_client().get(parsed).send())
        .await
        .ok()?
        .ok()?;
    let response = response.error_for_status().ok()?;
    let bytes = tokio::time::timeout(DOWNLOAD_BUDGET, response.bytes())
        .await
        .ok()?
        .ok()?;
    (bytes.len() <= super::image::MAX_DOWNLOAD_BYTES).then(|| bytes.to_vec())
}

#[cfg(feature = "test-utils")]
#[derive(Clone)]
enum FakeDownload {
    Bytes(Vec<u8>),
    Delayed(Vec<u8>, Duration),
}

#[cfg(feature = "test-utils")]
fn fake_downloads() -> &'static std::sync::Mutex<HashMap<String, FakeDownload>> {
    static STORE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, FakeDownload>>> =
        std::sync::OnceLock::new();
    STORE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[cfg(feature = "test-utils")]
pub fn set_fake_download(url: &str, bytes: Vec<u8>) {
    fake_downloads()
        .lock()
        .expect("fake download lock poisoned")
        .insert(url.to_owned(), FakeDownload::Bytes(bytes));
}

#[cfg(feature = "test-utils")]
pub fn set_fake_download_delayed(url: &str, bytes: Vec<u8>, delay: Duration) {
    fake_downloads()
        .lock()
        .expect("fake download lock poisoned")
        .insert(url.to_owned(), FakeDownload::Delayed(bytes, delay));
}

#[cfg(feature = "test-utils")]
pub async fn download(url: &str) -> Option<Vec<u8>> {
    if !url.starts_with("https://") {
        return None;
    }
    let answer = fake_downloads()
        .lock()
        .expect("fake download lock poisoned")
        .get(url)
        .cloned()?;
    let bytes = match answer {
        FakeDownload::Bytes(bytes) => bytes,
        FakeDownload::Delayed(bytes, delay) => {
            match tokio::time::timeout(DOWNLOAD_BUDGET, tokio::time::sleep(delay)).await {
                Ok(()) => bytes,
                Err(_) => return None,
            }
        }
    };
    (bytes.len() <= super::image::MAX_DOWNLOAD_BYTES).then_some(bytes)
}

#[cfg(feature = "test-utils")]
#[derive(Clone)]
enum FakeAnswer {
    Records(Vec<String>),

    Delayed(Vec<String>, Duration),
}

#[cfg(feature = "test-utils")]
fn fake_dns() -> &'static std::sync::Mutex<HashMap<String, FakeAnswer>> {
    static STORE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, FakeAnswer>>> =
        std::sync::OnceLock::new();
    STORE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[cfg(feature = "test-utils")]
pub fn set_fake_txt(domain: &str, records: Vec<String>) {
    fake_dns()
        .lock()
        .expect("fake DNS lock poisoned")
        .insert(domain.to_owned(), FakeAnswer::Records(records));
}

#[cfg(feature = "test-utils")]
pub fn set_fake_txt_delayed(domain: &str, records: Vec<String>, delay: Duration) {
    fake_dns()
        .lock()
        .expect("fake DNS lock poisoned")
        .insert(domain.to_owned(), FakeAnswer::Delayed(records, delay));
}

#[cfg(feature = "test-utils")]
fn fake_txt_lookup_counts() -> &'static std::sync::Mutex<HashMap<String, usize>> {
    static STORE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, usize>>> =
        std::sync::OnceLock::new();
    STORE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[cfg(feature = "test-utils")]
pub fn fake_txt_lookup_count(domain: &str) -> usize {
    fake_txt_lookup_counts()
        .lock()
        .expect("fake DNS lookup-count lock poisoned")
        .get(domain)
        .copied()
        .unwrap_or(0)
}

#[cfg(feature = "test-utils")]
pub async fn lookup_txt(domain: &str) -> Vec<String> {
    *fake_txt_lookup_counts()
        .lock()
        .expect("fake DNS lookup-count lock poisoned")
        .entry(domain.to_owned())
        .or_insert(0) += 1;
    let answer = fake_dns()
        .lock()
        .expect("fake DNS lock poisoned")
        .get(domain)
        .cloned();
    match answer {
        Some(FakeAnswer::Records(records)) => records,
        Some(FakeAnswer::Delayed(records, delay)) => {
            match tokio::time::timeout(DNS_LOOKUP_BUDGET, tokio::time::sleep(delay)).await {
                Ok(()) => records,
                Err(_) => Vec::new(),
            }
        }
        None => Vec::new(),
    }
}
