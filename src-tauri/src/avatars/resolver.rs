//! Isolates the two machine-facing boundaries avatar resolution touches —
//! the operating system's DNS resolver and simultaneous network work — and
//! bounds both (D4, D5).
//!
//! DNS lookup is a machine-global boundary, so it follows the exact
//! real-versus-fake compilation pattern `auth::{save_refresh_token,
//! load_refresh_token, open_consent}` already uses: a real implementation
//! gated on the ordinary build, and an in-memory fake gated on
//! `feature = "test-utils"`. No test ever performs a real DNS lookup.

use std::{collections::HashMap, sync::Arc, time::Duration};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

/// The DNS lookup time budget (D15). A lookup that doesn't answer within
/// this window is treated exactly like "no record" — silent, no error
/// surfaced to the caller.
pub const DNS_LOOKUP_BUDGET: Duration = Duration::from_secs(5);
/// The asset download time budget (D15).
pub const DOWNLOAD_BUDGET: Duration = Duration::from_secs(10);
/// The maximum number of avatar resolutions allowed to run at once, across
/// every domain and account (D4/D15).
pub const MAX_SIMULTANEOUS_RESOLUTIONS: usize = 4;

/// Bounds simultaneous resolution work (D4) and collapses concurrent
/// requests for the same key onto a single in-flight resolution. Callers
/// that want the collapsing property must re-check the cache immediately
/// after acquiring a key guard — a concurrent winner may have already
/// populated it while this caller was waiting.
///
/// ponytail: the per-key lock map only ever grows (entries are never
/// evicted); avatar keys are a bounded set (distinct domains/accounts seen
/// this process lifetime), so this is fine at this scale — add eviction if
/// a single long-lived process ever resolves enough distinct domains for
/// the map itself to matter.
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

    /// Serializes concurrent callers for `key` onto one owner at a time
    /// (D4's per-domain in-flight collapsing).
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

    /// Bounds simultaneous network operations across all keys to
    /// [`MAX_SIMULTANEOUS_RESOLUTIONS`] (D4).
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

/// Looks up TXT records for `domain`, already re-joined per-record when a
/// record was split across multiple TXT character-strings. Never errors:
/// NXDOMAIN, no data, a real lookup failure and a budget timeout are all
/// indistinguishable "no records" to every caller, matching BIMI's
/// silent-fallback rule.
#[cfg(not(feature = "test-utils"))]
pub async fn lookup_txt(domain: &str) -> Vec<String> {
    use hickory_resolver::proto::rr::{RData, RecordType};

    let Some(resolver) = system_resolver() else {
        return Vec::new();
    };
    let fqdn = format!("{domain}.");
    let Ok(Ok(lookup)) = tokio::time::timeout(
        DNS_LOOKUP_BUDGET,
        resolver.lookup(fqdn, RecordType::TXT),
    )
    .await
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

/// The system resolver, built once and reused — `TokioResolver::builder_tokio`
/// reads OS-level DNS configuration (D5: the OS resolver only, never a
/// hardcoded third-party fallback), which is unnecessary work to repeat on
/// every lookup.
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

/// Downloads `url` under [`DOWNLOAD_BUDGET`], refusing anything not
/// `https`, anything that fails, and anything exceeding
/// [`super::image::MAX_DOWNLOAD_BYTES`]. Shared by the BIMI logo pipeline
/// and the account-photograph pipeline — both download exactly one asset
/// from one URL, differing only in where that URL comes from. Outbound HTTP
/// is a machine-facing boundary exactly like DNS, so it follows the same
/// real-versus-fake split; no test ever performs a real HTTP request.
#[cfg(not(feature = "test-utils"))]
pub async fn download(url: &str) -> Option<Vec<u8>> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let response = tokio::time::timeout(DOWNLOAD_BUDGET, reqwest::Client::new().get(parsed).send())
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

/// Test-only: programs the fake downloader's response bytes for `url`. A
/// `url` with no programmed answer (or a non-`https` `url`) always fails —
/// mirroring the production "anything not https, anything that fails" rule.
#[cfg(feature = "test-utils")]
pub fn set_fake_download(url: &str, bytes: Vec<u8>) {
    fake_downloads()
        .lock()
        .expect("fake download lock poisoned")
        .insert(url.to_owned(), FakeDownload::Bytes(bytes));
}

/// Test-only: programs the fake downloader to answer `url` only after
/// `delay` — used to exercise [`DOWNLOAD_BUDGET`] under a paused clock.
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
    /// Answers after `Duration`, so a test can exercise the budget timeout
    /// under a paused tokio clock without any real wall-clock wait.
    Delayed(Vec<String>, Duration),
}

#[cfg(feature = "test-utils")]
fn fake_dns() -> &'static std::sync::Mutex<HashMap<String, FakeAnswer>> {
    static STORE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, FakeAnswer>>> =
        std::sync::OnceLock::new();
    STORE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Test-only: programs the fake resolver's answer for `domain`.
#[cfg(feature = "test-utils")]
pub fn set_fake_txt(domain: &str, records: Vec<String>) {
    fake_dns()
        .lock()
        .expect("fake DNS lock poisoned")
        .insert(domain.to_owned(), FakeAnswer::Records(records));
}

/// Test-only: programs the fake resolver to answer `domain` only after
/// `delay` — used to exercise [`DNS_LOOKUP_BUDGET`] under a paused clock.
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

/// Test-only: how many times [`lookup_txt`] has been called for `domain`
/// this process — lets a test assert a per-candidate cache hit really did
/// short-circuit the DNS walk instead of just happening to still resolve.
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
