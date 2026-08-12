//! D4: traversal draws from a capped, class-scoped quota so a saturating
//! traversal can never starve non-traversal work (interactive actions,
//! polling, body fetches), which stays uncapped and draws from the whole
//! account budget.
//!
//! These exercise the token bucket's real (unpaused) timing rather than
//! Tokio's mock clock: every call here is a genuine network round trip
//! through `wiremock`, and racing that against a paused-clock timeout is
//! unreliable (real I/O completion isn't driven by the mocked clock, so a
//! paused timer can spuriously "win" before the response arrives — the
//! reason `gmail_backoff_integration.rs` only pairs `start_paused` with
//! manual `tokio::time::advance` after pinning a future, never a bare
//! `timeout` race). Wall-clock measurement over a handful of local-loopback
//! requests is fast and deterministic enough to assert against a threshold
//! well under the refill delay it's distinguishing from.

use latentmail_lib::gmail::{
    GmailClient, GmailRateLimiters, ACCOUNT_RATE_PER_SECOND, TRAVERSAL_SHARE,
};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

/// Drains the traversal-class bucket to (at most) empty by issuing
/// slightly more than its capacity worth of requests **concurrently**,
/// rather than sequentially. Sequential draining leaves a window for the
/// real-time refill to add back a fractional token between each request —
/// small, but enough to make "does the *next* request wait" nondeterministic
/// at these millisecond scales. Firing them concurrently collapses that
/// window to roughly one round trip's worth of wall time; issuing a few
/// more than capacity guarantees at least one of them genuinely blocks on
/// the bucket, which is what pins the bucket at empty by the time every
/// task in the burst has completed.
async fn drain_traversal_bucket(client: &GmailClient) {
    let capacity = (ACCOUNT_RATE_PER_SECOND * TRAVERSAL_SHARE) as usize;
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..(capacity + 5) {
        let client = client.clone();
        tasks.spawn(async move { client.profile().await.unwrap() });
    }
    while tasks.join_next().await.is_some() {}
}

fn profile_body() -> serde_json::Value {
    serde_json::json!({
        "emailAddress": "me@example.com",
        "messagesTotal": 0,
        "threadsTotal": 0,
        "historyId": "1"
    })
}

/// Draining the capped traversal bucket down to empty must not touch the
/// shared account bucket's remaining headroom enough to make a subsequent
/// *non*-traversal request wait — it draws only from the shared bucket,
/// which a traversal-share-sized drain leaves mostly full. A genuinely
/// waiting request would take at least one refill tick
/// (`1 / (ACCOUNT_RATE_PER_SECOND * TRAVERSAL_SHARE)` seconds, ~25ms here);
/// this asserts comfortably under that.
#[tokio::test]
async fn saturating_traversal_quota_does_not_delay_a_non_traversal_request() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(profile_body()))
        .mount(&server)
        .await;

    let limiters = GmailRateLimiters::default();
    let client = GmailClient::for_account("account", "token", server.uri(), &limiters).await;
    let traversal_client = client.traversal_scoped();

    drain_traversal_bucket(&traversal_client).await;

    let started = std::time::Instant::now();
    client.profile().await.unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_millis(15),
        "non-traversal work must obtain tokens without waiting while traversal is saturated \
         (took {elapsed:?}, expected well under the ~25ms traversal-bucket refill tick)"
    );
}

/// The mirror case: a traversal-class request issued after its own bucket
/// is empty genuinely waits for a refill tick (proving the cap is real,
/// not a no-op) — unlike the non-traversal request above.
#[tokio::test]
async fn a_traversal_request_beyond_its_cap_genuinely_waits_for_refill() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(profile_body()))
        .mount(&server)
        .await;

    let limiters = GmailRateLimiters::default();
    let client = GmailClient::for_account("account", "token", server.uri(), &limiters).await;
    let traversal_client = client.traversal_scoped();

    drain_traversal_bucket(&traversal_client).await;

    let started = std::time::Instant::now();
    traversal_client.profile().await.unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed >= std::time::Duration::from_millis(15),
        "a traversal request beyond its cap must wait for the bucket to refill (took {elapsed:?})"
    );
}
