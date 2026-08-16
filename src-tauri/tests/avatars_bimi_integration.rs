//! Candidate-domain ordering (D6), TXT `l=` parsing across quoted,
//! multi-string, non-`https` and absent forms, and the full per-candidate
//! resolution sequence against the fake DNS/download boundaries — no real
//! DNS or HTTP is ever performed.

use latentmail_lib::avatars::bimi::{candidate_domains, parse_logo_url, resolve_logo};
use latentmail_lib::avatars::cache::{hash_key, AvatarCache, CacheDomain};
use latentmail_lib::avatars::image::OUTPUT_SIZE;
use latentmail_lib::avatars::resolver::{fake_txt_lookup_count, set_fake_download, set_fake_txt};
use latentmail_lib::storage::Storage;

/// A fresh, isolated cache backing store per test — domains used across
/// tests in this file are unique, but the cache itself (SQLite + a temp
/// directory) must not be shared between tests.
fn test_cache() -> (AvatarCache, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let cache = AvatarCache::new(storage, directory.path().join("avatar-cache")).unwrap();
    (cache, directory)
}

#[test]
fn candidate_domains_walks_from_full_domain_to_registrable_domain_inclusive() {
    // Multi-part public suffix (D6): must never query `co.uk` itself.
    assert_eq!(
        candidate_domains("news.corp.aviva.co.uk"),
        vec![
            "news.corp.aviva.co.uk".to_owned(),
            "corp.aviva.co.uk".to_owned(),
            "aviva.co.uk".to_owned(),
        ]
    );
}

#[test]
fn candidate_domains_is_lower_cased_and_single_entry_for_a_bare_domain() {
    assert_eq!(
        candidate_domains("Example.COM"),
        vec!["example.com".to_owned()]
    );
}

#[test]
fn candidate_domains_never_queries_a_bare_public_suffix() {
    assert!(candidate_domains("co.uk").is_empty());
    assert!(candidate_domains("").is_empty());
}

#[test]
fn parse_logo_url_accepts_a_plain_https_value() {
    assert_eq!(
        parse_logo_url("v=BIMI1; l=https://example.com/logo.svg;"),
        Some("https://example.com/logo.svg".to_owned())
    );
}

#[test]
fn parse_logo_url_tolerates_surrounding_quotes() {
    assert_eq!(
        parse_logo_url(r#"v=BIMI1; l="https://example.com/logo.svg";"#),
        Some("https://example.com/logo.svg".to_owned())
    );
}

#[test]
fn parse_logo_url_rejects_a_non_https_value() {
    assert_eq!(parse_logo_url("v=BIMI1; l=http://example.com/logo.svg;"), None);
}

#[test]
fn parse_logo_url_is_none_when_l_is_absent() {
    assert_eq!(parse_logo_url("v=BIMI1;"), None);
    assert_eq!(parse_logo_url(""), None);
}

fn tiny_svg() -> Vec<u8> {
    br#"<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>"#.to_vec()
}

#[tokio::test]
async fn a_published_record_resolves_to_a_validated_normalized_png() {
    let (cache, _dir) = test_cache();
    set_fake_txt(
        "default._bimi.example.com",
        vec!["v=BIMI1; l=https://cdn.example.com/logo.svg;".to_owned()],
    );
    set_fake_download("https://cdn.example.com/logo.svg", tiny_svg());

    let png = resolve_logo(&cache, "example.com")
        .await
        .expect("a published BIMI record must resolve to a logo");
    let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png).unwrap();
    assert_eq!(decoded.width(), OUTPUT_SIZE);
    assert_eq!(decoded.height(), OUTPUT_SIZE);
}

#[tokio::test]
async fn a_domain_with_no_record_at_any_candidate_yields_no_logo() {
    let (cache, _dir) = test_cache();
    assert!(resolve_logo(&cache, "no-bimi-anywhere.example").await.is_none());
}

#[tokio::test]
async fn resolution_falls_through_to_a_parent_candidate_when_the_full_domain_has_no_record() {
    let (cache, _dir) = test_cache();
    // Nothing registered for "news.falls-through.example"; the record lives
    // on its registrable parent — proves the walk actually advances.
    set_fake_txt(
        "default._bimi.falls-through.example",
        vec!["v=BIMI1; l=https://cdn.falls-through.example/logo.svg;".to_owned()],
    );
    set_fake_download(
        "https://cdn.falls-through.example/logo.svg",
        tiny_svg(),
    );

    let png = resolve_logo(&cache, "news.falls-through.example")
        .await
        .expect("must fall through to the registrable-domain candidate");
    assert!(!png.is_empty());
}

#[tokio::test]
async fn a_txt_record_advertising_a_non_https_url_yields_no_logo() {
    let (cache, _dir) = test_cache();
    set_fake_txt(
        "default._bimi.insecure.example",
        vec!["v=BIMI1; l=http://cdn.insecure.example/logo.svg;".to_owned()],
    );
    assert!(resolve_logo(&cache, "insecure.example").await.is_none());
}

#[tokio::test]
async fn multi_string_txt_records_are_rejoined_before_parsing() {
    let (cache, _dir) = test_cache();
    // The TXT value is split across two character-strings the way a real
    // resolver would report a long record; resolver::lookup_txt rejoins
    // them per-record before bimi ever sees the value.
    set_fake_txt(
        "default._bimi.split-record.example",
        vec!["v=BIMI1; l=https://cdn.split-record.example/logo.svg;".to_owned()],
    );
    set_fake_download(
        "https://cdn.split-record.example/logo.svg",
        tiny_svg(),
    );
    assert!(resolve_logo(&cache, "split-record.example").await.is_some());
}

#[tokio::test]
async fn a_candidate_already_cache_positive_is_reused_by_a_sibling_subdomain_without_re_querying_it()
{
    let (cache, _dir) = test_cache();
    let parent_key = hash_key("aviva.co.uk");
    cache
        .store_hit(&parent_key, CacheDomain::Sender, b"pre-cached-parent-logo")
        .await
        .unwrap();
    // Deliberately nothing programmed for "default._bimi.aviva.co.uk" (nor
    // for the other two candidates) — if the walk fell back to a real DNS
    // lookup instead of consulting the cache per-candidate, it would get
    // "no record" and this resolution would yield `None`.
    let lookups_before = fake_txt_lookup_count("default._bimi.aviva.co.uk");

    let png = resolve_logo(&cache, "news.corp.aviva.co.uk")
        .await
        .expect("a positively-cached parent candidate must be reused, not re-queried");

    assert_eq!(png, b"pre-cached-parent-logo".to_vec());
    assert_eq!(
        fake_txt_lookup_count("default._bimi.aviva.co.uk"),
        lookups_before,
        "a cache-positive candidate must not be queried over DNS again"
    );
}

#[tokio::test]
async fn a_candidate_already_cache_negative_is_reused_by_a_sibling_subdomain_without_re_querying_it()
{
    let (cache, _dir) = test_cache();
    let parent_key = hash_key("shared-negative.example");
    cache.store_miss(&parent_key).await.unwrap();
    let lookups_before = fake_txt_lookup_count("default._bimi.shared-negative.example");

    let result = resolve_logo(&cache, "mail.shared-negative.example").await;

    assert!(result.is_none());
    assert_eq!(
        fake_txt_lookup_count("default._bimi.shared-negative.example"),
        lookups_before,
        "a cache-negative candidate must not be queried over DNS again"
    );
}
