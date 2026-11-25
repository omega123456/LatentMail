use crate::ipc_contract_core_integration::{
    build_mail_webview, invoke, save_test_account, seed_thread_and_message, start_token_server,
    upsert_basic_account, SeededThreadMessage,
};
use crate::support::ensure_placeholder_labels;
use chrono::NaiveDate;
use latentmail_lib::auth::AuthService;
use latentmail_lib::storage::{
    HtmlPresence, MessageRepository, Storage, TraversalCursor, TraversalCursorRepository,
    TraversalKind,
};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

async fn mount_phase_3_gmail_mocks(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-1", "threadId": "thread-1", "historyId": "5",
            "labelIds": ["INBOX", "STARRED"], "snippet": "hi", "internalDate": "1000",
            "payload": { "mimeType": "text/plain", "headers": [], "body": { "data": "aGk" } }
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "drafts": [{ "id": "draft-9", "message": { "id": "message-1" } }]
        })))
        .mount(server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/drafts/draft-9"))
        .respond_with(ResponseTemplate::new(204))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "Label_1", "name": "Clients", "type": "user",
            "color": { "textColor": "#ffffff", "backgroundColor": "#4a86e8" }
        })))
        .mount(server)
        .await;
    Mock::given(method("PATCH"))
        .and(path("/users/me/labels/Label_1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "Label_1", "name": "Customers", "type": "user",
            "color": { "textColor": "#ffffff", "backgroundColor": "#fb4c2f" }
        })))
        .mount(server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/labels/Label_1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(server)
        .await;
}

fn assert_search_pagination_and_scopes(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    let search_results = invoke(
        webview,
        "search_threads",
        serde_json::json!({ "accountId": account_id, "query": "hi" }),
    )
    .unwrap();
    assert_eq!(search_results["items"][0]["id"], "thread-2");
    assert_eq!(search_results["items"][1]["id"], "thread-1");
    assert!(search_results["nextCursor"].is_null());

    let first_page = invoke(
        webview,
        "search_threads",
        serde_json::json!({ "accountId": account_id, "query": "hi", "limit": 1 }),
    )
    .unwrap();
    assert_eq!(first_page["items"][0]["id"], "thread-2");
    let cursor = first_page["nextCursor"].clone();
    assert!(!cursor.is_null());

    let second_page = invoke(
        webview,
        "search_threads",
        serde_json::json!({ "accountId": account_id, "query": "hi", "limit": 1, "cursor": cursor }),
    )
    .unwrap();
    assert_eq!(second_page["items"][0]["id"], "thread-1");
    assert!(second_page["nextCursor"].is_null());
    assert_search_scopes_and_empty_queries(webview, account_id);
}

fn assert_search_scopes_and_empty_queries(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    for scope in [
        serde_json::json!({ "kind": "all" }),
        serde_json::json!({ "kind": "label", "labelId": "INBOX" }),
    ] {
        let scoped = invoke(
            webview,
            "search_threads",
            serde_json::json!({ "accountId": account_id, "query": "hi", "scope": scope }),
        )
        .unwrap();
        assert_eq!(scoped["items"].as_array().unwrap().len(), 2);
        assert_eq!(
            invoke(
                webview,
                "search_total",
                serde_json::json!({ "accountId": account_id, "query": "hi", "scope": scope }),
            )
            .unwrap(),
            2
        );
    }

    for empty_query in ["   ", "nonexistentterm"] {
        let found = invoke(
            webview,
            "search_threads",
            serde_json::json!({ "accountId": account_id, "query": empty_query }),
        )
        .unwrap();
        assert_eq!(found["items"].as_array().unwrap().len(), 0);
        assert_eq!(
            invoke(
                webview,
                "search_total",
                serde_json::json!({ "accountId": account_id, "query": empty_query }),
            )
            .unwrap(),
            0
        );
    }
}

fn predicate_kinds(parsed: &serde_json::Value) -> Vec<String> {
    parsed["predicates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|predicate| predicate["kind"].as_str().unwrap().to_owned())
        .collect()
}

fn assert_parse_search_query_dispatch(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) {
    let parsed = invoke(
        webview,
        "parse_search_query",
        serde_json::json!({ "query": "from:alice is:unread" }),
    )
    .unwrap();
    assert_eq!(parsed["from"], "alice");
    assert_eq!(parsed["hasTextTerm"], true);
    assert_full_query_parses_every_predicate(webview);

    let lone_negation = invoke(
        webview,
        "parse_search_query",
        serde_json::json!({ "query": "is:starred has:attachment -promo" }),
    )
    .unwrap();
    assert!(predicate_kinds(&lone_negation).contains(&"textExcludes".to_owned()));
    assert!(invoke(
        webview,
        "parse_search_query",
        serde_json::json!({ "query": "a".repeat(2049) })
    )
    .is_err());
}

fn assert_full_query_parses_every_predicate(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    let fully_parsed = invoke(
        webview,
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
    let kinds = predicate_kinds(&fully_parsed);
    for expected in [
        "label",
        "starred",
        "hasAttachment",
        "sentAfter",
        "sentBefore",
    ] {
        assert!(kinds.contains(&expected.to_owned()));
    }
    let sent_after = fully_parsed["predicates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|predicate| predicate["kind"] == "sentAfter")
        .unwrap();
    assert_eq!(
        sent_after["atSeconds"],
        NaiveDate::from_ymd_opt(2020, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp()
    );
}

fn assert_label_and_triage_dispatch(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    assert_label_lifecycle_dispatch(webview, account_id);
    assert_triage_dispatch(webview, account_id);
    assert_label_id_is_reused_after_delete(webview, account_id);
}

fn assert_label_lifecycle_dispatch(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    let created = invoke(
        webview,
        "create_label",
        serde_json::json!({ "accountId": account_id, "name": "Clients", "colorId": "blue" }),
    )
    .unwrap();
    assert_eq!(created["id"], "Label_1");
    assert_eq!(created["color"]["background"], "#4a86e8");

    let renamed = invoke(
        webview,
        "rename_label",
        serde_json::json!({ "accountId": account_id, "labelId": "Label_1", "name": "Customers" }),
    )
    .unwrap();
    assert_eq!(renamed["name"], "Customers");

    let recolored = invoke(
        webview,
        "recolor_label",
        serde_json::json!({ "accountId": account_id, "labelId": "Label_1", "colorId": "red" }),
    )
    .unwrap();
    assert_eq!(recolored["color"]["background"], "#fb4c2f");
    assert!(invoke(
        webview,
        "delete_label",
        serde_json::json!({ "accountId": account_id, "labelId": "Label_1" })
    )
    .is_ok());
    assert!(invoke(
        webview,
        "create_label",
        serde_json::json!({ "accountId": account_id, "name": "Bogus", "colorId": "not-real" })
    )
    .is_err());
}

fn assert_triage_dispatch(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    let results = invoke(
        webview,
        "mutate_threads",
        serde_json::json!({ "accountId": account_id, "threadIds": ["thread-1"], "add": ["STARRED"], "remove": [] }),
    )
    .unwrap();
    assert_eq!(results[0]["threadId"], "thread-1");
    assert_eq!(results[0]["outcome"], "applied");
    assert_eq!(
        invoke(
            webview,
            "move_threads",
            serde_json::json!({ "accountId": account_id, "threadIds": ["thread-1"], "destination": "SPAM" }),
        )
        .unwrap()[0]["threadId"],
        "thread-1"
    );
    assert_eq!(
        invoke(
            webview,
            "delete_threads",
            serde_json::json!({ "accountId": account_id, "threadIds": ["thread-1"] }),
        )
        .unwrap()[0]["threadId"],
        "thread-1"
    );
    assert!(invoke(
        webview,
        "move_messages",
        serde_json::json!({ "accountId": account_id, "messageIds": ["message-1"], "destination": "INBOX" })
    )
    .is_ok());
    assert!(invoke(
        webview,
        "delete_messages",
        serde_json::json!({ "accountId": account_id, "messageIds": ["message-1"] })
    )
    .is_ok());
    assert!(invoke(
        webview,
        "delete_draft",
        serde_json::json!({ "accountId": account_id, "messageId": "message-1" })
    )
    .is_ok());
}

fn assert_label_id_is_reused_after_delete(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    let second = invoke(
        webview,
        "create_label",
        serde_json::json!({ "accountId": account_id, "name": "Team A", "colorId": null }),
    )
    .unwrap();
    assert_eq!(second["id"], "Label_1");
    assert!(invoke(
        webview,
        "recolor_label",
        serde_json::json!({ "accountId": account_id, "labelId": "Label_1", "colorId": "nope" })
    )
    .is_err());
}

async fn mount_empty_sync_mocks(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 0, "threadsTotal": 0, "historyId": "1"
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})))
        .mount(server)
        .await;
}

#[tokio::test]
async fn every_phase_3_command_is_reachable_through_real_ipc_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = save_test_account(&auth_service, "me@example.com").await;
    let server = start_token_server(&account_id).await;

    {
        let connection = storage.connection().unwrap();
        upsert_basic_account(&connection, &account_id, "me@example.com");
        ensure_placeholder_labels(&connection, &account_id, &["INBOX", "STARRED", "TRASH"]);
        seed_thread_and_message(
            &connection,
            SeededThreadMessage {
                account_id: &account_id,
                thread_id: "thread-1",
                message_id: "message-1",
                sent_at: 1,
                is_unread: false,
                html_presence: HtmlPresence::Absent,
                plain_body: Some("hi"),
                truncated_body: None,
                labels: &["INBOX"],
            },
        );
        seed_thread_and_message(
            &connection,
            SeededThreadMessage {
                account_id: &account_id,
                thread_id: "thread-2",
                message_id: "message-2",
                sent_at: 2,
                is_unread: false,
                html_presence: HtmlPresence::Absent,
                plain_body: Some("hi"),
                truncated_body: None,
                labels: &["INBOX"],
            },
        );
    }

    mount_phase_3_gmail_mocks(&server).await;
    let (_app, webview) = build_mail_webview(storage, auth_service, true);

    let status = invoke(
        &webview,
        "read_traversal_status",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(status["state"], "notStarted");
    assert_search_pagination_and_scopes(&webview, &account_id);
    assert_parse_search_query_dispatch(&webview);
    assert_label_and_triage_dispatch(&webview, &account_id);
}

fn seed_unread_plain_inbox_message(storage: &Storage, account_id: &str) {
    let connection = storage.connection().unwrap();
    upsert_basic_account(&connection, account_id, "me@example.com");
    ensure_placeholder_labels(&connection, account_id, &["INBOX", "UNREAD", "STARRED"]);
    seed_thread_and_message(
        &connection,
        SeededThreadMessage {
            account_id: account_id,
            thread_id: "thread-1",
            message_id: "message-1",
            sent_at: 1,
            is_unread: true,
            html_presence: HtmlPresence::Absent,
            plain_body: Some("hi"),
            truncated_body: None,
            labels: &["INBOX", "UNREAD"],
        },
    );
}

fn seed_never_fetched_inbox_message(storage: &Storage, account_id: &str) {
    let connection = storage.connection().unwrap();
    upsert_basic_account(&connection, account_id, "me@example.com");
    ensure_placeholder_labels(&connection, account_id, &["INBOX", "STARRED"]);
    seed_thread_and_message(
        &connection,
        SeededThreadMessage {
            account_id: account_id,
            thread_id: "thread-1",
            message_id: "message-1",
            sent_at: 1,
            is_unread: true,
            html_presence: HtmlPresence::NeverFetched,
            plain_body: None,
            truncated_body: Some("hi"),
            labels: &["INBOX"],
        },
    );
}

async fn mount_batch_modify_mock(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(server)
        .await;
}

async fn mount_plain_message_mock(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-1", "threadId": "thread-1", "historyId": "5",
            "labelIds": ["INBOX"], "snippet": "hi", "internalDate": "1000",
            "payload": { "mimeType": "text/plain", "headers": [], "body": { "data": "aGk" } }
        })))
        .mount(server)
        .await;
}

async fn mount_multipart_message_mock(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-1", "threadId": "thread-1", "historyId": "9",
            "labelIds": ["INBOX", "STARRED"], "snippet": "hi", "internalDate": "1000",
            "payload": {
                "mimeType": "multipart/related",
                "headers": [],
                "parts": [
                    { "mimeType": "text/html", "headers": [], "body": { "data": "aGVsbG8" } },
                    { "mimeType": "image/png", "headers": [{ "name": "Content-ID", "value": "<logo>" }], "body": { "data": "aW1n" } }
                ]
            }
        })))
        .mount(server)
        .await;
}

fn assert_mail_read_dispatch(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    assert_eq!(
        invoke(
            webview,
            "list_labels",
            serde_json::json!({ "accountId": account_id })
        )
        .unwrap()[0]["id"],
        "INBOX"
    );
    assert_eq!(
        invoke(
            webview,
            "list_threads",
            serde_json::json!({ "accountId": account_id, "labelId": null, "cursor": null, "limit": null }),
        )
        .unwrap()["items"][0]["id"],
        "thread-1"
    );
    assert_eq!(
        invoke(
            webview,
            "load_conversation",
            serde_json::json!({ "accountId": account_id, "threadId": "thread-1" }),
        )
        .unwrap()["messages"][0]["id"],
        "message-1"
    );
}

fn assert_single_thread_triage_dispatch(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    for command in [
        "star_thread",
        "unstar_thread",
        "mark_thread_read",
        "mark_thread_unread",
    ] {
        assert!(
            invoke(
                webview,
                command,
                serde_json::json!({ "accountId": account_id, "threadId": "thread-1" })
            )
            .is_ok(),
            "{command}"
        );
    }
}

fn assert_sync_commands_report_idle(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    assert_eq!(
        invoke(
            webview,
            "trigger_sync",
            serde_json::json!({ "accountId": account_id })
        )
        .unwrap()["state"],
        "idle"
    );
    assert_eq!(
        invoke(
            webview,
            "read_sync_status",
            serde_json::json!({ "accountId": account_id })
        )
        .unwrap()["state"],
        "idle"
    );
}

fn persist_mid_reconciliation_cursor(storage: &Storage, account_id: &str) {
    TraversalCursorRepository::upsert(
        &storage.connection().unwrap(),
        &TraversalCursor {
            account_id: account_id.into(),
            kind: TraversalKind::Reconciliation,
            position: Some("token".into()),
            discovered_count: 10,
            persisted_count: 4,
            completed: false,
            last_advanced_at: (chrono::Utc::now() + chrono::Duration::days(1)).timestamp(),
            resumed: true,
        },
    )
    .unwrap();
}

fn assert_traversal_status_reports_reconciling(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    account_id: &str,
) {
    let mid_status = invoke(
        webview,
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
async fn mail_read_and_single_thread_triage_commands_are_reachable_through_real_ipc_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = save_test_account(&auth_service, "me@example.com").await;
    let server = start_token_server(&account_id).await;
    seed_unread_plain_inbox_message(&storage, &account_id);
    mount_plain_message_mock(&server).await;
    mount_batch_modify_mock(&server).await;

    let storage_for_cursor = storage.clone();
    let (_app, webview) = build_mail_webview(storage, auth_service, true);

    assert_mail_read_dispatch(&webview, &account_id);
    assert_single_thread_triage_dispatch(&webview, &account_id);
    mount_empty_sync_mocks(&server).await;
    assert_sync_commands_report_idle(&webview, &account_id);
    persist_mid_reconciliation_cursor(&storage_for_cursor, &account_id);
    assert_traversal_status_reports_reconciling(&webview, &account_id);
}

struct MessageCommandContext<'a> {
    webview: &'a tauri::WebviewWindow<tauri::test::MockRuntime>,
    storage: &'a Storage,
    account_id: &'a str,
}

fn stored_message(context: &MessageCommandContext<'_>) -> latentmail_lib::storage::Message {
    MessageRepository::get(
        &context.storage.connection().unwrap(),
        context.account_id,
        "message-1",
    )
    .unwrap()
    .unwrap()
}

fn assert_lazy_body_fetch_dispatch(context: &MessageCommandContext<'_>) {
    let webview = context.webview;
    let account_id = context.account_id;
    assert!(invoke(
        webview,
        "fetch_message_body",
        serde_json::json!({ "accountId": account_id, "messageId": "message-1" })
    )
    .is_ok());
    let stored = stored_message(context);
    assert_eq!(stored.html_body.as_deref(), Some("hello"));
    assert_eq!(stored.html_presence, HtmlPresence::Present);

    let body = invoke(
        webview,
        "load_message_body",
        serde_json::json!({ "accountId": account_id, "messageId": "message-1", "imagePolicy": null }),
    )
    .unwrap();
    assert_eq!(body["htmlBody"], "hello");
    assert!(invoke(
        webview,
        "fetch_message_body",
        serde_json::json!({ "accountId": account_id, "messageId": "message-1" })
    )
    .is_ok());
    assert!(invoke(
        webview,
        "fetch_message_body",
        serde_json::json!({ "accountId": account_id, "messageId": "missing" })
    )
    .is_err());
}

fn assert_message_mutation_dispatch(context: &MessageCommandContext<'_>) {
    let webview = context.webview;
    let account_id = context.account_id;
    assert!(invoke(
        webview,
        "mutate_messages",
        serde_json::json!({ "accountId": account_id, "messageIds": ["message-1"], "add": ["STARRED"], "remove": [] })
    )
    .is_ok());
    assert!(stored_message(context).is_starred);
    assert!(invoke(
        webview,
        "mutate_messages",
        serde_json::json!({ "accountId": account_id, "messageIds": ["message-1"], "add": ["SENT"], "remove": [] })
    )
    .is_err());
}

#[tokio::test]
async fn message_level_mutation_and_lazy_body_fetch_commands_are_reachable_through_real_ipc_dispatch(
) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = save_test_account(&auth_service, "me@example.com").await;
    let server = start_token_server(&account_id).await;
    seed_never_fetched_inbox_message(&storage, &account_id);
    mount_multipart_message_mock(&server).await;
    mount_batch_modify_mock(&server).await;

    let (_app, webview) = build_mail_webview(storage.clone(), auth_service, false);
    let context = MessageCommandContext {
        webview: &webview,
        storage: &storage,
        account_id: &account_id,
    };

    assert_lazy_body_fetch_dispatch(&context);
    assert_message_mutation_dispatch(&context);
}
