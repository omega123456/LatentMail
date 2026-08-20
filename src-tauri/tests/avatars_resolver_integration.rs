use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

use latentmail_lib::avatars::resolver::{
    download, lookup_txt, set_fake_download_delayed, set_fake_txt_delayed, Scheduler,
    DNS_LOOKUP_BUDGET, DOWNLOAD_BUDGET, MAX_SIMULTANEOUS_RESOLUTIONS,
};

#[tokio::test]
async fn default_scheduler_behaves_like_new() {
    let scheduler = Scheduler::default();
    let _permit = scheduler.acquire_permit().await;
    let _guard = scheduler.key_guard("default-check").await;
}

#[tokio::test]
async fn simultaneous_resolutions_never_exceed_the_configured_ceiling() {
    let scheduler = std::sync::Arc::new(Scheduler::new());
    let current = std::sync::Arc::new(AtomicUsize::new(0));
    let peak = std::sync::Arc::new(AtomicUsize::new(0));

    let mut handles = Vec::new();
    for _ in 0..(MAX_SIMULTANEOUS_RESOLUTIONS * 2) {
        let scheduler = std::sync::Arc::clone(&scheduler);
        let current = std::sync::Arc::clone(&current);
        let peak = std::sync::Arc::clone(&peak);
        handles.push(tokio::spawn(async move {
            let _permit = scheduler.acquire_permit().await;
            let now = current.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);

            tokio::time::sleep(Duration::from_millis(20)).await;
            current.fetch_sub(1, Ordering::SeqCst);
        }));
    }
    for handle in handles {
        handle.await.unwrap();
    }

    assert!(peak.load(Ordering::SeqCst) <= MAX_SIMULTANEOUS_RESOLUTIONS);
    assert_eq!(peak.load(Ordering::SeqCst), MAX_SIMULTANEOUS_RESOLUTIONS);
}

#[tokio::test]
async fn concurrent_requests_for_the_same_key_collapse_onto_one_resolution() {
    let scheduler = std::sync::Arc::new(Scheduler::new());
    let resolutions = std::sync::Arc::new(AtomicUsize::new(0));
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    let mut handles = Vec::new();
    for _ in 0..5 {
        let scheduler = std::sync::Arc::clone(&scheduler);
        let resolutions = std::sync::Arc::clone(&resolutions);
        let done = std::sync::Arc::clone(&done);
        handles.push(tokio::spawn(async move {
            let _guard = scheduler.key_guard("shared.example").await;

            if done.swap(true, Ordering::SeqCst) {
                return;
            }
            resolutions.fetch_add(1, Ordering::SeqCst);
        }));
    }
    for handle in handles {
        handle.await.unwrap();
    }

    assert_eq!(resolutions.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_dns_lookup_exceeding_its_budget_yields_no_records() {
    set_fake_txt_delayed(
        "default._bimi.slow-dns.example",
        vec!["v=BIMI1; l=https://example.com/logo.svg;".to_owned()],
        DNS_LOOKUP_BUDGET + Duration::from_secs(1),
    );
    let records = lookup_txt("default._bimi.slow-dns.example").await;
    assert!(records.is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_download_exceeding_its_budget_yields_nothing() {
    set_fake_download_delayed(
        "https://slow-download.example/logo.png",
        vec![1, 2, 3],
        DOWNLOAD_BUDGET + Duration::from_secs(1),
    );
    let bytes = download("https://slow-download.example/logo.png").await;
    assert!(bytes.is_none());
}
