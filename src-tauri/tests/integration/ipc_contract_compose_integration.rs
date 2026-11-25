use crate::ipc_contract_core_integration::{
    app, build_mail_webview, invoke, save_test_account, upsert_basic_account,
};
use latentmail_lib::auth::AuthService;
use latentmail_lib::contacts::ContactObservation;
use latentmail_lib::storage::{
    Attachment, AttachmentRepository, HtmlPresence, InlinePart, LabelMembershipChange,
    LabelRepository, Message, MessageKey, MessageRepository, RecipientRolesUpdate, Storage, Thread,
    ThreadIdentity, ThreadRepository, TraversalCursor, TraversalCursorRepository, TraversalKind,
};
use std::sync::Arc;
use tauri::Manager;

fn seed_rich_reply_conversation(connection: &rusqlite::Connection, account_id: &str) {
    upsert_basic_account(connection, account_id, "me@example.com");
    LabelRepository::ensure_placeholder(connection, account_id, "INBOX").unwrap();
    ThreadRepository::upsert(
        connection,
        &Thread {
            account_id: account_id.into(),
            id: "thread-1".into(),
            subject: "Hello".into(),
            participants: "Alice <alice@example.com>".into(),
            latest_at: 1,
            message_count: 1,
            is_unread: false,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
            sender_identity: ThreadIdentity {
                display: "Alice".into(),
                address: Some("alice@example.com".into()),
            },
            recipient_identity: None,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(
        connection,
        &Message {
            account_id: account_id.into(),
            id: "message-1".into(),
            thread_id: "thread-1".into(),
            rfc_message_id: Some("<m1@example.com>".into()),
            sender: "Alice <alice@example.com>".into(),
            recipients: "me@example.com".into(),
            subject: "Hello".into(),
            sent_at: 1,
            snippet: "hi".into(),
            html_body: Some(
                "<p>hi <img src=\"cid:logo\"></p><img src=\"https://tracker.example/pixel.png\">"
                    .into(),
            ),
            plain_body: Some("hi".into()),
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 1,
            truncated_body: None,
            html_presence: HtmlPresence::Present,
        },
    )
    .unwrap();
    seed_rich_reply_metadata(connection, account_id);
}

fn seed_rich_reply_metadata(connection: &rusqlite::Connection, account_id: &str) {
    let key = MessageKey {
        account_id: account_id,
        message_id: "message-1",
    };
    MessageRepository::set_recipient_roles(
        connection,
        key,
        RecipientRolesUpdate {
            to: "me@example.com, bob@example.com",
            cc: "cc@example.com",
            bcc: "",
            references: Some("<prev@example.com>"),
        },
    )
    .unwrap();
    MessageRepository::replace_inline_parts(
        connection,
        key,
        &[InlinePart {
            content_id: "logo".into(),
            mime_type: "image/png".into(),
            bytes: b"img".to_vec(),
        }],
    )
    .unwrap();
    MessageRepository::set_label_membership(
        connection,
        key,
        LabelMembershipChange {
            label_id: "INBOX",
            present: true,
        },
    )
    .unwrap();
    AttachmentRepository::replace_for_message(
        connection,
        key,
        &[Attachment {
            attachment_id: "gmail-att-1".into(),
            filename: "report.pdf".into(),
            mime_type: "application/pdf".into(),
            size: 2048,
            position: 0,
        }],
    )
    .unwrap();
    latentmail_lib::contacts::observe(
        connection,
        ContactObservation {
            account_id: account_id,
            mailbox: "Alice <alice@example.com>",
            seen_at: chrono::Utc::now().timestamp(),
        },
    )
    .unwrap();
    seed_traversal_cursors(connection, account_id);
    ThreadRepository::recompute(connection, account_id, "thread-1").unwrap();
}

fn seed_traversal_cursors(connection: &rusqlite::Connection, account_id: &str) {
    TraversalCursorRepository::upsert(
        connection,
        &TraversalCursor {
            account_id: account_id.into(),
            kind: TraversalKind::Backfill,
            position: None,
            discovered_count: 20,
            persisted_count: 20,
            completed: true,
            last_advanced_at: 1_700_000_100,
            resumed: false,
        },
    )
    .unwrap();
    TraversalCursorRepository::upsert(
        connection,
        &TraversalCursor {
            account_id: account_id.into(),
            kind: TraversalKind::Reconciliation,
            position: Some("token".into()),
            discovered_count: 4,
            persisted_count: 2,
            completed: false,
            last_advanced_at: 1_700_000_000,
            resumed: true,
        },
    )
    .unwrap();
}

fn seed_inline_only_message(connection: &rusqlite::Connection, account_id: &str) {
    upsert_basic_account(connection, account_id, "me@example.com");
    upsert_inline_only_thread(connection, account_id);
    write_inline_only_message(connection, account_id);
    attach_inline_logo(connection, account_id);
    ThreadRepository::recompute(connection, account_id, "thread-inline").unwrap();
}

fn upsert_inline_only_thread(connection: &rusqlite::Connection, account_id: &str) {
    ThreadRepository::upsert(
        connection,
        &Thread {
            account_id: account_id.into(),
            id: "thread-inline".into(),
            subject: "Logo".into(),
            participants: "Alice <alice@example.com>".into(),
            latest_at: 1,
            message_count: 1,
            is_unread: false,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
            sender_identity: ThreadIdentity {
                display: "Alice".into(),
                address: Some("alice@example.com".into()),
            },
            recipient_identity: None,
        },
    )
    .unwrap();
}

fn write_inline_only_message(connection: &rusqlite::Connection, account_id: &str) {
    MessageRepository::write_full_state(
        connection,
        &Message {
            account_id: account_id.into(),
            id: "message-inline".into(),
            thread_id: "thread-inline".into(),
            rfc_message_id: Some("<inline@example.com>".into()),
            sender: "Alice <alice@example.com>".into(),
            recipients: "me@example.com".into(),
            subject: "Logo".into(),
            sent_at: 1,
            snippet: "logo".into(),
            html_body: Some("<img src=\"cid:logo\">".into()),
            plain_body: None,
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 1,
            truncated_body: None,
            html_presence: HtmlPresence::Present,
        },
    )
    .unwrap();
}

fn attach_inline_logo(connection: &rusqlite::Connection, account_id: &str) {
    let key = MessageKey {
        account_id: account_id,
        message_id: "message-inline",
    };
    MessageRepository::set_recipient_roles(
        connection,
        key,
        RecipientRolesUpdate {
            to: "me@example.com",
            cc: "",
            bcc: "",
            references: None,
        },
    )
    .unwrap();
    MessageRepository::replace_inline_parts(
        connection,
        key,
        &[InlinePart {
            content_id: "logo".into(),
            mime_type: "image/png".into(),
            bytes: b"img".to_vec(),
        }],
    )
    .unwrap();
    AttachmentRepository::replace_for_message(connection, key, &[]).unwrap();
}

#[test]
fn staging_commands_stage_and_release_through_real_ipc() {
    let directory = tempfile::tempdir().unwrap();
    let staging = Arc::new(latentmail_lib::compose::staging::Staging::new(
        directory.path().join("staged"),
    ));
    let source = directory.path().join("source.txt");
    std::fs::write(&source, b"attachment").unwrap();

    let app = app();
    app.manage(staging);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let staged_from_path = invoke(
        &webview,
        "stage_attachment_from_path",
        serde_json::json!({
            "accountId": "account", "owner": "draft",
            "path": source.to_string_lossy(), "mimeType": "text/plain", "contentId": null,
        }),
    )
    .unwrap();
    assert_eq!(staged_from_path["filename"], "source.txt");
    assert!(staged_from_path["path"].as_str().unwrap().contains("draft"));
    assert_eq!(staged_from_path["size"], b"attachment".len() as u64);

    let staged_from_bytes = invoke(
        &webview,
        "stage_attachment_from_bytes",
        serde_json::json!({
            "accountId": "account", "owner": "draft", "filename": "inline.png",
            "mimeType": "image/png", "contentId": "cid:1", "bytes": [1, 2, 3],
        }),
    )
    .unwrap();
    assert_eq!(staged_from_bytes["contentId"], "cid:1");
    assert_eq!(staged_from_bytes["size"], 3);

    for id in [
        staged_from_path["id"].clone(),
        serde_json::json!("never-staged"),
    ] {
        assert!(invoke(
            &webview,
            "release_staged_attachment",
            serde_json::json!({ "accountId": "account", "owner": "draft", "id": id }),
        )
        .is_ok());
    }
}

#[tokio::test]
async fn reply_contacts_html_conversation_and_traversal_status_round_trip_through_ipc() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = save_test_account(&auth_service, "me@example.com").await;
    seed_rich_reply_conversation(&storage.connection().unwrap(), &account_id);

    let (_app, webview) = build_mail_webview(storage, auth_service, false);

    assert_reply_all_context(&webview, &account_id);
    assert_forward_context(&webview, &account_id);
    assert_contact_lookup(&webview, &account_id);
    assert_conversation_blocks_remote_images(&webview, &account_id);
    assert_traversal_status_complete(&webview, &account_id);
}

fn assert_reply_all_context(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    let reply = invoke(
        webview,
        "reply_context",
        serde_json::json!({
            "accountId": account_id, "messageId": "message-1",
            "accountEmail": "me@example.com", "replyAll": true, "forward": false,
        }),
    )
    .unwrap();
    assert_eq!(reply["subject"], "Re: Hello");
    assert_eq!(reply["to"][0], "Alice <alice@example.com>");
    assert!(reply["cc"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "cc@example.com"));
    assert!(reply["attachments"].as_array().unwrap().is_empty());
}

fn assert_forward_context(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    let forwarded = invoke(
        webview,
        "reply_context",
        serde_json::json!({
            "accountId": account_id, "messageId": "message-1",
            "accountEmail": "me@example.com", "replyAll": false, "forward": true,
        }),
    )
    .unwrap();
    assert_eq!(forwarded["subject"], "Fwd: Hello");
    assert!(forwarded["targetThreadId"].is_null());
    assert_eq!(forwarded["attachments"][0]["id"], "gmail-att-1");
    assert_eq!(forwarded["attachments"][0]["filename"], "report.pdf");
    assert_eq!(forwarded["attachments"][0]["mimeType"], "application/pdf");
    assert_eq!(forwarded["attachments"][0]["size"], 2048);
}

fn assert_contact_lookup(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    let contacts = invoke(
        webview,
        "lookup_contacts",
        serde_json::json!({ "accountId": account_id, "query": "al" }),
    )
    .unwrap();
    assert_eq!(contacts[0]["address"], "alice@example.com");
    assert_eq!(contacts[0]["displayName"], "Alice");
}

fn assert_conversation_blocks_remote_images(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    let conversation = invoke(
        webview,
        "load_conversation",
        serde_json::json!({
            "accountId": account_id, "threadId": "thread-1",
            "imagePolicy": { "alwaysLoad": false, "allowedSenders": [], "loadFor": [] },
        }),
    )
    .unwrap();
    assert_eq!(conversation["messages"][0]["htmlPresence"], "present");
    assert_eq!(conversation["messages"][0]["remoteImagesBlocked"], true);
    assert_eq!(conversation["messages"][0]["remoteImagesAllowed"], false);
}

fn assert_traversal_status_complete(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    let status = invoke(
        webview,
        "read_traversal_status",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(status["state"], "complete");
    assert_eq!(status["kind"], "backfill");
    assert_eq!(status["discoveredCount"], 20);
}

#[tokio::test]
async fn forwarding_a_message_whose_only_attachment_shaped_parts_are_inline_images_stages_none() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let account_id = "account-inline-only".to_owned();
    seed_inline_only_message(&storage.connection().unwrap(), &account_id);

    let app = app();
    app.manage(storage);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let forwarded = invoke(
        &webview,
        "reply_context",
        serde_json::json!({
            "accountId": account_id, "messageId": "message-inline",
            "accountEmail": "me@example.com", "replyAll": false, "forward": true,
        }),
    )
    .unwrap();
    assert!(forwarded["attachments"].as_array().unwrap().is_empty());
}
