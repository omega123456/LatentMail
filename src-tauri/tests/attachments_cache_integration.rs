use latentmail_lib::attachments::{cache::AttachmentCache, seed_cache};
use latentmail_lib::gmail::{AttachmentPart, GmailClient};
use wiremock::MockServer;

#[test]
fn write_bytes_lays_out_files_per_account_and_message_and_reports_size() {
    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();

    let cached = cache
        .write_bytes("account", "m1", "a1", "notes.txt", "text/plain", b"hello world")
        .unwrap();

    assert_eq!(cached.size, 11);
    assert_eq!(cached.cache_path, cached.display_path);
    assert!(cached
        .cache_path
        .starts_with(directory.path().join("cache").join("account").join("m1")));
    assert_eq!(std::fs::read(&cached.cache_path).unwrap(), b"hello world");
}

#[test]
fn lookup_reuses_a_previously_written_entry_without_touching_its_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    cache
        .write_bytes("account", "m1", "a1", "notes.txt", "text/plain", b"hello")
        .unwrap();

    let found = cache
        .lookup("account", "m1", "a1", "notes.txt", "text/plain")
        .expect("a written entry must be found by lookup");

    assert_eq!(found.size, 5);
    assert_eq!(std::fs::read(&found.cache_path).unwrap(), b"hello");
}

#[test]
fn write_bytes_accepts_a_gmail_length_attachment_id_the_filesystem_would_reject() {
    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    let attachment_id = "ANGjdJ".repeat(120);

    let cached = cache
        .write_bytes("account", "m1", &attachment_id, "notes.txt", "text/plain", b"hello")
        .unwrap();

    assert!(cached.cache_path.file_name().unwrap().len() < 255);
    assert_eq!(
        cache
            .lookup("account", "m1", &attachment_id, "notes.txt", "text/plain")
            .map(|found| found.cache_path),
        Some(cached.cache_path)
    );
}

#[tokio::test]
async fn ensure_issues_no_gmail_request_when_the_attachment_is_already_cached() {
    let server = MockServer::start().await;
    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    cache
        .write_bytes(
            "account",
            "m1",
            "a1",
            "report.pdf",
            "application/pdf",
            b"already cached bytes",
        )
        .unwrap();
    let client = GmailClient::with_base_url("token", server.uri());

    let cached = cache
        .ensure(&client, "account", "m1", "a1", "report.pdf", "application/pdf")
        .await
        .unwrap();

    assert_eq!(
        std::fs::read(&cached.cache_path).unwrap(),
        b"already cached bytes"
    );
    assert!(
        server.received_requests().await.unwrap().is_empty(),
        "a cache hit must not contact Gmail"
    );
}

#[test]
fn lookup_misses_for_an_attachment_that_was_never_cached() {
    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();

    assert!(cache
        .lookup("account", "m1", "missing", "notes.txt", "text/plain")
        .is_none());
}

#[test]
fn sweep_evicts_least_recently_used_entries_down_to_the_ceiling() {
    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();

    cache
        .write_bytes(
            "account",
            "m1",
            "old",
            "old.bin",
            "application/octet-stream",
            &[0u8; 100],
        )
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    cache
        .write_bytes(
            "account",
            "m1",
            "new",
            "new.bin",
            "application/octet-stream",
            &[0u8; 100],
        )
        .unwrap();

    cache.sweep(150).unwrap();

    assert!(
        cache
            .lookup("account", "m1", "old", "old.bin", "application/octet-stream")
            .is_none(),
        "the least recently written entry must be evicted first"
    );
    assert!(cache
        .lookup("account", "m1", "new", "new.bin", "application/octet-stream")
        .is_some());
}

#[test]
fn sweep_is_a_no_op_when_total_size_is_within_the_ceiling() {
    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    cache
        .write_bytes("account", "m1", "a", "a.bin", "application/octet-stream", &[0u8; 10])
        .unwrap();

    cache.sweep(1024).unwrap();

    assert!(cache
        .lookup("account", "m1", "a", "a.bin", "application/octet-stream")
        .is_some());
}

#[test]
fn touching_an_entry_on_lookup_protects_it_from_the_next_sweep() {
    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();

    cache
        .write_bytes("account", "m1", "a", "a.bin", "application/octet-stream", &[0u8; 100])
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    cache
        .write_bytes("account", "m1", "b", "b.bin", "application/octet-stream", &[0u8; 100])
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));

    assert!(cache
        .lookup("account", "m1", "a", "a.bin", "application/octet-stream")
        .is_some());

    cache.sweep(150).unwrap();

    assert!(
        cache
            .lookup("account", "m1", "a", "a.bin", "application/octet-stream")
            .is_some(),
        "a recently touched entry must survive the sweep over an untouched, older-written one"
    );
    assert!(cache
        .lookup("account", "m1", "b", "b.bin", "application/octet-stream")
        .is_none());
}

#[test]
fn seed_cache_writes_inline_recovered_bytes_under_the_reserved_prefix() {
    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    let parts = vec![
        AttachmentPart {
            attachment_id: "latentmail-inline-pos-0".into(),
            filename: "photo.jpg".into(),
            mime_type: "image/jpeg".into(),
            size: 5,
            inline_bytes: Some(b"photo".to_vec()),
        },
        AttachmentPart {
            attachment_id: "gmail-att-1".into(),
            filename: "doc.pdf".into(),
            mime_type: "application/pdf".into(),
            size: 0,
            inline_bytes: None,
        },
    ];

    seed_cache(&cache, "account", "m1", &parts);

    let seeded = cache
        .lookup(
            "account",
            "m1",
            "latentmail-inline-pos-0",
            "photo.jpg",
            "image/jpeg",
        )
        .expect("inline-recovered bytes must be written to the cache at parse time");
    assert_eq!(std::fs::read(&seeded.cache_path).unwrap(), b"photo");

    assert!(
        cache
            .lookup("account", "m1", "gmail-att-1", "doc.pdf", "application/pdf")
            .is_none(),
        "a part without inline bytes must not be written to the cache by seeding"
    );
}

#[test]
fn a_tiff_attachment_gets_a_rasterized_display_path_distinct_from_its_cache_path() {
    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    let tiff_bytes = tiny_tiff();

    let cached = cache
        .write_bytes("account", "m1", "a1", "scan.tiff", "image/tiff", &tiff_bytes)
        .unwrap();

    assert_ne!(cached.cache_path, cached.display_path);
    assert!(cached.display_path.extension().is_some_and(|ext| ext == "png"));
    assert!(std::fs::read(&cached.display_path).unwrap().starts_with(b"\x89PNG"));

    let looked_up = cache
        .lookup("account", "m1", "a1", "scan.tiff", "image/tiff")
        .expect("a written tiff entry must be found by lookup");
    assert_eq!(looked_up.display_path, cached.display_path);
}

#[test]
fn a_tiff_that_fails_to_rasterize_falls_back_silently_to_its_own_cache_path() {
    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();

    let cached = cache
        .write_bytes("account", "m1", "bad", "corrupt.tiff", "image/tiff", b"not a real tiff")
        .unwrap();

    assert_eq!(cached.cache_path, cached.display_path);

    let looked_up = cache
        .lookup("account", "m1", "bad", "corrupt.tiff", "image/tiff")
        .expect("the raw bytes must still be cached even when rasterization fails");
    assert_eq!(looked_up.display_path, looked_up.cache_path);
}

fn tiny_tiff() -> Vec<u8> {
    let image = image::RgbImage::from_pixel(2, 2, image::Rgb([10, 20, 30]));
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Tiff)
        .unwrap();
    bytes
}
