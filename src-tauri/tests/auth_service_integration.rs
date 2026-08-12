//! Exercises `AuthService` and the OAuth helper functions beyond the
//! PKCE/state-validation coverage in `auth_pkce_integration.rs` and the
//! keychain-only coverage in `auth_token_refresh_integration.rs`.

use std::sync::{Arc, Mutex};

use latentmail_lib::auth::{
    self, begin_reauthentication, begin_sign_in, initialize, list_accounts, profile, receive_code,
    save_refresh_token, AuthService,
};
use latentmail_lib::auth::{load_refresh_token, parse_callback};
use latentmail_lib::storage::{Account, AccountRepository, Storage};
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn app() -> tauri::App<tauri::test::MockRuntime> {
    // Commands below are called directly as plain async functions (not
    // dispatched through IPC), so this deliberately skips
    // `latentmail_lib::ipc::register` to avoid pulling in and
    // monomorphizing every other command's generic code in this binary.
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

fn service_with_storage() -> (AuthService, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    (AuthService::new(storage), directory)
}

#[tokio::test]
async fn accounts_lists_what_is_persisted() {
    let (service, _directory) = service_with_storage();
    assert_eq!(service.accounts().await.unwrap(), Vec::new());

    // The returned account is what `start()` announces on `account://state`,
    // which is the only thing that moves the UI off the sign-in screen.
    let saved = service
        .save_account("me@example.com".into(), "refresh-token".into(), None)
        .await
        .unwrap();
    assert_eq!(saved.email, "me@example.com");
    assert!(!saved.needs_reauthentication);
    // Gmail gives us no display name, so the local part stands in — an empty
    // one renders a blank account-switcher row and a blank avatar initial.
    assert_eq!(saved.display_name, "me");

    let accounts = service.accounts().await.unwrap();
    assert_eq!(accounts, vec![saved]);
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].email, "me@example.com");
    assert!(!accounts[0].needs_reauthentication);
}

#[tokio::test]
async fn save_account_reconnects_an_existing_account_by_target_id() {
    let (service, _directory) = service_with_storage();
    service
        .save_account("me@example.com".into(), "first-token".into(), None)
        .await
        .unwrap();
    let account_id = service.accounts().await.unwrap()[0].id.clone();

    service
        .save_account(
            "me@example.com".into(),
            "second-token".into(),
            Some(account_id.clone()),
        )
        .await
        .unwrap();

    let accounts = service.accounts().await.unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].id, account_id);
}

#[tokio::test]
async fn save_account_rejects_a_target_whose_email_does_not_match() {
    let (service, _directory) = service_with_storage();
    service
        .save_account("first@example.com".into(), "token".into(), None)
        .await
        .unwrap();
    let account_id = service.accounts().await.unwrap()[0].id.clone();

    let result = service
        .save_account(
            "second@example.com".into(),
            "token".into(),
            Some(account_id),
        )
        .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn mark_needs_reauthentication_emits_account_state_and_rejects_unknown_accounts() {
    let (service, _directory) = service_with_storage();
    service
        .save_account("me@example.com".into(), "token".into(), None)
        .await
        .unwrap();
    let account_id = service.accounts().await.unwrap()[0].id.clone();

    let application = app();
    let handle = application.handle().clone();
    let received: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let received_for_listener = Arc::clone(&received);
    {
        use tauri::Listener;
        handle.listen("account://state", move |event| {
            *received_for_listener.lock().unwrap() = Some(event.payload().to_owned());
        });
    }

    service
        .mark_needs_reauthentication(&handle, account_id.clone())
        .await
        .unwrap();

    let payload = received.lock().unwrap().clone().unwrap();
    assert!(payload.contains("needsReauthentication"));
    assert!(payload.contains(&account_id));

    let accounts = service.accounts().await.unwrap();
    assert!(accounts[0].needs_reauthentication);

    let missing = service
        .mark_needs_reauthentication(&handle, "unknown".into())
        .await;
    assert_eq!(missing.unwrap_err(), "Unknown account");
}

#[tokio::test]
async fn refresh_access_token_succeeds_against_a_mock_token_endpoint() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-access-token",
            "token_type": "Bearer",
        })))
        .mount(&server)
        .await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    save_refresh_token("refreshing-account", "stored-refresh-token").unwrap();

    let (service, _directory) = service_with_storage();
    let application = app();
    let handle = application.handle().clone();

    let token = service
        .refresh_access_token(&handle, "refreshing-account")
        .await
        .unwrap();

    assert_eq!(token, "fresh-access-token");
}

#[tokio::test]
async fn refresh_access_token_marks_reauthentication_after_three_consecutive_failures() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(400))
        .mount(&server)
        .await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    save_refresh_token("flaky-account", "stored-refresh-token").unwrap();

    let (service, _directory) = service_with_storage();
    service
        .save_account(
            "flaky@example.com".into(),
            "stored-refresh-token".into(),
            None,
        )
        .await
        .unwrap();
    let account_id = "flaky@example.com".to_owned();
    // save_account() assigns the email as id for brand new accounts.
    assert_eq!(service.accounts().await.unwrap()[0].id, account_id);
    save_refresh_token(&account_id, "stored-refresh-token").unwrap();

    let application = app();
    let handle = application.handle().clone();

    for _ in 0..2 {
        assert!(service
            .refresh_access_token(&handle, &account_id)
            .await
            .is_err());
        assert!(!service.accounts().await.unwrap()[0].needs_reauthentication);
    }
    assert!(service
        .refresh_access_token(&handle, &account_id)
        .await
        .is_err());
    assert!(service.accounts().await.unwrap()[0].needs_reauthentication);
}

#[test]
fn client_id_prefers_the_runtime_override_and_rejects_an_empty_one() {
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "runtime-client");
    assert_eq!(auth::client_id().unwrap(), "runtime-client");

    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "");
    assert_eq!(
        auth::client_id().unwrap_err(),
        "LATENTMAIL_GOOGLE_CLIENT_ID is not configured"
    );
}

#[test]
fn client_secret_is_optional_and_ignores_an_empty_value() {
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_SECRET", "runtime-secret");
    assert_eq!(
        auth::client_secret().map(|secret| secret.secret().to_owned()),
        Some("runtime-secret".to_owned())
    );

    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_SECRET", "");
    assert!(auth::client_secret().is_none());
}

#[tokio::test]
async fn start_requires_a_configured_client_id() {
    std::env::remove_var("LATENTMAIL_GOOGLE_CLIENT_ID");
    let (service, _directory) = service_with_storage();
    let application = app();

    let error = service
        .start(application.handle().clone(), None)
        .await
        .unwrap_err();

    assert_eq!(error, "LATENTMAIL_GOOGLE_CLIENT_ID is not configured");
}

#[tokio::test]
async fn start_fails_when_the_system_browser_cannot_be_opened_in_tests() {
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    let (service, _directory) = service_with_storage();
    let application = app();

    let error = service
        .start(application.handle().clone(), None)
        .await
        .unwrap_err();

    assert_eq!(error, "System-browser access is disabled in tests");
}

#[tokio::test]
async fn list_accounts_begin_sign_in_and_begin_reauthentication_commands() {
    std::env::remove_var("LATENTMAIL_GOOGLE_CLIENT_ID");
    let (service, _directory) = service_with_storage();
    let application = app();
    application.manage(service);

    let accounts = list_accounts(application.state()).await.unwrap();
    assert!(accounts.is_empty());

    assert!(
        begin_sign_in(application.handle().clone(), application.state())
            .await
            .is_err()
    );
    assert!(begin_reauthentication(
        application.handle().clone(),
        application.state(),
        "any".into()
    )
    .await
    .is_err());
}

#[tokio::test]
async fn receive_code_validates_state_and_extracts_the_code_from_a_raw_http_callback() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let writer = tokio::spawn(async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(b"GET /?code=auth-code&state=expected HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut buffer = vec![0; 1024];
        let read = stream.read(&mut buffer).await.unwrap();
        String::from_utf8(buffer[..read].to_owned()).unwrap()
    });

    let code = receive_code(listener, "expected").await.unwrap();
    let response = writer.await.unwrap();

    assert_eq!(code.secret(), "auth-code");
    assert!(response.contains("Sign-in complete"));
}

#[tokio::test]
async fn receive_code_rejects_a_mismatched_state_and_reports_it_to_the_browser() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let writer = tokio::spawn(async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(b"GET /?code=auth-code&state=wrong HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut buffer = vec![0; 1024];
        let read = stream.read(&mut buffer).await.unwrap();
        String::from_utf8(buffer[..read].to_owned()).unwrap()
    });

    let error = receive_code(listener, "expected").await.unwrap_err();
    let response = writer.await.unwrap();

    assert_eq!(error, "OAuth state did not match");
    assert!(response.contains("Invalid sign-in response"));
}

#[tokio::test]
async fn exchange_code_round_trips_against_a_mock_token_endpoint() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "exchanged-access-token",
            "refresh_token": "exchanged-refresh-token",
            "token_type": "Bearer",
        })))
        .mount(&server)
        .await;
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );

    let authorization = auth::authorization("client", "http://127.0.0.1:0").unwrap();
    let code = oauth2::AuthorizationCode::new("code".into());
    let token = auth::exchange_code("client", "http://127.0.0.1:0", code, authorization.verifier)
        .await
        .unwrap();

    use oauth2::TokenResponse;
    assert_eq!(token.access_token().secret(), "exchanged-access-token");
}

#[tokio::test]
async fn profile_maps_the_camel_case_email_address_field() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "profile@example.com",
        })))
        .mount(&server)
        .await;
    std::env::set_var(
        "LATENTMAIL_GOOGLE_PROFILE_URL",
        format!("{}/profile", server.uri()),
    );

    let result = profile("access-token").await.unwrap();

    assert_eq!(result.email_address, "profile@example.com");
}

#[test]
fn initialize_creates_the_app_data_directory_and_manages_auth_service_state() {
    // See the matching comment in settings_service_integration.rs: this
    // redirects the OS per-user data directory to an isolated temp dir so
    // the test never touches the real machine.
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("APPDATA", home.path());
    std::env::set_var("XDG_DATA_HOME", home.path());

    let application = app();

    initialize(application.handle()).unwrap();

    assert!(application.try_state::<AuthService>().is_some());
}

#[test]
fn account_repository_round_trip_matches_the_auth_dto_mapping() {
    let connection = Storage::in_memory().unwrap();
    let account = Account {
        id: "id".into(),
        email: "mail@example.com".into(),
        display_name: "Name".into(),
        avatar_url: Some("https://example.com/a.png".into()),
        history_id: None,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    };
    AccountRepository::upsert(&connection, &account).unwrap();
    assert_eq!(
        AccountRepository::get(&connection, "id").unwrap(),
        Some(account)
    );
}

// The tests below were merged in from what used to be
// `auth_pkce_integration.rs` and `auth_token_refresh_integration.rs` to
// reduce the number of separate crates that instantiate the same
// `<R: Runtime>`-generic auth functions (each integration test file is a
// distinct compiled crate, and Rust monomorphizes generics per instantiating
// crate) — consolidating keeps coverage instrumentation focused on fewer
// duplicate copies of the same logical function.

#[test]
fn authorization_uses_pkce_offline_consent_and_gmail_scopes() {
    let authorization = auth::authorization("client", "http://127.0.0.1:43123").unwrap();
    let url = tauri::Url::parse(&authorization.url).unwrap();
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();

    assert_eq!(url.host_str(), Some("accounts.google.com"));
    assert_eq!(query["redirect_uri"], "http://127.0.0.1:43123");
    assert_eq!(query["code_challenge_method"], "S256");
    assert!(!query["code_challenge"].is_empty());
    assert_eq!(query["access_type"], "offline");
    assert_eq!(query["prompt"], "consent");
    assert!(query["scope"].contains("gmail.modify"));
    assert!(query["scope"].contains("gmail.labels"));
}

#[test]
fn callback_state_is_validated_before_the_code_is_accepted() {
    assert!(parse_callback("/?code=code&state=expected", "expected").is_ok());
    assert_eq!(
        parse_callback("/?code=code&state=wrong", "expected").unwrap_err(),
        "OAuth state did not match"
    );
}

#[test]
fn test_keychain_never_uses_the_real_os_store() {
    save_refresh_token("keychain-account", "refresh-token").unwrap();
    assert_eq!(
        load_refresh_token("keychain-account").unwrap(),
        "refresh-token"
    );
}

#[test]
fn reconnecting_an_email_updates_its_existing_account() {
    let connection = Storage::in_memory().unwrap();
    let original = Account {
        id: "first-id".into(),
        email: "mail@example.com".into(),
        display_name: "Old".into(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: true,
        created_at: 1,
        updated_at: 1,
    };
    AccountRepository::upsert(&connection, &original).unwrap();
    let mut reconnected = AccountRepository::get_by_email(&connection, "mail@example.com")
        .unwrap()
        .unwrap();
    reconnected.display_name = "New".into();
    reconnected.needs_reauthentication = false;
    AccountRepository::upsert(&connection, &reconnected).unwrap();

    assert_eq!(
        AccountRepository::list(&connection).unwrap(),
        vec![reconnected]
    );
}
