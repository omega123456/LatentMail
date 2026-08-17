
use chrono::{Duration, Utc};
use latentmail_lib::avatars::cache::{hash_key, AvatarCache, CacheAnswer, CacheDomain};
use latentmail_lib::storage::{AvatarCacheOutcome, AvatarCacheRecord, AvatarCacheRepository, Storage};

fn cache() -> (AvatarCache, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let cache = AvatarCache::new(storage, directory.path().join("avatar-cache")).unwrap();
    (cache, directory)
}

#[test]
fn root_exposes_the_cache_directory_the_cache_was_built_with() {
    let (cache, directory) = cache();
    assert_eq!(cache.root(), directory.path().join("avatar-cache").as_path());
}

#[test]
fn new_surfaces_a_readable_error_when_the_cache_directory_cannot_be_created() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();

    let blocking_file = directory.path().join("not-a-directory");
    std::fs::write(&blocking_file, b"x").unwrap();
    let root = blocking_file.join("avatar-cache");
    assert!(AvatarCache::new(storage, root).is_err());
}

#[tokio::test]
async fn store_hit_surfaces_a_readable_error_when_the_target_path_cannot_be_written() {
    let (cache, _directory) = cache();

    let error = cache
        .store_hit("nested/missing-dir-key", CacheDomain::Sender, b"bytes")
        .await
        .unwrap_err();
    assert!(!error.is_empty());
}

#[test]
fn new_surfaces_a_readable_error_when_the_account_cache_directory_cannot_be_created() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();

    let root = directory.path().join("avatar-cache");
    std::fs::create_dir_all(&root).unwrap();
    let blocking_file = root.join("accounts");
    std::fs::write(&blocking_file, b"x").unwrap();

    assert!(AvatarCache::new(storage, root).is_err());
}

#[tokio::test]
async fn store_hit_surfaces_a_readable_error_when_the_cache_record_cannot_be_persisted() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let cache = AvatarCache::new(storage.clone(), directory.path().join("avatar-cache")).unwrap();

    {
        let connection = storage.connection().unwrap();
        connection.execute("DROP TABLE avatar_cache", []).unwrap();
        connection
            .execute(
                "CREATE TABLE avatar_cache (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    cache_key TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    image_path TEXT,
                    looked_up_at INTEGER NOT NULL
                )",
                [],
            )
            .unwrap();
    }

    let error = cache
        .store_hit("unindexed-key", CacheDomain::Sender, b"bytes")
        .await
        .unwrap_err();
    assert!(!error.is_empty());
}

#[tokio::test]
async fn store_miss_surfaces_a_readable_error_when_the_cache_record_cannot_be_persisted() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let cache = AvatarCache::new(storage.clone(), directory.path().join("avatar-cache")).unwrap();

    {
        let connection = storage.connection().unwrap();
        connection.execute("DROP TABLE avatar_cache", []).unwrap();
        connection
            .execute(
                "CREATE TABLE avatar_cache (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    cache_key TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    image_path TEXT,
                    looked_up_at INTEGER NOT NULL
                )",
                [],
            )
            .unwrap();
    }

    let error = cache.store_miss("unindexed-miss-key").await.unwrap_err();
    assert!(!error.is_empty());
}

#[tokio::test]
async fn a_record_with_an_out_of_range_timestamp_is_treated_as_expired() {

    let (cache, directory) = cache();
    let db_path = directory.path().join("mail.sqlite");
    let storage = Storage::open(&db_path).unwrap();
    let key = hash_key("out-of-range.example");
    let record = AvatarCacheRecord {
        cache_key: key.clone(),
        outcome: AvatarCacheOutcome::Hit,
        image_path: None,
        looked_up_at: i64::MAX,
    };
    storage
        .run(move |connection| AvatarCacheRepository::upsert(connection, &record))
        .await
        .unwrap();
    assert_eq!(cache.answer(&key, CacheDomain::Sender).await, CacheAnswer::Stale);
}

#[test]
fn hash_key_never_contains_the_raw_identifier() {

    let key = hash_key("kovacsjozsef89@hotmail.com");
    assert!(!key.contains('@'));
    assert!(!key.contains("kovacsjozsef89"));

    assert_eq!(key, hash_key("kovacsjozsef89@hotmail.com"));

    assert_ne!(key, hash_key("other@hotmail.com"));
}

#[tokio::test]
async fn a_cache_miss_answers_stale_and_a_stored_hit_answers_fresh_with_a_path() {
    let (cache, _directory) = cache();
    let key = hash_key("example.com");

    assert_eq!(cache.answer(&key, CacheDomain::Sender).await, CacheAnswer::Stale);

    let path = cache
        .store_hit(&key, CacheDomain::Sender, b"not-really-a-png")
        .await
        .unwrap();
    assert!(path.exists());
    assert_eq!(std::fs::read(&path).unwrap(), b"not-really-a-png");

    match cache.answer(&key, CacheDomain::Sender).await {
        CacheAnswer::Fresh(Some(resolved)) => assert_eq!(resolved, path),
        other => panic!("expected a fresh hit, got {other:?}"),
    }
}

#[tokio::test]
async fn a_stored_miss_answers_fresh_with_no_path_and_writes_no_file() {
    let (cache, directory) = cache();
    let key = hash_key("no-bimi-record.example");

    cache.store_miss(&key).await.unwrap();

    assert_eq!(
        cache.answer(&key, CacheDomain::Sender).await,
        CacheAnswer::Fresh(None)
    );

    let senders_dir = directory.path().join("avatar-cache").join("senders");
    let count = std::fs::read_dir(&senders_dir).unwrap().count();
    assert_eq!(count, 0);
}

async fn seeded(
    cache: &AvatarCache,
    storage_path: &std::path::Path,
    key: &str,
    outcome: AvatarCacheOutcome,
    age: Duration,
) {
    let storage = Storage::open(storage_path).unwrap();
    let record = AvatarCacheRecord {
        cache_key: key.to_owned(),
        outcome,
        image_path: None,
        looked_up_at: (Utc::now() - age).timestamp(),
    };
    storage
        .run(move |connection| AvatarCacheRepository::upsert(connection, &record))
        .await
        .unwrap();
    let _ = cache;
}

#[tokio::test]
async fn sender_positive_hits_expire_after_thirty_days_not_before() {
    let directory = tempfile::tempdir().unwrap();
    let db_path = directory.path().join("mail.sqlite");
    let storage = Storage::open(&db_path).unwrap();
    let cache = AvatarCache::new(storage, directory.path().join("avatar-cache")).unwrap();
    let key = hash_key("fresh-enough.example");

    seeded(
        &cache,
        &db_path,
        &key,
        AvatarCacheOutcome::Hit,
        Duration::days(29),
    )
    .await;
    assert!(matches!(
        cache.answer(&key, CacheDomain::Sender).await,
        CacheAnswer::Fresh(None)
    ));

    let expired_key = hash_key("too-old.example");
    seeded(
        &cache,
        &db_path,
        &expired_key,
        AvatarCacheOutcome::Hit,
        Duration::days(31),
    )
    .await;
    assert_eq!(
        cache.answer(&expired_key, CacheDomain::Sender).await,
        CacheAnswer::Stale
    );
}

#[tokio::test]
async fn sender_negative_misses_expire_after_seven_days_not_before() {
    let directory = tempfile::tempdir().unwrap();
    let db_path = directory.path().join("mail.sqlite");
    let storage = Storage::open(&db_path).unwrap();
    let cache = AvatarCache::new(storage, directory.path().join("avatar-cache")).unwrap();

    let fresh_key = hash_key("checked-recently.example");
    seeded(
        &cache,
        &db_path,
        &fresh_key,
        AvatarCacheOutcome::Miss,
        Duration::days(6),
    )
    .await;
    assert_eq!(
        cache.answer(&fresh_key, CacheDomain::Sender).await,
        CacheAnswer::Fresh(None)
    );

    let expired_key = hash_key("checked-a-while-ago.example");
    seeded(
        &cache,
        &db_path,
        &expired_key,
        AvatarCacheOutcome::Miss,
        Duration::days(8),
    )
    .await;
    assert_eq!(
        cache.answer(&expired_key, CacheDomain::Sender).await,
        CacheAnswer::Stale
    );
}

#[tokio::test]
async fn account_cache_expires_after_one_day_for_both_outcomes() {
    let directory = tempfile::tempdir().unwrap();
    let db_path = directory.path().join("mail.sqlite");
    let storage = Storage::open(&db_path).unwrap();
    let cache = AvatarCache::new(storage, directory.path().join("avatar-cache")).unwrap();

    let fresh_key = hash_key("account-fresh");
    seeded(
        &cache,
        &db_path,
        &fresh_key,
        AvatarCacheOutcome::Hit,
        Duration::hours(23),
    )
    .await;
    assert!(matches!(
        cache.answer(&fresh_key, CacheDomain::Account).await,
        CacheAnswer::Fresh(_)
    ));

    let expired_key = hash_key("account-stale");
    seeded(
        &cache,
        &db_path,
        &expired_key,
        AvatarCacheOutcome::Miss,
        Duration::hours(25),
    )
    .await;
    assert_eq!(
        cache.answer(&expired_key, CacheDomain::Account).await,
        CacheAnswer::Stale
    );
}
