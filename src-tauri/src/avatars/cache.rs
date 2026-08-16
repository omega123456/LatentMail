//! The single source of truth for what is cached, where, and until when
//! (D2). Image bytes live as files on disk under the avatar cache root;
//! cache *metadata* — outcome and lookup timestamp, for hits and misses
//! alike — lives in SQLite via [`AvatarCacheRepository`]. Expiry is always
//! derived from outcome + age through `chrono`, never stored and never
//! hand-rolled arithmetic.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};

use crate::storage::{AvatarCacheOutcome, AvatarCacheRecord, AvatarCacheRepository, Storage};

/// A successful sender-logo resolution is reused for this long (D3).
pub const SENDER_POSITIVE_LIFETIME: Duration = Duration::days(30);
/// A domain proven to have no usable BIMI record is remembered as a miss
/// for this long (D3).
pub const SENDER_NEGATIVE_LIFETIME: Duration = Duration::days(7);
/// An account profile photograph — hit or miss alike — is reused for this
/// long (D3).
pub const ACCOUNT_LIFETIME: Duration = Duration::days(1);

/// Which pipeline a cache entry belongs to — determines both its on-disk
/// subdirectory and its lifetime table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheDomain {
    Sender,
    Account,
}
impl CacheDomain {
    fn subdir(self) -> &'static str {
        match self {
            Self::Sender => "senders",
            Self::Account => "accounts",
        }
    }
    fn lifetime(self, outcome: AvatarCacheOutcome) -> Duration {
        match (self, outcome) {
            (Self::Sender, AvatarCacheOutcome::Hit) => SENDER_POSITIVE_LIFETIME,
            (Self::Sender, AvatarCacheOutcome::Miss) => SENDER_NEGATIVE_LIFETIME,
            (Self::Account, _) => ACCOUNT_LIFETIME,
        }
    }
}

/// The answer to "what do we already know about this key". `Fresh` means no
/// resolution should run; `Stale` means the caller should schedule one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheAnswer {
    /// A cached hit (an image path) or a cached, still-valid miss (`None`).
    Fresh(Option<PathBuf>),
    /// No record, or one that has expired.
    Stale,
}

/// Hashes `raw` — a domain or an account/email identifier — into a
/// filesystem-safe, non-reversible key. Account identifiers are email
/// addresses and must never appear literally in a filename or cache key.
pub fn hash_key(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[derive(Clone)]
pub struct AvatarCache {
    storage: Storage,
    root: PathBuf,
}

impl AvatarCache {
    /// `root` is the avatar cache directory under the application data
    /// directory (`avatar-cache/`); both subdirectories are created eagerly
    /// so every later write is a plain file write with no directory dance.
    pub fn new(storage: Storage, root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(root.join(CacheDomain::Sender.subdir()))
            .map_err(|error| error.to_string())?;
        std::fs::create_dir_all(root.join(CacheDomain::Account.subdir()))
            .map_err(|error| error.to_string())?;
        Ok(Self { storage, root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Answers a cache lookup without ever touching the network — a
    /// cache-miss query answers immediately, and resolution is always a
    /// separate, later step.
    pub async fn answer(&self, cache_key: &str, domain: CacheDomain) -> CacheAnswer {
        let key = cache_key.to_owned();
        let record = self
            .storage
            .run(move |connection| AvatarCacheRepository::get(connection, &key))
            .await
            .ok()
            .flatten();
        let Some(record) = record else {
            return CacheAnswer::Stale;
        };
        if is_expired(&record, domain, Utc::now()) {
            return CacheAnswer::Stale;
        }
        match record.outcome {
            AvatarCacheOutcome::Hit => {
                CacheAnswer::Fresh(record.image_path.map(|relative| self.root.join(relative)))
            }
            AvatarCacheOutcome::Miss => CacheAnswer::Fresh(None),
        }
    }

    /// Writes a validated, normalized PNG to disk and records the hit.
    /// Returns the absolute path the caller can hand back over IPC.
    pub async fn store_hit(
        &self,
        cache_key: &str,
        domain: CacheDomain,
        png_bytes: &[u8],
    ) -> Result<PathBuf, String> {
        let relative = format!("{}/{}.png", domain.subdir(), cache_key);
        let absolute = self.root.join(&relative);
        std::fs::write(&absolute, png_bytes).map_err(|error| error.to_string())?;
        let record = AvatarCacheRecord {
            cache_key: cache_key.to_owned(),
            outcome: AvatarCacheOutcome::Hit,
            image_path: Some(relative),
            looked_up_at: Utc::now().timestamp(),
        };
        self.storage
            .run(move |connection| AvatarCacheRepository::upsert(connection, &record))
            .await
            .map_err(|error| error.to_string())?;
        Ok(absolute)
    }

    /// Records a negative result — no file is written, only the metadata
    /// row that makes the negative cache work.
    pub async fn store_miss(&self, cache_key: &str) -> Result<(), String> {
        let record = AvatarCacheRecord {
            cache_key: cache_key.to_owned(),
            outcome: AvatarCacheOutcome::Miss,
            image_path: None,
            looked_up_at: Utc::now().timestamp(),
        };
        self.storage
            .run(move |connection| AvatarCacheRepository::upsert(connection, &record))
            .await
            .map_err(|error| error.to_string())
    }
}

fn is_expired(record: &AvatarCacheRecord, domain: CacheDomain, now: DateTime<Utc>) -> bool {
    let Some(looked_up_at) = DateTime::from_timestamp(record.looked_up_at, 0) else {
        return true;
    };
    now.signed_duration_since(looked_up_at) > domain.lifetime(record.outcome)
}
