use crate::ipc_contract_core_integration::{
    app, invoke, save_test_account, start_token_server, upsert_basic_account,
};
use latentmail_lib::attachments::{AttachmentDescriptor, AttachmentRef};
use latentmail_lib::auth::AuthService;
use latentmail_lib::queue::QueueEngine;
use latentmail_lib::storage::{
    Attachment, AttachmentRepository, HtmlPresence, Message, MessageKey, MessageRepository, Storage,
};
use latentmail_lib::sync::{noop_event_sink, SyncEngine, SyncEngineDeps, WorkRegistry};
use std::sync::Arc;
use tauri::Manager;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn manage_attachment_command_dependencies(
    app: &tauri::App<tauri::test::MockRuntime>,
    storage: &Storage,
    directory: &std::path::Path,
) {
    app.manage(AuthService::new(storage.clone()));
    app.manage(SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: QueueEngine::no_op(),
        registry: WorkRegistry::new(),
        events: noop_event_sink(),
    }));
    app.manage(storage.clone());
    app.manage(Arc::new(latentmail_lib::compose::staging::Staging::new(
        directory.join("compose-staging"),
    )));
    app.manage(
        latentmail_lib::attachments::cache::AttachmentCache::new(
            directory.join("attachment-cache"),
        )
        .unwrap(),
    );
}

struct CachedAttachmentSeed<'a> {
    directory: &'a std::path::Path,
    account_id: &'a str,
    message_id: &'a str,
    attachment_id: &'a str,
    bytes: &'a [u8],
}

fn seed_cached_attachment(
    CachedAttachmentSeed {
        directory,
        account_id,
        message_id,
        attachment_id,
        bytes,
    }: CachedAttachmentSeed<'_>,
) -> std::path::PathBuf {
    latentmail_lib::attachments::cache::AttachmentCache::new(directory.join("attachment-cache"))
        .unwrap()
        .write_bytes(
            AttachmentDescriptor {
                target: AttachmentRef {
                    account_id: account_id,
                    message_id: message_id,
                    attachment_id: attachment_id,
                },
                filename: "attachment.txt",
                mime_type: "text/plain",
            },
            bytes,
        )
        .unwrap()
        .cache_path
}

struct AttachedMessageSeed<'a> {
    storage: &'a Storage,
    account_id: &'a str,
    message_id: &'a str,
    attachment_ids: &'a [&'a str],
}

fn insert_account_message_and_attachment(
    AttachedMessageSeed {
        storage,
        account_id,
        message_id,
        attachment_ids,
    }: AttachedMessageSeed<'_>,
) {
    let connection = storage.connection().unwrap();
    upsert_basic_account(
        &connection,
        account_id,
        &format!("{account_id}@example.com"),
    );
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: account_id.into(),
            id: message_id.into(),
            thread_id: "t1".into(),
            rfc_message_id: None,
            sender: "sender@example.com".into(),
            recipients: String::new(),
            subject: "Subject".into(),
            sent_at: 1,
            snippet: String::new(),
            html_body: None,
            plain_body: None,
            has_attachments: true,
            is_unread: false,
            is_starred: false,
            history_id: 1,
            truncated_body: None,
            html_presence: HtmlPresence::Absent,
        },
    )
    .unwrap();
    let attachments: Vec<Attachment> = attachment_ids
        .iter()
        .map(|attachment_id| Attachment {
            attachment_id: (*attachment_id).into(),
            filename: format!("{attachment_id}.txt"),
            mime_type: "text/plain".into(),
            size: 5,
            position: 0,
        })
        .collect();
    AttachmentRepository::replace_for_message(
        &connection,
        MessageKey {
            account_id: account_id,
            message_id: message_id,
        },
        &attachments,
    )
    .unwrap();
}

async fn mount_authenticated_gmail_server(
    account_id: &str,
    forbidden_attachment_path: &str,
) -> MockServer {
    let server = start_token_server(account_id).await;
    Mock::given(method("GET"))
        .and(wiremock::matchers::path_regex(forbidden_attachment_path))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;
    server
}

fn assert_unreadable_error(error: serde_json::Value) {
    assert!(error.is_string());
    assert_ne!(error, serde_json::json!("missing refresh token"));
    assert_ne!(
        error,
        serde_json::json!("Attachment metadata is unavailable")
    );
}

#[tokio::test]
async fn attachment_commands_succeed_end_to_end_through_real_ipc_dispatch() {
    let app = app();
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = save_test_account(&auth_service, "me@example.com").await;

    let server = start_token_server(&account_id).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1/attachments/a1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "data": "aGVsbG8" })),
        )
        .mount(&server)
        .await;

    insert_account_message_and_attachment(AttachedMessageSeed {
        storage: &storage,
        account_id: &account_id,
        message_id: "m1",
        attachment_ids: &["a1"],
    });
    AttachmentRepository::replace_for_message(
        &storage.connection().unwrap(),
        MessageKey {
            account_id: &account_id,
            message_id: "m1",
        },
        &[Attachment {
            attachment_id: "a1".into(),
            filename: "hello.txt".into(),
            mime_type: "text/plain".into(),
            size: 5,
            position: 0,
        }],
    )
    .unwrap();

    manage_attachment_command_dependencies(&app, &storage, directory.path());
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let args = serde_json::json!({
        "accountId": account_id,
        "messageId": "m1",
        "attachmentId": "a1"
    });
    let cached = invoke(&webview, "ensure_attachment_cached", args.clone()).unwrap();
    assert_eq!(cached["filename"], "hello.txt");
    assert_eq!(cached["mimeType"], "text/plain");
    assert_eq!(
        invoke(&webview, "read_attachment_text", args.clone()).unwrap(),
        "hello"
    );
    assert!(invoke(&webview, "read_attachment_bytes", args.clone()).is_ok());

    let destination = directory.path().join("saved.txt");
    let mut save_args = args.clone();
    save_args["destination"] = serde_json::json!(destination.to_string_lossy());
    assert!(invoke(&webview, "save_attachment_to_path", save_args).is_ok());
    assert_eq!(std::fs::read_to_string(&destination).unwrap(), "hello");

    let mut stage_args = args;
    stage_args["owner"] = serde_json::json!("draft-owner");
    let staged = invoke(&webview, "stage_attachment_into_draft", stage_args).unwrap();
    assert_eq!(staged["filename"], "hello.txt");
}

#[tokio::test]
async fn ensure_attachment_cached_fails_when_the_attachment_row_is_missing() {
    let app = app();
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    insert_account_message_and_attachment(AttachedMessageSeed {
        storage: &storage,
        account_id: "account-missing-row",
        message_id: "m1",
        attachment_ids: &[],
    });
    manage_attachment_command_dependencies(&app, &storage, directory.path());
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let error = invoke(
        &webview,
        "ensure_attachment_cached",
        serde_json::json!({
            "accountId": "account-missing-row",
            "messageId": "m1",
            "attachmentId": "does-not-exist"
        }),
    )
    .unwrap_err();
    assert_eq!(
        error,
        serde_json::json!("Attachment metadata is unavailable")
    );
}

#[tokio::test]
async fn ensure_attachment_cached_fails_when_the_account_has_no_refresh_token() {
    crate::support::set_env("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    crate::support::set_env("LATENTMAIL_GOOGLE_TOKEN_URL", "http://127.0.0.1:9/token");

    let app = app();
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    insert_account_message_and_attachment(AttachedMessageSeed {
        storage: &storage,
        account_id: "account-no-token",
        message_id: "m1",
        attachment_ids: &["a1"],
    });
    manage_attachment_command_dependencies(&app, &storage, directory.path());
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let error = invoke(
        &webview,
        "ensure_attachment_cached",
        serde_json::json!({
            "accountId": "account-no-token",
            "messageId": "m1",
            "attachmentId": "a1"
        }),
    )
    .unwrap_err();
    assert_eq!(error, serde_json::json!("missing refresh token"));
}

#[tokio::test]
async fn ensure_attachment_cached_fails_when_gmail_rejects_the_fetch() {
    let app = app();
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = save_test_account(&auth_service, "gmail-rejects@example.com").await;
    insert_account_message_and_attachment(AttachedMessageSeed {
        storage: &storage,
        account_id: &account_id,
        message_id: "m1",
        attachment_ids: &["a1"],
    });

    let server = start_token_server(&account_id).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1/attachments/a1"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    manage_attachment_command_dependencies(&app, &storage, directory.path());
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let error = invoke(
        &webview,
        "ensure_attachment_cached",
        serde_json::json!({
            "accountId": account_id,
            "messageId": "m1",
            "attachmentId": "a1"
        }),
    )
    .unwrap_err();
    assert_eq!(
        error,
        serde_json::json!("Gmail request failed with status 404")
    );
}

#[tokio::test]
async fn read_and_stage_commands_fail_when_the_cached_entry_is_unreadable() {
    let app = app();
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    insert_account_message_and_attachment(AttachedMessageSeed {
        storage: &storage,
        account_id: "account-unreadable-cache",
        message_id: "m1",
        attachment_ids: &["for-bytes", "for-text", "for-stage"],
    });
    manage_attachment_command_dependencies(&app, &storage, directory.path());
    let server = mount_authenticated_gmail_server(
        "account-unreadable-cache",
        r"^/users/me/messages/m1/attachments/.+$",
    )
    .await;

    for attachment_id in ["for-bytes", "for-text", "for-stage"] {
        let entry = seed_cached_attachment(CachedAttachmentSeed {
            directory: directory.path(),
            account_id: "account-unreadable-cache",
            message_id: "m1",
            attachment_id: attachment_id,
            bytes: b"hello",
        });
        std::fs::remove_file(&entry).unwrap();
        std::fs::create_dir(&entry).unwrap();
    }

    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    for (command, body) in [
        (
            "read_attachment_bytes",
            serde_json::json!({ "accountId": "account-unreadable-cache", "messageId": "m1", "attachmentId": "for-bytes" }),
        ),
        (
            "read_attachment_text",
            serde_json::json!({ "accountId": "account-unreadable-cache", "messageId": "m1", "attachmentId": "for-text" }),
        ),
        (
            "stage_attachment_into_draft",
            serde_json::json!({ "accountId": "account-unreadable-cache", "messageId": "m1", "attachmentId": "for-stage", "owner": "draft-owner" }),
        ),
    ] {
        assert_unreadable_error(invoke(&webview, command, body).unwrap_err());
    }
    server.verify().await;
}

#[tokio::test]
async fn save_attachment_to_path_fails_when_the_destination_directory_does_not_exist() {
    let app = app();
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    insert_account_message_and_attachment(AttachedMessageSeed {
        storage: &storage,
        account_id: "account-bad-destination",
        message_id: "m1",
        attachment_ids: &["a1"],
    });
    manage_attachment_command_dependencies(&app, &storage, directory.path());
    let server = mount_authenticated_gmail_server(
        "account-bad-destination",
        r"^/users/me/messages/m1/attachments/a1$",
    )
    .await;

    seed_cached_attachment(CachedAttachmentSeed {
        directory: directory.path(),
        account_id: "account-bad-destination",
        message_id: "m1",
        attachment_id: "a1",
        bytes: b"hello",
    });

    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let destination = directory.path().join("missing-directory").join("out.txt");
    let error = invoke(
        &webview,
        "save_attachment_to_path",
        serde_json::json!({
            "accountId": "account-bad-destination",
            "messageId": "m1",
            "attachmentId": "a1",
            "destination": destination.to_string_lossy()
        }),
    )
    .unwrap_err();
    assert!(error.is_string());
    assert_ne!(error, serde_json::json!("missing refresh token"));
    server.verify().await;
}

#[tokio::test]
async fn stage_attachment_into_draft_fails_when_the_staging_directory_cannot_be_created() {
    let app = app();
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    insert_account_message_and_attachment(AttachedMessageSeed {
        storage: &storage,
        account_id: "account-blocked-staging",
        message_id: "m1",
        attachment_ids: &["a1"],
    });
    manage_attachment_command_dependencies(&app, &storage, directory.path());
    let server = mount_authenticated_gmail_server(
        "account-blocked-staging",
        r"^/users/me/messages/m1/attachments/a1$",
    )
    .await;

    seed_cached_attachment(CachedAttachmentSeed {
        directory: directory.path(),
        account_id: "account-blocked-staging",
        message_id: "m1",
        attachment_id: "a1",
        bytes: b"hello",
    });

    let blocked_account_segment = directory
        .path()
        .join("compose-staging")
        .join("drafts")
        .join("account-blocked-staging");
    std::fs::create_dir_all(blocked_account_segment.parent().unwrap()).unwrap();
    std::fs::write(&blocked_account_segment, b"not a directory").unwrap();

    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let error = invoke(
        &webview,
        "stage_attachment_into_draft",
        serde_json::json!({
            "accountId": "account-blocked-staging",
            "messageId": "m1",
            "attachmentId": "a1",
            "owner": "draft-owner"
        }),
    )
    .unwrap_err();
    assert!(error.is_string());
    assert_ne!(error, serde_json::json!("missing refresh token"));
    server.verify().await;
}
