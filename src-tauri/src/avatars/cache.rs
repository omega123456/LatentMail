use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};

use crate::storage::{AvatarCacheOutcome, AvatarCacheRecord, AvatarCacheRepository, Storage};

pub const SENDER_POSITIVE_LIFETIME: Duration = Duration::days(30);
pub const SENDER_NEGATIVE_LIFETIME: Duration = Duration::days(7);
pub const ACCOUNT_LIFETIME: Duration = Duration::days(1);

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheAnswer {
    Fresh(Option<PathBuf>),
    Stale,
}

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
