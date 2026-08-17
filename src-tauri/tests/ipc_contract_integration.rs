use latentmail_lib::auth::AuthService;
use latentmail_lib::ipc::{
    health_check, health_response, open_external_url, pause_queue, read_queue_summary, register,
    resume_queue, validate_external_url,
};
use latentmail_lib::queue::QueueEngine;
use latentmail_lib::settings::SettingsService;
use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, InlinePart, LabelRepository, Message,
    MessageRepository, Storage, Thread, ThreadIdentity, ThreadRepository,
};
use latentmail_lib::sync::{noop_event_sink, SyncEngine, WorkRegistry};
use tauri::{ipc::CallbackFn, ipc::InvokeBody, test::INVOKE_KEY, webview::InvokeRequest, Manager};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn app() -> tauri::App<tauri::test::MockRuntime> {
    register(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}


fn invoke(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    tauri::test::get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|response| response.deserialize::<serde_json::Value>().unwrap())
}

#[test]
fn health_check_has_an_ok_status() {
    let health = health_response();
    assert_eq!(serde_json::to_value(health).unwrap()["status"], "ok");
}

#[test]
fn external_urls_are_limited_to_http_s() {
    assert!(validate_external_url("https://example.com").is_ok());
    assert!(validate_external_url("file:///tmp/message.html").is_err());
    assert!(validate_external_url("not a URL").is_err());
}

#[test]
fn health_command_emits_and_external_opening_uses_the_test_safe_boundary() {
    let app = app();

    assert_eq!(
        serde_json::to_value(health_check(app.handle().clone()).unwrap()).unwrap()["status"],
        "ok"
    );
    assert!(open_external_url(app.handle().clone(), "https://example.com".to_owned()).is_err());
}

#[test]
fn pause_and_resume_queue_commands_emit_summaries_and_toggle_the_engine() {
    let app = app();
    app.manage(QueueEngine::no_op());

    let paused = pause_queue(app.handle().clone(), app.state()).unwrap();
    assert_eq!(paused.pending, 0);

    let resumed = resume_queue(app.handle().clone(), app.state()).unwrap();
    assert_eq!(resumed.pending, 0);

    let summary = read_queue_summary(app.state());
    assert_eq!(summary.pending, 0);
}


#[test]
fn every_registered_command_is_reachable_through_real_ipc_dispatch() {
    let app = app();
    let directory = tempfile::tempdir().unwrap();
    app.manage(QueueEngine::no_op());
    app.manage(AuthService::new(
        Storage::open(directory.path().join("mail.sqlite")).unwrap(),
    ));
    app.manage(SettingsService::new(
        Storage::open(directory.path().join("mail.sqlite")).unwrap(),
    ));
    let avatar_storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let avatar_cache = latentmail_lib::avatars::cache::AvatarCache::new(
        avatar_storage.clone(),
        directory.path().join("avatar-cache"),
    )
    .unwrap();
    app.manage(latentmail_lib::avatars::AvatarService::new(
        avatar_cache,
        avatar_storage,
        SettingsService::new(Storage::open(directory.path().join("mail.sqlite")).unwrap()),
    ));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert_eq!(
        invoke(&webview, "health_check", serde_json::json!({})).unwrap()["status"],
        "ok"
    );
    assert!(invoke(
        &webview,
        "open_external_url",
        serde_json::json!({ "url": "https://example.com" })
    )
    .is_err());
    assert!(invoke(
        &webview,
        "write_frontend_log",

        serde_json::json!({ "level": "info", "message": "from ipc" })
    )
    .is_ok());
    assert_eq!(
        invoke(&webview, "pause_queue", serde_json::json!({}))
            .unwrap()
            .get("pending")
            .unwrap(),
        0
    );
    assert_eq!(
        invoke(&webview, "resume_queue", serde_json::json!({}))
            .unwrap()
            .get("pending")
            .unwrap(),
        0
    );
    assert_eq!(
        invoke(&webview, "read_queue_summary", serde_json::json!({}))
            .unwrap()
            .get("pending")
            .unwrap(),
        0
    );
    assert_eq!(
        invoke(&webview, "list_accounts", serde_json::json!({})).unwrap(),
        serde_json::json!([])
    );

    assert!(invoke(&webview, "begin_sign_in", serde_json::json!({})).is_err());
    assert!(invoke(
        &webview,
        "begin_reauthentication",
        serde_json::json!({ "accountId": "any" })
    )
    .is_err());
    let settings = invoke(&webview, "read_settings", serde_json::json!({})).unwrap();
    assert_eq!(settings["theme"], "system");
    assert!(invoke(
        &webview,
        "write_setting",
        serde_json::json!({ "key": "theme", "value": "dark" })
    )
    .is_ok());
    assert_eq!(
        invoke(
            &webview,
            "read_sender_avatar",
            serde_json::json!({ "domain": "example.com" })
        )
        .unwrap(),
        serde_json::Value::Null
    );
    assert_eq!(
        invoke(
            &webview,
            "read_account_avatar",
            serde_json::json!({ "accountId": "unknown" })
        )
        .unwrap(),
        serde_json::Value::Null
    );
}

#[test]
fn storage_backed_commands_return_database_errors_through_real_ipc() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("mail.sqlite");
    let storage = Storage::open(&database).unwrap();
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());
    let app = app();
    app.manage(storage.clone());
    app.manage(AuthService::new(storage.clone()));
    app.manage(SettingsService::new(storage));
    app.manage(engine);
    app.manage(std::sync::Arc::new(
        latentmail_lib::compose::staging::Staging::new(directory.path().join("staged")),
    ));
    std::fs::remove_dir_all(directory.path()).unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    for (command, body) in [
        ("list_accounts", serde_json::json!({})),
        ("read_settings", serde_json::json!({})),
        (
            "write_setting",
            serde_json::json!({ "key": "theme", "value": "dark" }),
        ),
        ("list_labels", serde_json::json!({ "accountId": "account" })),
        (
            "lookup_contacts",
            serde_json::json!({ "accountId": "account", "query": "al" }),
        ),
        (
            "reply_context",
            serde_json::json!({ "accountId": "account", "messageId": "message", "accountEmail": "me@example.com", "replyAll": false, "forward": false }),
        ),
        (
            "stage_attachment_from_path",
            serde_json::json!({ "accountId": "account", "owner": "draft", "path": "/does/not/exist", "mimeType": "text/plain", "contentId": null }),
        ),
        (
            "list_threads",
            serde_json::json!({ "accountId": "account", "labelId": null, "cursor": null, "limit": null }),
        ),
        (
            "load_conversation",
            serde_json::json!({ "accountId": "account", "threadId": "thread" }),
        ),
        (
            "fetch_message_body",
            serde_json::json!({ "accountId": "account", "messageId": "message" }),
        ),
        (
            "create_label",
            serde_json::json!({ "accountId": "account", "name": "Clients", "colorId": null }),
        ),
        (
            "rename_label",
            serde_json::json!({ "accountId": "account", "labelId": "Label_1", "name": "Clients" }),
        ),
        (
            "recolor_label",
            serde_json::json!({ "accountId": "account", "labelId": "Label_1", "colorId": "blue" }),
        ),
        (
            "delete_label",
            serde_json::json!({ "accountId": "account", "labelId": "Label_1" }),
        ),
        (
            "read_traversal_status",
            serde_json::json!({ "accountId": "account" }),
        ),
    ] {
        assert!(
            invoke(&webview, command, body).is_err(),
            "{command} must surface storage failure"
        );
    }

    for command in ["mutate_threads", "mutate_messages"] {
        assert!(invoke(
            &webview,
            command,
            serde_json::json!({ "accountId": "account", "threadIds": ["thread"], "messageIds": ["message"], "add": ["DRAFT"], "remove": [] }),
        )
        .is_err());
    }

    for (command, body) in [
        (
            "delete_threads",
            serde_json::json!({ "accountId": "account", "threadIds": ["thread"] }),
        ),
        (
            "move_threads",
            serde_json::json!({ "accountId": "account", "threadIds": ["thread"], "destination": "SPAM" }),
        ),
        (
            "delete_messages",
            serde_json::json!({ "accountId": "account", "messageIds": ["message"] }),
        ),
        (
            "move_messages",
            serde_json::json!({ "accountId": "account", "messageIds": ["message"], "destination": "SPAM" }),
        ),
    ] {
        assert!(
            invoke(&webview, command, body).is_err(),
            "{command} must surface storage failure"
        );
    }

    for (command, body) in [
        (
            "move_threads",
            serde_json::json!({ "accountId": "account", "threadIds": ["thread"], "destination": "DRAFT" }),
        ),
        (
            "move_messages",
            serde_json::json!({ "accountId": "account", "messageIds": ["message"], "destination": "DRAFT" }),
        ),
    ] {
        let error = invoke(&webview, command, body).unwrap_err();
        assert!(error.to_string().contains("not a valid move destination"));
    }
}



#[tokio::test]
async fn every_phase_3_command_is_reachable_through_real_ipc_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = {
        auth_service
            .save_account("me@example.com".into(), "refresh-token".into(), None)
            .await
            .unwrap();
        auth_service.accounts().await.unwrap()[0].id.clone()
    };

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-token", "token_type": "Bearer"
        })))
        .mount(&server)
        .await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token(&account_id, "refresh-token").unwrap();


    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: account_id.clone(),
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
    for label_id in ["INBOX", "STARRED", "TRASH"] {
        LabelRepository::ensure_placeholder(&connection, &account_id, label_id).unwrap();
    }
    ThreadRepository::upsert(
        &connection,
        &Thread {
            account_id: account_id.clone(),
            id: "thread-1".into(),
            subject: "Subject".into(),
            participants: "Alice <a@example.com>".into(),
            latest_at: 1,
            message_count: 1,
            is_unread: false,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
            sender_identity: ThreadIdentity {
                display: "Alice".into(),
                address: Some("a@example.com".into()),
            },
            recipient_identity: None,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: account_id.clone(),
            id: "message-1".into(),
            thread_id: "thread-1".into(),
            rfc_message_id: None,
            sender: "alice@example.com".into(),
            recipients: "me@example.com".into(),
            subject: "Subject".into(),
            sent_at: 1,
            snippet: "hi".into(),
            html_body: None,
            plain_body: Some("hi".into()),
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 1,
            truncated_body: None,
            html_presence: HtmlPresence::Absent,
        },
    )
    .unwrap();
    MessageRepository::set_label_membership(&connection, &account_id, "message-1", "INBOX", true)
        .unwrap();
    ThreadRepository::upsert(
        &connection,
        &Thread {
            account_id: account_id.clone(),
            id: "thread-2".into(),
            subject: "Subject".into(),
            participants: "Alice <a@example.com>".into(),
            latest_at: 2,
            message_count: 1,
            is_unread: false,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
            sender_identity: ThreadIdentity {
                display: "Alice".into(),
                address: Some("a@example.com".into()),
            },
            recipient_identity: None,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: account_id.clone(),
            id: "message-2".into(),
            thread_id: "thread-2".into(),
            rfc_message_id: None,
            sender: "alice@example.com".into(),
            recipients: "me@example.com".into(),
            subject: "Subject".into(),
            sent_at: 2,
            snippet: "hi".into(),
            html_body: None,
            plain_body: Some("hi".into()),
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 1,
            truncated_body: None,
            html_presence: HtmlPresence::Absent,
        },
    )
    .unwrap();
    MessageRepository::set_label_membership(&connection, &account_id, "message-2", "INBOX", true)
        .unwrap();
    drop(connection);

    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-1", "threadId": "thread-1", "historyId": "5",
            "labelIds": ["INBOX", "STARRED"], "snippet": "hi", "internalDate": "1000",
            "payload": { "mimeType": "text/plain", "headers": [], "body": { "data": "aGk" } }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "drafts": [{ "id": "draft-9", "message": { "id": "message-1" } }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/drafts/draft-9"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "Label_1", "name": "Clients", "type": "user",
            "color": { "textColor": "#ffffff", "backgroundColor": "#4a86e8" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("PATCH"))
        .and(path("/users/me/labels/Label_1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "Label_1", "name": "Customers", "type": "user",
            "color": { "textColor": "#ffffff", "backgroundColor": "#fb4c2f" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/labels/Label_1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let sync_engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());

    let app = app();
    app.manage(storage);
    app.manage(auth_service);
    app.manage(sync_engine);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();


    let status = invoke(
        &webview,
        "read_traversal_status",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(status["state"], "notStarted");

    let search_results = invoke(
        &webview,
        "search_threads",
        serde_json::json!({ "accountId": account_id, "query": "hi" }),
    )
    .unwrap();
    assert_eq!(search_results["items"][0]["id"], "thread-2");
    assert_eq!(search_results["items"][1]["id"], "thread-1");
    assert_eq!(search_results["total"], 2);
    assert!(search_results["nextCursor"].is_null());

    let first_page = invoke(
        &webview,
        "search_threads",
        serde_json::json!({ "accountId": account_id, "query": "hi", "limit": 1 }),
    )
    .unwrap();
    assert_eq!(first_page["items"][0]["id"], "thread-2");
    assert_eq!(first_page["total"], 2);
    let cursor = first_page["nextCursor"].clone();
    assert!(!cursor.is_null());

    let second_page = invoke(
        &webview,
        "search_threads",
        serde_json::json!({ "accountId": account_id, "query": "hi", "limit": 1, "cursor": cursor }),
    )
    .unwrap();
    assert_eq!(second_page["items"][0]["id"], "thread-1");
    assert!(second_page["nextCursor"].is_null());

    let scoped_search = invoke(
        &webview,
        "search_threads",
        serde_json::json!({
            "accountId": account_id,
            "query": "hi",
            "scope": { "kind": "all" }
        }),
    )
    .unwrap();
    assert_eq!(scoped_search["total"], 2);

    let blank_search = invoke(
        &webview,
        "search_threads",
        serde_json::json!({ "accountId": account_id, "query": "   " }),
    )
    .unwrap();
    assert_eq!(blank_search["items"].as_array().unwrap().len(), 0);
    assert_eq!(blank_search["total"], 0);

    let empty_search = invoke(
        &webview,
        "search_threads",
        serde_json::json!({ "accountId": account_id, "query": "nonexistentterm" }),
    )
    .unwrap();
    assert_eq!(empty_search["items"].as_array().unwrap().len(), 0);
    assert_eq!(empty_search["total"], 0);

    let parsed = invoke(
        &webview,
        "parse_search_query",
        serde_json::json!({ "query": "from:alice is:unread" }),
    )
    .unwrap();
    assert_eq!(parsed["from"], "alice");
    assert_eq!(parsed["hasTextTerm"], true);

    let fully_parsed = invoke(
        &webview,
        "parse_search_query",
        serde_json::json!({
            "query": "to:alice subject:invoice label:INBOX is:starred has:attachment after:2020-01-01 before:2026-01-01 bareword"
        }),
    )
    .unwrap();
    assert_eq!(fully_parsed["to"], "alice");
    assert_eq!(fully_parsed["subject"], "invoice");
    assert!(fully_parsed["includes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|term| term == "bareword"));
    let predicate_kinds: Vec<String> = fully_parsed["predicates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|predicate| predicate["kind"].as_str().unwrap().to_owned())
        .collect();
    assert!(predicate_kinds.contains(&"label".to_owned()));
    assert!(predicate_kinds.contains(&"starred".to_owned()));
    assert!(predicate_kinds.contains(&"hasAttachment".to_owned()));
    assert!(predicate_kinds.contains(&"sentAfter".to_owned()));
    assert!(predicate_kinds.contains(&"sentBefore".to_owned()));

    let lone_negation_parsed = invoke(
        &webview,
        "parse_search_query",
        serde_json::json!({ "query": "is:starred has:attachment -promo" }),
    )
    .unwrap();
    let lone_negation_kinds: Vec<String> = lone_negation_parsed["predicates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|predicate| predicate["kind"].as_str().unwrap().to_owned())
        .collect();
    assert!(lone_negation_kinds.contains(&"textExcludes".to_owned()));

    assert!(invoke(
        &webview,
        "parse_search_query",
        serde_json::json!({ "query": "a".repeat(2049) })
    )
    .is_err());


    let created = invoke(
        &webview,
        "create_label",
        serde_json::json!({ "accountId": account_id, "name": "Clients", "colorId": "blue" }),
    )
    .unwrap();
    assert_eq!(created["id"], "Label_1");
    assert_eq!(created["color"]["background"], "#4a86e8");

    let renamed = invoke(
        &webview,
        "rename_label",
        serde_json::json!({ "accountId": account_id, "labelId": "Label_1", "name": "Customers" }),
    )
    .unwrap();
    assert_eq!(renamed["name"], "Customers");

    let recolored = invoke(
        &webview,
        "recolor_label",
        serde_json::json!({ "accountId": account_id, "labelId": "Label_1", "colorId": "red" }),
    )
    .unwrap();
    assert_eq!(recolored["color"]["background"], "#fb4c2f");

    assert!(invoke(
        &webview,
        "delete_label",
        serde_json::json!({ "accountId": account_id, "labelId": "Label_1" })
    )
    .is_ok());


    assert!(invoke(
        &webview,
        "create_label",
        serde_json::json!({ "accountId": account_id, "name": "Bogus", "colorId": "not-real" })
    )
    .is_err());


    let results = invoke(
        &webview,
        "mutate_threads",
        serde_json::json!({
            "accountId": account_id,
            "threadIds": ["thread-1"],
            "add": ["STARRED"],
            "remove": []
        }),
    )
    .unwrap();
    assert_eq!(results[0]["threadId"], "thread-1");
    assert_eq!(results[0]["outcome"], "applied");

    let moved = invoke(
        &webview,
        "move_threads",
        serde_json::json!({
            "accountId": account_id,
            "threadIds": ["thread-1"],
            "destination": "SPAM"
        }),
    )
    .unwrap();
    assert_eq!(moved[0]["threadId"], "thread-1");

    let deleted = invoke(
        &webview,
        "delete_threads",
        serde_json::json!({
            "accountId": account_id,
            "threadIds": ["thread-1"]
        }),
    )
    .unwrap();
    assert_eq!(deleted[0]["threadId"], "thread-1");

    assert!(invoke(
        &webview,
        "move_messages",
        serde_json::json!({
            "accountId": account_id,
            "messageIds": ["message-1"],
            "destination": "INBOX"
        })
    )
    .is_ok());

    assert!(invoke(
        &webview,
        "delete_messages",
        serde_json::json!({
            "accountId": account_id,
            "messageIds": ["message-1"]
        })
    )
    .is_ok());


    assert!(invoke(
        &webview,
        "delete_draft",
        serde_json::json!({ "accountId": account_id, "messageId": "message-1" })
    )
    .is_ok());


    let second = invoke(
        &webview,
        "create_label",
        serde_json::json!({ "accountId": account_id, "name": "Team A", "colorId": null }),
    )
    .unwrap();
    assert_eq!(second["id"], "Label_1");
    assert!(invoke(
        &webview,
        "recolor_label",
        serde_json::json!({ "accountId": account_id, "labelId": "Label_1", "colorId": "nope" })
    )
    .is_err());
}


#[tokio::test]
async fn mail_read_and_single_thread_triage_commands_are_reachable_through_real_ipc_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = {
        auth_service
            .save_account("me@example.com".into(), "refresh-token".into(), None)
            .await
            .unwrap();
        auth_service.accounts().await.unwrap()[0].id.clone()
    };

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-token", "token_type": "Bearer"
        })))
        .mount(&server)
        .await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token(&account_id, "refresh-token").unwrap();

    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: account_id.clone(),
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
    for label_id in ["INBOX", "UNREAD", "STARRED"] {
        LabelRepository::ensure_placeholder(&connection, &account_id, label_id).unwrap();
    }
    ThreadRepository::upsert(
        &connection,
        &Thread {
            account_id: account_id.clone(),
            id: "thread-1".into(),
            subject: "Subject".into(),
            participants: "Alice <a@example.com>".into(),
            latest_at: 1,
            message_count: 1,
            is_unread: true,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
            sender_identity: ThreadIdentity {
                display: "Alice".into(),
                address: Some("a@example.com".into()),
            },
            recipient_identity: None,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: account_id.clone(),
            id: "message-1".into(),
            thread_id: "thread-1".into(),
            rfc_message_id: None,
            sender: "alice@example.com".into(),
            recipients: "me@example.com".into(),
            subject: "Subject".into(),
            sent_at: 1,
            snippet: "hi".into(),
            html_body: None,
            plain_body: Some("hi".into()),
            has_attachments: false,
            is_unread: true,
            is_starred: false,
            history_id: 1,
            truncated_body: None,
            html_presence: HtmlPresence::Absent,
        },
    )
    .unwrap();
    MessageRepository::set_label_membership(&connection, &account_id, "message-1", "INBOX", true)
        .unwrap();
    MessageRepository::set_label_membership(&connection, &account_id, "message-1", "UNREAD", true)
        .unwrap();
    drop(connection);

    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-1", "threadId": "thread-1", "historyId": "5",
            "labelIds": ["INBOX"], "snippet": "hi", "internalDate": "1000",
            "payload": { "mimeType": "text/plain", "headers": [], "body": { "data": "aGk" } }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let sync_engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());
    let storage_for_cursor = storage.clone();

    let app = app();
    app.manage(storage);
    app.manage(auth_service);
    app.manage(sync_engine);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let labels = invoke(
        &webview,
        "list_labels",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(labels[0]["id"], "INBOX");

    let threads = invoke(
        &webview,
        "list_threads",
        serde_json::json!({ "accountId": account_id, "labelId": null, "cursor": null, "limit": null }),
    )
    .unwrap();
    assert_eq!(threads["items"][0]["id"], "thread-1");

    let conversation = invoke(
        &webview,
        "load_conversation",
        serde_json::json!({ "accountId": account_id, "threadId": "thread-1" }),
    )
    .unwrap();
    assert_eq!(conversation["messages"][0]["id"], "message-1");

    assert!(invoke(
        &webview,
        "star_thread",
        serde_json::json!({ "accountId": account_id, "threadId": "thread-1" })
    )
    .is_ok());
    assert!(invoke(
        &webview,
        "unstar_thread",
        serde_json::json!({ "accountId": account_id, "threadId": "thread-1" })
    )
    .is_ok());
    assert!(invoke(
        &webview,
        "mark_thread_read",
        serde_json::json!({ "accountId": account_id, "threadId": "thread-1" })
    )
    .is_ok());
    assert!(invoke(
        &webview,
        "mark_thread_unread",
        serde_json::json!({ "accountId": account_id, "threadId": "thread-1" })
    )
    .is_ok());


    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 0, "threadsTotal": 0, "historyId": "1"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})))
        .mount(&server)
        .await;
    let status = invoke(
        &webview,
        "trigger_sync",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(status["state"], "idle");
    let read_back = invoke(
        &webview,
        "read_sync_status",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(read_back["state"], "idle");


    latentmail_lib::storage::TraversalCursorRepository::upsert(
        &storage_for_cursor.connection().unwrap(),
        &latentmail_lib::storage::TraversalCursor {
            account_id: account_id.clone(),
            kind: latentmail_lib::storage::TraversalKind::Reconciliation,
            position: Some("token".into()),
            discovered_count: 10,
            persisted_count: 4,
            completed: false,
            last_advanced_at: 1_700_000_000,

            resumed: true,
        },
    )
    .unwrap();
    let mid_status = invoke(
        &webview,
        "read_traversal_status",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(mid_status["state"], "reconciling");
    assert_eq!(mid_status["kind"], "reconciliation");
    assert_eq!(mid_status["discoveredCount"], 10);

    assert_eq!(mid_status["isResumed"], true);
}


#[tokio::test]
async fn message_level_mutation_and_lazy_body_fetch_commands_are_reachable_through_real_ipc_dispatch(
) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = {
        auth_service
            .save_account("me@example.com".into(), "refresh-token".into(), None)
            .await
            .unwrap();
        auth_service.accounts().await.unwrap()[0].id.clone()
    };

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-token", "token_type": "Bearer"
        })))
        .mount(&server)
        .await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token(&account_id, "refresh-token").unwrap();

    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: account_id.clone(),
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
    for label_id in ["INBOX", "STARRED"] {
        LabelRepository::ensure_placeholder(&connection, &account_id, label_id).unwrap();
    }

    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: account_id.clone(),
            id: "message-1".into(),
            thread_id: "thread-1".into(),
            rfc_message_id: None,
            sender: "alice@example.com".into(),
            recipients: "me@example.com".into(),
            subject: "Subject".into(),
            sent_at: 1,
            snippet: "hi".into(),
            html_body: None,
            plain_body: None,
            has_attachments: false,
            is_unread: true,
            is_starred: false,
            history_id: 1,
            truncated_body: Some("hi".into()),
            html_presence: HtmlPresence::NeverFetched,
        },
    )
    .unwrap();
    MessageRepository::set_label_membership(&connection, &account_id, "message-1", "INBOX", true)
        .unwrap();
    drop(connection);

    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-1", "threadId": "thread-1", "historyId": "9",
            "labelIds": ["INBOX", "STARRED"], "snippet": "hi", "internalDate": "1000",
            "payload": {
                "mimeType": "multipart/related",
                "headers": [],
                "parts": [
                    {
                        "mimeType": "text/html",
                        "headers": [],
                        "body": { "data": "aGVsbG8" }
                    },
                    {
                        "mimeType": "image/png",
                        "headers": [{ "name": "Content-ID", "value": "<logo>" }],
                        "body": { "data": "aW1n" }
                    }
                ]
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let sync_engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());

    let app = app();
    app.manage(storage.clone());
    app.manage(auth_service);
    app.manage(sync_engine);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert!(invoke(
        &webview,
        "fetch_message_body",
        serde_json::json!({ "accountId": account_id, "messageId": "message-1" })
    )
    .is_ok());
    let stored = MessageRepository::get(&storage.connection().unwrap(), &account_id, "message-1")
        .unwrap()
        .unwrap();
    assert_eq!(stored.html_body.as_deref(), Some("hello"));
    assert_eq!(stored.html_presence, HtmlPresence::Present);


    assert!(invoke(
        &webview,
        "fetch_message_body",
        serde_json::json!({ "accountId": account_id, "messageId": "message-1" })
    )
    .is_ok());
    assert!(invoke(
        &webview,
        "fetch_message_body",
        serde_json::json!({ "accountId": account_id, "messageId": "missing" })
    )
    .is_err());

    assert!(invoke(
        &webview,
        "mutate_messages",
        serde_json::json!({
            "accountId": account_id,
            "messageIds": ["message-1"],
            "add": ["STARRED"],
            "remove": []
        })
    )
    .is_ok());
    assert!(
        MessageRepository::get(&storage.connection().unwrap(), &account_id, "message-1")
            .unwrap()
            .unwrap()
            .is_starred
    );
    assert!(invoke(
        &webview,
        "mutate_messages",
        serde_json::json!({
            "accountId": account_id,
            "messageIds": ["message-1"],
            "add": ["SENT"],
            "remove": []
        })
    )
    .is_err());
}

#[tokio::test]
async fn mail_commands_surface_validation_storage_and_gmail_failures() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = auth_service
        .save_account("errors@example.com".into(), "refresh-token".into(), None)
        .await
        .unwrap()
        .id;
    let connection = storage.connection().unwrap();
    for label_id in ["INBOX", "STARRED"] {
        LabelRepository::ensure_placeholder(&connection, &account_id, label_id).unwrap();
    }
    ThreadRepository::upsert(
        &connection,
        &Thread {
            account_id: account_id.clone(),
            id: "thread-1".into(),
            subject: "Subject".into(),
            participants: "Alice".into(),
            latest_at: 1,
            message_count: 1,
            is_unread: false,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
            sender_identity: ThreadIdentity {
                display: "Alice".into(),
                address: None,
            },
            recipient_identity: None,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: account_id.clone(),
            id: "message-1".into(),
            thread_id: "thread-1".into(),
            rfc_message_id: None,
            sender: "alice@example.com".into(),
            recipients: "errors@example.com".into(),
            subject: "Subject".into(),
            sent_at: 1,
            snippet: "hi".into(),
            html_body: None,
            plain_body: None,
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 1,
            truncated_body: Some("hi".into()),
            html_presence: HtmlPresence::NeverFetched,
        },
    )
    .unwrap();
    LabelRepository::upsert(
        &connection,
        &latentmail_lib::storage::Label {
            account_id: account_id.clone(),
            id: "Label_1".into(),
            name: "Clients".into(),
            kind: "user".into(),
            color: None,
            message_count: 0,
            unread_count: 0,
        },
    )
    .unwrap();
    drop(connection);

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-token", "token_type": "Bearer"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-1"))
        .respond_with(ResponseTemplate::new(400))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(400))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(400))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(400))
        .mount(&server)
        .await;
    Mock::given(method("PATCH"))
        .and(path("/users/me/labels/missing"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "missing", "name": "Renamed", "type": "user"
        })))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/labels/fail"))
        .respond_with(ResponseTemplate::new(400))
        .mount(&server)
        .await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token(&account_id, "refresh-token").unwrap();

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());
    let app = app();
    app.manage(storage);
    app.manage(auth_service);
    app.manage(engine);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    for (command, body) in [
        (
            "fetch_message_body",
            serde_json::json!({ "accountId": account_id, "messageId": "missing" }),
        ),
        (
            "fetch_message_body",
            serde_json::json!({ "accountId": account_id, "messageId": "message-1" }),
        ),
        (
            "star_thread",
            serde_json::json!({ "accountId": account_id, "threadId": "thread-1" }),
        ),
        (
            "unstar_thread",
            serde_json::json!({ "accountId": account_id, "threadId": "thread-1" }),
        ),
        (
            "mark_thread_read",
            serde_json::json!({ "accountId": account_id, "threadId": "thread-1" }),
        ),
        (
            "mark_thread_unread",
            serde_json::json!({ "accountId": account_id, "threadId": "thread-1" }),
        ),
        (
            "trigger_sync",
            serde_json::json!({ "accountId": account_id }),
        ),
        (
            "mutate_messages",
            serde_json::json!({ "accountId": account_id, "messageIds": ["message-1"], "add": ["STARRED"], "remove": [] }),
        ),
        (
            "create_label",
            serde_json::json!({ "accountId": account_id, "name": "   ", "colorId": null }),
        ),
        (
            "create_label",
            serde_json::json!({ "accountId": account_id, "name": "Vendors", "colorId": null }),
        ),
        (
            "rename_label",
            serde_json::json!({ "accountId": account_id, "labelId": "missing", "name": "Clients" }),
        ),
        (
            "rename_label",
            serde_json::json!({ "accountId": account_id, "labelId": "missing", "name": "Renamed" }),
        ),
        (
            "recolor_label",
            serde_json::json!({ "accountId": account_id, "labelId": "missing", "colorId": "blue" }),
        ),
        (
            "delete_label",
            serde_json::json!({ "accountId": account_id, "labelId": "fail" }),
        ),
    ] {
        assert!(invoke(&webview, command, body).is_err(), "{command}");
    }
}



#[tokio::test]
async fn mutate_threads_rejects_a_non_trash_delta_on_a_thread_holding_a_draft() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = auth_service
        .save_account("draft@example.com".into(), "refresh-token".into(), None)
        .await
        .unwrap()
        .id;
    let connection = storage.connection().unwrap();
    for label_id in ["INBOX", "DRAFT", "STARRED"] {
        LabelRepository::ensure_placeholder(&connection, &account_id, label_id).unwrap();
    }
    ThreadRepository::upsert(
        &connection,
        &Thread {
            account_id: account_id.clone(),
            id: "thread-draft".into(),
            subject: "Draft".into(),
            participants: "Me".into(),
            latest_at: 1,
            message_count: 1,
            is_unread: false,
            is_starred: false,
            has_attachments: false,
            has_draft: true,
            sender_identity: ThreadIdentity {
                display: "Me".into(),
                address: None,
            },
            recipient_identity: None,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: account_id.clone(),
            id: "message-draft".into(),
            thread_id: "thread-draft".into(),
            rfc_message_id: None,
            sender: "me@example.com".into(),
            recipients: "".into(),
            subject: "Draft".into(),
            sent_at: 1,
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
        &account_id,
        "message-draft",
        "DRAFT",
        true,
    )
    .unwrap();
    drop(connection);

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-token", "token_type": "Bearer"
        })))
        .mount(&server)
        .await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token(&account_id, "refresh-token").unwrap();

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(storage, queue, registry, noop_event_sink());
    let app = app();
    app.manage(engine);
    app.manage(auth_service);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let error = invoke(
        &webview,
        "mutate_threads",
        serde_json::json!({
            "accountId": account_id,
            "threadIds": ["thread-draft"],
            "add": ["STARRED"],
            "remove": []
        }),
    )
    .unwrap_err();
    assert!(error
        .as_str()
        .unwrap()
        .contains("Draft messages cannot be modified"));


    assert!(server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .all(|request| request.url.path() != "/users/me/messages/batchModify"));
}


#[test]
fn staging_commands_stage_and_release_through_real_ipc() {
    let directory = tempfile::tempdir().unwrap();
    let staging = std::sync::Arc::new(latentmail_lib::compose::staging::Staging::new(
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
            "accountId": "account",
            "owner": "draft",
            "path": source.to_string_lossy(),
            "mimeType": "text/plain",
            "contentId": null,
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
            "accountId": "account",
            "owner": "draft",
            "filename": "inline.png",
            "mimeType": "image/png",
            "contentId": "cid:1",
            "bytes": [1, 2, 3],
        }),
    )
    .unwrap();
    assert_eq!(staged_from_bytes["contentId"], "cid:1");
    assert_eq!(staged_from_bytes["size"], 3);

    assert!(invoke(
        &webview,
        "release_staged_attachment",
        serde_json::json!({
            "accountId": "account",
            "owner": "draft",
            "id": staged_from_path["id"],
        }),
    )
    .is_ok());

    assert!(invoke(
        &webview,
        "release_staged_attachment",
        serde_json::json!({
            "accountId": "account",
            "owner": "draft",
            "id": "never-staged",
        }),
    )
    .is_ok());
}


#[tokio::test]
async fn reply_contacts_html_conversation_and_traversal_status_round_trip_through_ipc() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = auth_service
        .save_account("me@example.com".into(), "refresh-token".into(), None)
        .await
        .unwrap()
        .id;

    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: account_id.clone(),
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
    LabelRepository::ensure_placeholder(&connection, &account_id, "INBOX").unwrap();
    ThreadRepository::upsert(
        &connection,
        &Thread {
            account_id: account_id.clone(),
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
        &connection,
        &Message {
            account_id: account_id.clone(),
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
    MessageRepository::set_recipient_roles(
        &connection,
        &account_id,
        "message-1",
        "me@example.com, bob@example.com",
        "cc@example.com",
        "",
        Some("<prev@example.com>"),
    )
    .unwrap();
    MessageRepository::replace_inline_parts(
        &connection,
        &account_id,
        "message-1",
        &[InlinePart {
            content_id: "logo".into(),
            mime_type: "image/png".into(),
            bytes: b"img".to_vec(),
        }],
    )
    .unwrap();
    MessageRepository::set_label_membership(&connection, &account_id, "message-1", "INBOX", true)
        .unwrap();
    latentmail_lib::contacts::observe(
        &connection,
        &account_id,
        "Alice <alice@example.com>",
        chrono::Utc::now().timestamp(),
    )
    .unwrap();
    latentmail_lib::storage::TraversalCursorRepository::upsert(
        &connection,
        &latentmail_lib::storage::TraversalCursor {
            account_id: account_id.clone(),
            kind: latentmail_lib::storage::TraversalKind::Backfill,
            position: None,
            discovered_count: 20,
            persisted_count: 20,
            completed: true,
            last_advanced_at: 1_700_000_100,
            resumed: false,
        },
    )
    .unwrap();
    latentmail_lib::storage::TraversalCursorRepository::upsert(
        &connection,
        &latentmail_lib::storage::TraversalCursor {
            account_id: account_id.clone(),
            kind: latentmail_lib::storage::TraversalKind::Reconciliation,
            position: Some("token".into()),
            discovered_count: 4,
            persisted_count: 2,
            completed: false,
            last_advanced_at: 1_700_000_000,
            resumed: true,
        },
    )
    .unwrap();
    drop(connection);

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());
    let app = app();
    app.manage(storage);
    app.manage(auth_service);
    app.manage(engine);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let reply = invoke(
        &webview,
        "reply_context",
        serde_json::json!({
            "accountId": account_id,
            "messageId": "message-1",
            "accountEmail": "me@example.com",
            "replyAll": true,
            "forward": false,
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

    let forwarded = invoke(
        &webview,
        "reply_context",
        serde_json::json!({
            "accountId": account_id,
            "messageId": "message-1",
            "accountEmail": "me@example.com",
            "replyAll": false,
            "forward": true,
        }),
    )
    .unwrap();
    assert_eq!(forwarded["subject"], "Fwd: Hello");
    assert!(forwarded["targetThreadId"].is_null());

    let contacts = invoke(
        &webview,
        "lookup_contacts",
        serde_json::json!({ "accountId": account_id, "query": "al" }),
    )
    .unwrap();
    assert_eq!(contacts[0]["address"], "alice@example.com");
    assert_eq!(contacts[0]["displayName"], "Alice");

    let conversation = invoke(
        &webview,
        "load_conversation",
        serde_json::json!({ "accountId": account_id, "threadId": "thread-1" }),
    )
    .unwrap();
    assert_eq!(conversation["messages"][0]["htmlPresence"], "present");
    assert_eq!(conversation["messages"][0]["remoteImagesBlocked"], true);

    let status = invoke(
        &webview,
        "read_traversal_status",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(status["state"], "complete");
    assert_eq!(status["kind"], "backfill");
    assert_eq!(status["discoveredCount"], 20);
}
