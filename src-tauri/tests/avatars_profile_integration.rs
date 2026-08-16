//! Scope presence/absence detection, the userinfo document's mapping to a
//! display name and photograph, and silent degradation for a
//! scope-deficient token (D11) — plus the account-photograph
//! download/validate pipeline itself, against the fake download boundary.

use latentmail_lib::auth::{self, token_has_scope, UserInfo};
use latentmail_lib::avatars::profile::acquire_photo;
use latentmail_lib::avatars::resolver::set_fake_download;
use oauth2::{basic::BasicTokenType, AccessToken, EmptyExtraTokenFields, Scope, StandardTokenResponse};

fn token_with_scopes(
    scopes: Option<Vec<&str>>,
) -> StandardTokenResponse<EmptyExtraTokenFields, BasicTokenType> {
    let mut token = StandardTokenResponse::new(
        AccessToken::new("access-token".into()),
        BasicTokenType::Bearer,
        EmptyExtraTokenFields {},
    );
    token.set_scopes(
        scopes.map(|scopes| scopes.into_iter().map(|s| Scope::new(s.to_owned())).collect()),
    );
    token
}

#[test]
fn token_has_scope_is_true_when_the_granted_scopes_include_profile() {
    let token = token_with_scopes(Some(vec![
        "openid",
        "https://www.googleapis.com/auth/userinfo.profile",
    ]));
    assert!(token_has_scope(&token, "profile"));
}

#[test]
fn token_has_scope_is_false_when_profile_was_never_granted() {
    let token = token_with_scopes(Some(vec!["openid"]));
    assert!(!token_has_scope(&token, "profile"));

    let token_without_any_scope_report = token_with_scopes(None);
    assert!(!token_has_scope(&token_without_any_scope_report, "profile"));
}

#[tokio::test]
async fn userinfo_maps_name_and_picture_claims() {
    // Fake userinfo boundary (mirrors `avatars::resolver`'s DNS/download
    // fake) — no real HTTP, no wiremock, no loopback socket.
    auth::set_fake_userinfo(
        "token-with-picture",
        UserInfo {
            name: Some("Alex Morgan".into()),
            picture: Some("https://lh3.googleusercontent.com/a/photo.jpg".into()),
        },
    );

    let info = auth::userinfo("token-with-picture").await.unwrap();

    assert_eq!(info.name.as_deref(), Some("Alex Morgan"));
    assert_eq!(
        info.picture.as_deref(),
        Some("https://lh3.googleusercontent.com/a/photo.jpg")
    );
}

#[tokio::test]
async fn userinfo_tolerates_a_document_with_no_picture_claim() {
    auth::set_fake_userinfo(
        "token-without-picture",
        UserInfo {
            name: Some("Alex Morgan".into()),
            picture: None,
        },
    );

    let info = auth::userinfo("token-without-picture").await.unwrap();
    assert_eq!(info.name.as_deref(), Some("Alex Morgan"));
    assert!(info.picture.is_none());
}

#[tokio::test]
async fn apply_profile_updates_an_existing_account_and_leaves_unset_fields_untouched() {
    let directory = tempfile::tempdir().unwrap();
    let storage = latentmail_lib::storage::Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let service = auth::AuthService::new(storage);
    let saved = service
        .save_account("me@example.com".into(), "refresh".into(), None)
        .await
        .unwrap();
    assert_eq!(saved.display_name, "me");
    assert_eq!(saved.avatar_url, None);

    let updated = service
        .apply_profile(&saved.id, Some("Real Name".into()), Some("https://example.com/a.png".into()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.display_name, "Real Name");
    assert_eq!(updated.avatar_url.as_deref(), Some("https://example.com/a.png"));

    // A second call with no new name must not blank out the one already
    // applied (silent degradation never erases a known-good value).
    let unchanged = service
        .apply_profile(&saved.id, None, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.display_name, "Real Name");
    assert_eq!(unchanged.avatar_url.as_deref(), Some("https://example.com/a.png"));
}

#[tokio::test]
async fn apply_profile_on_an_unknown_account_returns_none_without_erroring() {
    let directory = tempfile::tempdir().unwrap();
    let storage = latentmail_lib::storage::Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let service = auth::AuthService::new(storage);

    let result = service
        .apply_profile("unknown-account", Some("Name".into()), None)
        .await
        .unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn acquire_photo_downloads_validates_and_normalizes_the_account_photograph() {
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>"##.to_vec();
    set_fake_download("https://photo.example/me.svg", svg);

    let png = acquire_photo("https://photo.example/me.svg")
        .await
        .expect("a validated photograph must acquire");
    let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png).unwrap();
    assert_eq!(decoded.width(), latentmail_lib::avatars::image::OUTPUT_SIZE);
}

#[tokio::test]
async fn acquire_photo_degrades_silently_when_the_download_fails() {
    // Nothing programmed for this URL in the fake downloader — a
    // scope-deficient token, a dead link, and a failed download are all the
    // same "no photograph" outcome (D11).
    assert!(acquire_photo("https://missing.example/me.png").await.is_none());
}
