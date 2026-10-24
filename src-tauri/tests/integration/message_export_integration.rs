use std::sync::Arc;

use latentmail_lib::auth::AuthService;
use latentmail_lib::message_export::commands::{
    read_message_source, save_message_html_to_path, save_message_source_to_path,
};
use latentmail_lib::message_export::{
    authentication_results, collapse_encoded_bodies, export_document, RecipientRoles,
};
use latentmail_lib::sanitize::{sanitize_for_export, MAX_SANITIZED_HTML_BYTES};
use latentmail_lib::storage::{
    Account, AccountRepository, Attachment, AttachmentRepository, HtmlPresence, InlinePart,
    Message, MessageRepository, Storage,
};
use latentmail_lib::sync::{noop_event_sink, SyncEngine, WorkRegistry};
use tauri::Manager;
use wiremock::{
    matchers::{method, path, query_param},
    Mock, MockServer, ResponseTemplate,
};

const RAW_SOURCE: &[u8] = b"Subject: Invoice\r\n\r\nbody";
const RAW_SOURCE_BASE64URL: &str = "U3ViamVjdDogSW52b2ljZQ0KDQpib2R5";

fn message() -> Message {
    Message {
        account_id: "account".into(),
        id: "m1".into(),
        thread_id: "t1".into(),
        rfc_message_id: Some("<invoice@northwind.example>".into()),
        sender: "Northwind <billing@northwind.example>".into(),
        recipients: "me@example.com".into(),
        subject: "Invoice".into(),
        sent_at: 1_792_745_645,
        snippet: "Invoice".into(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: None,
        html_presence: HtmlPresence::Present,
    }
}

fn no_roles() -> RecipientRoles<'static> {
    RecipientRoles { to: "", cc: "" }
}

fn encoded_lines(count: usize) -> String {
    "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2\r\n".repeat(count)
}

#[test]
fn authentication_results_reads_the_topmost_header_and_unfolds_it() {
    let raw = "Delivered-To: me@example.com\r\nauthentication-results: mx.google.com;\r\n       dkim=pass header.i=@northwind.example;\r\n\tspf=pass\r\nAuthentication-Results: relay.example; spf=fail\r\nSubject: Hi\r\n\r\nAuthentication-Results: body text\r\n";

    assert_eq!(
        authentication_results(raw).as_deref(),
        Some("mx.google.com; dkim=pass header.i=@northwind.example; spf=pass")
    );
}

#[test]
fn authentication_results_ignores_a_body_that_only_mentions_the_header() {
    let raw = "Subject: Hi\r\n\r\nAuthentication-Results: spf=pass\r\n";

    assert_eq!(authentication_results(raw), None);
}

#[test]
fn collapse_replaces_a_long_base64_run_with_a_named_marker() {
    let raw = format!(
        "--b1\r\nContent-Type: application/pdf; name=\"NW-2026-10.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{}--b1--\r\n",
        encoded_lines(200)
    );

    let display = collapse_encoded_bodies(&raw);

    assert!(display
        .contains("[NW-2026-10.pdf · 9 KB of base64 hidden · Copy and Download include it]\n"));
    assert!(display.ends_with("--b1--\r\n"));
    assert!(!display.contains("QUJDREVG"));
}

#[test]
fn collapse_reports_megabytes_and_falls_back_to_a_generic_name_after_a_boundary() {
    let raw = format!(
        "Content-Type: image/png; name=\"logo.png\"\r\n--b1\r\nContent-Transfer-Encoding: base64\r\n\r\n{}",
        encoded_lines(30_000)
    );

    let display = collapse_encoded_bodies(&raw);

    assert!(display.contains("[Encoded part · 1.4 MB of base64 hidden"));
}

#[test]
fn collapse_keeps_short_runs_and_text_unchanged() {
    let raw = format!(
        "Subject: Hi\r\n\r\nHello there\r\n{}short line\r\n",
        encoded_lines(3)
    );

    assert_eq!(collapse_encoded_bodies(&raw), raw);
}

#[test]
fn export_document_carries_its_own_policy_and_escaped_headers() {
    let mut source = message();
    source.subject = "<script>alert(1)</script> Invoice".into();
    source.html_body = Some("<p>Amount due</p><script>alert(2)</script>".into());
    let attachments = [Attachment {
        attachment_id: "a1".into(),
        filename: "NW-2026-10.pdf".into(),
        mime_type: "application/pdf".into(),
        size: 10,
        position: 0,
    }];

    let document = export_document(
        &source,
        &RecipientRoles {
            to: "me@example.com",
            cc: "team@example.com",
        },
        &attachments,
        &[],
    )
    .unwrap();

    assert!(document.starts_with("<!doctype html>"));
    assert!(document.contains("content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'\""));
    assert!(document.contains("<p>Amount due</p>"));
    assert!(!document.contains("<script>"));
    assert!(document.contains("&lt;script&gt;"));
    assert!(document.contains(">Cc</th>"));
    assert!(document.contains("NW-2026-10.pdf"));
    assert!(!document.contains("Remote images were not included"));
}

#[test]
fn export_document_embeds_inline_images_and_drops_remote_ones() {
    let mut source = message();
    source.html_body = Some(
        "<img src=\"cid:logo\"><img src=\"cid:sheet\"><img src=\"https://tracker.example/pixel.gif\">"
            .into(),
    );
    let parts = [
        InlinePart {
            content_id: "logo".into(),
            mime_type: "image/png".into(),
            bytes: b"png".to_vec(),
        },
        InlinePart {
            content_id: "sheet".into(),
            mime_type: "application/vnd.ms-excel".into(),
            bytes: b"xls".to_vec(),
        },
    ];

    let document = export_document(&source, &no_roles(), &[], &parts).unwrap();

    assert!(document.contains("src=\"data:image/png;base64,cG5n\""));
    assert!(!document.contains("eGxz"));
    assert!(!document.contains("tracker.example"));
    assert!(document.contains("Remote images were not included in this file."));
    assert!(!document.contains(">Cc</th>"));
    assert!(document.contains("me@example.com"));
}

#[test]
fn export_document_falls_back_to_the_plain_body_and_refuses_an_empty_one() {
    let mut source = message();
    source.plain_body = Some("Line one\n<b>not bold</b>".into());

    let document = export_document(&source, &no_roles(), &[], &[]).unwrap();

    assert!(document.contains("<pre"));
    assert!(document.contains("&lt;b&gt;not"));
    assert!(export_document(&message(), &no_roles(), &[], &[]).is_none());
}

#[test]
fn export_sanitizing_never_truncates_a_large_body() {
    let html = format!("<p>{}</p>", "a".repeat(MAX_SANITIZED_HTML_BYTES * 2));

    let sanitized = sanitize_for_export(&html, &Default::default());

    assert!(!sanitized.truncated);
    assert!(sanitized.html.len() > MAX_SANITIZED_HTML_BYTES * 2);
}

struct Harness {
    _server: MockServer,
    _directory: tempfile::TempDir,
    storage: Storage,
    app: tauri::App<tauri::test::MockRuntime>,
}

async fn harness(raw_response: ResponseTemplate) -> Harness {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-access-token",
            "token_type": "Bearer",
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .and(query_param("format", "raw"))
        .respond_with(raw_response)
        .mount(&server)
        .await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token("account", "stored-refresh-token").unwrap();

    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "me@example.com".into(),
            display_name: String::new(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(&connection, &message()).unwrap();
    drop(connection);

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine: Arc<SyncEngine> =
        SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AuthService::new(storage.clone()));
    app.manage(engine);
    app.manage(storage.clone());
    Harness {
        _server: server,
        _directory: directory,
        storage,
        app,
    }
}

fn raw_ok() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(serde_json::json!({ "raw": RAW_SOURCE_BASE64URL }))
}

#[tokio::test]
async fn read_message_source_combines_stored_headers_with_the_raw_text() {
    let harness = harness(raw_ok()).await;
    MessageRepository::set_recipient_roles(
        &harness.storage.connection().unwrap(),
        "account",
        "m1",
        "",
        "team@example.com",
        "",
        None,
    )
    .unwrap();

    let source = read_message_source(
        harness.app.handle().clone(),
        harness.app.state(),
        harness.app.state(),
        harness.app.state(),
        "account".into(),
        "m1".into(),
    )
    .await
    .unwrap();

    assert_eq!(
        source.message_id.as_deref(),
        Some("<invoice@northwind.example>")
    );
    assert_eq!(source.sent_at, 1_792_745_645_000);
    assert_eq!(source.to, "me@example.com");
    assert_eq!(source.cc, "team@example.com");
    assert_eq!(source.size_bytes, RAW_SOURCE.len() as u64);
    assert_eq!(source.raw, "Subject: Invoice\r\n\r\nbody");
    assert_eq!(source.display, source.raw);
    assert_eq!(source.authentication_results, None);
}

#[tokio::test]
async fn read_message_source_explains_an_oversize_message_and_an_unknown_one() {
    let harness = harness(
        ResponseTemplate::new(200).set_body_raw(vec![b' '; 73 * 1024 * 1024], "application/json"),
    )
    .await;

    let error = read_message_source(
        harness.app.handle().clone(),
        harness.app.state(),
        harness.app.state(),
        harness.app.state(),
        "account".into(),
        "m1".into(),
    )
    .await
    .unwrap_err();
    let missing = read_message_source(
        harness.app.handle().clone(),
        harness.app.state(),
        harness.app.state(),
        harness.app.state(),
        "account".into(),
        "unknown".into(),
    )
    .await
    .unwrap_err();

    assert_eq!(error, "This message is too large to show its source here.");
    assert_eq!(missing, "Message is unavailable");
}

#[tokio::test]
async fn save_message_source_writes_the_raw_bytes_unchanged() {
    let harness = harness(raw_ok()).await;
    let destination = harness._directory.path().join("Invoice.eml");

    save_message_source_to_path(
        harness.app.handle().clone(),
        harness.app.state(),
        harness.app.state(),
        "account".into(),
        "m1".into(),
        destination.to_string_lossy().into_owned(),
    )
    .await
    .unwrap();

    assert_eq!(std::fs::read(destination).unwrap(), RAW_SOURCE);
}

#[tokio::test]
async fn save_message_source_reports_a_gmail_failure() {
    let harness = harness(ResponseTemplate::new(404)).await;

    let error = save_message_source_to_path(
        harness.app.handle().clone(),
        harness.app.state(),
        harness.app.state(),
        "account".into(),
        "m1".into(),
        harness
            ._directory
            .path()
            .join("Invoice.eml")
            .to_string_lossy()
            .into_owned(),
    )
    .await
    .unwrap_err();

    assert_eq!(error, "Gmail request failed with status 404");
}

#[tokio::test]
async fn save_message_html_writes_the_stored_body_with_attachments_and_inline_images() {
    let harness = harness(raw_ok()).await;
    let connection = harness.storage.connection().unwrap();
    MessageRepository::set_body(
        &connection,
        "account",
        "m1",
        Some("<p>Amount due</p><img src=\"cid:logo\">"),
        None,
        HtmlPresence::Present,
    )
    .unwrap();
    MessageRepository::replace_inline_parts(
        &connection,
        "account",
        "m1",
        &[InlinePart {
            content_id: "logo".into(),
            mime_type: "image/png".into(),
            bytes: b"png".to_vec(),
        }],
    )
    .unwrap();
    AttachmentRepository::replace_for_message(
        &connection,
        "account",
        "m1",
        &[Attachment {
            attachment_id: "a1".into(),
            filename: "NW-2026-10.pdf".into(),
            mime_type: "application/pdf".into(),
            size: 10,
            position: 0,
        }],
    )
    .unwrap();
    drop(connection);
    let destination = harness._directory.path().join("Invoice.html");

    save_message_html_to_path(
        harness.app.state(),
        "account".into(),
        "m1".into(),
        destination.to_string_lossy().into_owned(),
    )
    .await
    .unwrap();

    let document = std::fs::read_to_string(destination).unwrap();
    assert!(document.contains("<p>Amount due</p>"));
    assert!(document.contains("data:image/png;base64,cG5n"));
    assert!(document.contains("NW-2026-10.pdf"));
}

#[tokio::test]
async fn save_message_html_asks_for_the_body_to_load_first() {
    let harness = harness(raw_ok()).await;

    let error = save_message_html_to_path(
        harness.app.state(),
        "account".into(),
        "m1".into(),
        harness
            ._directory
            .path()
            .join("Invoice.html")
            .to_string_lossy()
            .into_owned(),
    )
    .await
    .unwrap_err();

    assert_eq!(
        error,
        "Open the message so its content loads, then try again."
    );
}

#[tokio::test]
async fn save_message_source_reports_a_destination_that_cannot_be_written() {
    let harness = harness(raw_ok()).await;
    let destination = harness
        ._directory
        .path()
        .join("missing")
        .join("Invoice.eml");

    let error = save_message_source_to_path(
        harness.app.handle().clone(),
        harness.app.state(),
        harness.app.state(),
        "account".into(),
        "m1".into(),
        destination.to_string_lossy().into_owned(),
    )
    .await
    .unwrap_err();

    assert!(!error.is_empty());
    assert!(!destination.exists());
}
