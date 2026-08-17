use std::{collections::HashSet, sync::Arc};

use latentmail_lib::{
    auth::{save_refresh_token, AuthService},
    gmail::GmailClient,
    storage::{
        Account, AccountRepository, HtmlPresence, LabelRepository, Message, MessageRepository,
        Storage,
    },
    sync::{
        commands::{delete_draft, mutate_threads},
        create_queue_engine_with_events, noop_event_sink, SyncEngine, WorkRegistry,
    },
};
use tauri::Manager;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn seeded_engine() -> (Arc<SyncEngine>, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "a@example.com".into(),
            display_name: "A".into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 0,
            updated_at: 0,
        },
    )
    .unwrap();
    for label in ["INBOX", "UNREAD", "STARRED", "TRASH", "SPAM", "Label_1"] {
        LabelRepository::ensure_placeholder(&connection, "account", label).unwrap();
    }
    for (message_id, thread_id) in [("message-1", "thread-1"), ("message-2", "thread-2")] {
        MessageRepository::write_full_state(
            &connection,
            &Message {
                account_id: "account".into(),
                id: message_id.into(),
                thread_id: thread_id.into(),
                rfc_message_id: None,
                sender: "A".into(),
                recipients: "B".into(),
                subject: "Subject".into(),
                sent_at: 0,
                snippet: String::new(),
                html_body: None,
                plain_body: None,
                has_attachments: false,
                is_unread: true,
                is_starred: false,
                history_id: 1,
                truncated_body: None,
                html_presence: HtmlPresence::Absent,
            },
        )
        .unwrap();
        MessageRepository::set_label_membership(&connection, "account", message_id, "INBOX", true)
            .unwrap();
    }
    drop(connection);
    let registry = WorkRegistry::new();
    let queue =
        create_queue_engine_with_events(1_000, 1_000, Arc::clone(&registry), Arc::new(|_, _| {}));
    (
        SyncEngine::new(storage, queue, registry, noop_event_sink()),
        directory,
    )
}

fn app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

#[tokio::test(start_paused = true)]
async fn triage_label_deltas_cover_thread_and_bulk_actions() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .respond_with(|request: &wiremock::Request| {
            let id = request.url.path().rsplit('/').next().unwrap_or_default();
            ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": id, "threadId": id.replacen("message-", "thread-", 1), "historyId": "2",
            "labelIds": ["INBOX"], "snippet": "", "internalDate": "0", "payload": { "headers": [] }
        }))
        })
        .mount(&server)
        .await;
    let (engine, _directory) = seeded_engine();
    let client = GmailClient::with_base_url("token", server.uri());
    for (thread, add, remove) in [
        ("thread-1", vec!["TRASH"], vec![]),
        ("thread-1", vec!["SPAM"], vec![]),
        ("thread-1", vec![], vec!["SPAM"]),
        ("thread-1", vec!["STARRED"], vec![]),
        ("thread-1", vec![], vec!["UNREAD"]),
        ("thread-1", vec!["Label_1"], vec![]),
    ] {
        engine
            .mutate(
                "account",
                client.clone(),
                thread.into(),
                add.into_iter().map(str::to_owned).collect::<HashSet<_>>(),
                remove
                    .into_iter()
                    .map(str::to_owned)
                    .collect::<HashSet<_>>(),
            )
            .await
            .unwrap();
    }
    let first = engine.mutate(
        "account",
        client.clone(),
        "thread-1".into(),
        HashSet::from(["STARRED".into()]),
        HashSet::new(),
    );
    let second = engine.mutate(
        "account",
        client,
        "thread-2".into(),
        HashSet::from(["STARRED".into()]),
        HashSet::new(),
    );
    let _ = tokio::join!(first, second);
    let requests = server.received_requests().await.unwrap();
    let bodies = requests
        .iter()
        .filter(|request| request.url.path() == "/users/me/messages/batchModify")
        .map(|request| request.body_json::<serde_json::Value>().unwrap())
        .collect::<Vec<_>>();
    assert!(bodies
        .iter()
        .any(|body| body["addLabelIds"] == serde_json::json!(["TRASH"])));
    assert!(bodies
        .iter()
        .any(|body| body["addLabelIds"] == serde_json::json!(["SPAM"])));
    assert!(bodies
        .iter()
        .any(|body| body["removeLabelIds"] == serde_json::json!(["SPAM"])));
    assert!(bodies
        .iter()
        .any(|body| body["removeLabelIds"] == serde_json::json!(["UNREAD"])));
    assert!(bodies
        .iter()
        .any(|body| body["addLabelIds"] == serde_json::json!(["Label_1"])));
    assert!(bodies
        .iter()
        .any(|body| body["ids"].as_array().is_some_and(|ids| ids.len() == 2)));
}

#[tokio::test]
async fn draft_deletion_uses_the_drafts_endpoint_without_a_label_mutation() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/drafts/draft-1"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    GmailClient::with_base_url("token", server.uri())
        .delete_draft("draft-1")
        .await
        .unwrap();
    assert!(server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .all(|request| request.url.path() != "/users/me/messages/batchModify"));
}

#[tokio::test]
async fn draft_deletion_errors_when_gmail_lists_no_draft_for_the_message() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "access_token": "fresh", "token_type": "Bearer" }),
            ),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "drafts": [] })))
        .mount(&server)
        .await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    save_refresh_token("account", "refresh").unwrap();

    let (engine, directory) = seeded_engine();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let app = app();
    app.manage(storage);
    app.manage(AuthService::new(app.state::<Storage>().inner().clone()));
    app.manage(engine);

    let error = delete_draft(
        app.handle().clone(),
        app.state(),
        app.state(),
        app.state(),
        "account".into(),
        "message-1".into(),
    )
    .await
    .unwrap_err();
    assert!(error.contains("Gmail has no draft for message message-1"));
}

#[test]
fn deleting_a_draft_thread_through_triage_never_batch_modifies_it() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "access_token": "fresh", "token_type": "Bearer" }),
            ))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/users/me/drafts"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "drafts": [{ "id": "draft-99", "message": { "id": "message-draft" } }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/users/me/drafts/draft-99"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
        std::env::set_var(
            "LATENTMAIL_GOOGLE_TOKEN_URL",
            format!("{}/token", server.uri()),
        );
        std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
        save_refresh_token("account-draft", "refresh").unwrap();

        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
        let connection = storage.connection().unwrap();
        AccountRepository::upsert(
            &connection,
            &Account {
                id: "account-draft".into(),
                email: "draft@example.com".into(),
                display_name: "Draft".into(),
                avatar_url: None,
                history_id: None,
                needs_reauthentication: false,
                created_at: 0,
                updated_at: 0,
            },
        )
        .unwrap();
        LabelRepository::ensure_placeholder(&connection, "account-draft", "DRAFT").unwrap();
        MessageRepository::write_full_state(
            &connection,
            &Message {
                account_id: "account-draft".into(),
                id: "message-draft".into(),
                thread_id: "thread-draft".into(),
                rfc_message_id: None,
                sender: "A".into(),
                recipients: "B".into(),
                subject: "Draft".into(),
                sent_at: 0,
                snippet: String::new(),
                html_body: None,
                plain_body: None,
                has_attachments: false,
                is_unread: false,
                is_starred: false,
                history_id: 1,
                truncated_body: None,
                html_presence: HtmlPresence::Absent,
            },
        )
        .unwrap();
        MessageRepository::set_label_membership(
            &connection,
            "account-draft",
            "message-draft",
            "DRAFT",
            true,
        )
        .unwrap();
        drop(connection);

        let registry = WorkRegistry::new();
        let queue = latentmail_lib::sync::create_queue_engine(1_000, 1_000, Arc::clone(&registry));
        let engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());
        let app = app();
        app.manage(storage.clone());
        app.manage(AuthService::new(storage));
        app.manage(engine);
        mutate_threads(
            app.handle().clone(),
            app.state(),
            app.state(),
            "account-draft".into(),
            vec!["thread-draft".into()],
            vec!["TRASH".into()],
            vec![],
        )
        .await
        .unwrap();
        let requests = server.received_requests().await.unwrap();
        assert!(requests
            .iter()
            .all(|request| request.url.path() != "/users/me/messages/batchModify"));
    });
}


#[test]
fn a_cached_draft_id_is_reused_without_re_listing_drafts() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "access_token": "fresh", "token_type": "Bearer" }),
            ))
            .mount(&server)
            .await;

        Mock::given(method("DELETE"))
            .and(path("/users/me/drafts/cached-draft-id"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
        std::env::set_var(
            "LATENTMAIL_GOOGLE_TOKEN_URL",
            format!("{}/token", server.uri()),
        );
        std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
        save_refresh_token("account-cached-draft", "refresh").unwrap();

        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
        let connection = storage.connection().unwrap();
        AccountRepository::upsert(
            &connection,
            &Account {
                id: "account-cached-draft".into(),
                email: "draft@example.com".into(),
                display_name: "Draft".into(),
                avatar_url: None,
                history_id: None,
                needs_reauthentication: false,
                created_at: 0,
                updated_at: 0,
            },
        )
        .unwrap();
        MessageRepository::write_full_state(
            &connection,
            &Message {
                account_id: "account-cached-draft".into(),
                id: "message-cached".into(),
                thread_id: "thread-cached".into(),
                rfc_message_id: None,
                sender: "A".into(),
                recipients: "B".into(),
                subject: "Draft".into(),
                sent_at: 0,
                snippet: String::new(),
                html_body: None,
                plain_body: None,
                has_attachments: false,
                is_unread: false,
                is_starred: false,
                history_id: 1,
                truncated_body: None,
                html_presence: HtmlPresence::Absent,
            },
        )
        .unwrap();
        MessageRepository::set_draft_id(
            &connection,
            "account-cached-draft",
            "message-cached",
            "cached-draft-id",
        )
        .unwrap();
        drop(connection);

        let registry = WorkRegistry::new();
        let queue = latentmail_lib::sync::create_queue_engine(1_000, 1_000, Arc::clone(&registry));
        let engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());
        let app = app();
        app.manage(storage.clone());
        app.manage(AuthService::new(storage));
        app.manage(engine);
        delete_draft(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            "account-cached-draft".into(),
            "message-cached".into(),
        )
        .await
        .unwrap();
        server.verify().await;
    });
}
