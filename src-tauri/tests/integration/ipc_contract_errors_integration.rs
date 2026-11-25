use crate::ipc_contract_core_integration::{
    build_mail_webview, invoke, save_test_account, seed_thread_and_message, start_token_server,
    SeededThreadMessage,
};
use crate::support::ensure_placeholder_labels;
use latentmail_lib::auth::AuthService;
use latentmail_lib::storage::{HtmlPresence, Label, LabelRepository, Storage};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

async fn mount_failing_mail_endpoints(server: &MockServer) {
    for (http_method, endpoint) in [
        ("GET", "/users/me/messages/message-1"),
        ("POST", "/users/me/messages/batchModify"),
        ("GET", "/users/me/profile"),
        ("POST", "/users/me/labels"),
        ("DELETE", "/users/me/labels/fail"),
    ] {
        Mock::given(method(http_method))
            .and(path(endpoint))
            .respond_with(ResponseTemplate::new(400))
            .mount(server)
            .await;
    }
    Mock::given(method("PATCH"))
        .and(path("/users/me/labels/missing"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "missing", "name": "Renamed", "type": "user"
        })))
        .mount(server)
        .await;
}

fn failing_mail_command_cases(account_id: &str) -> Vec<(&'static str, serde_json::Value)> {
    vec![
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
    ]
}

#[tokio::test]
async fn mail_commands_surface_validation_storage_and_gmail_failures() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = save_test_account(&auth_service, "errors@example.com").await;
    {
        let connection = storage.connection().unwrap();
        ensure_placeholder_labels(&connection, &account_id, &["INBOX", "STARRED"]);
        seed_thread_and_message(
            &connection,
            SeededThreadMessage {
                account_id: &account_id,
                thread_id: "thread-1",
                message_id: "message-1",
                sent_at: 1,
                is_unread: false,
                html_presence: HtmlPresence::NeverFetched,
                plain_body: None,
                truncated_body: Some("hi"),
                labels: &[],
            },
        );
        LabelRepository::upsert(
            &connection,
            &Label {
                account_id: account_id.clone(),
                id: "Label_1".into(),
                name: "Clients".into(),
                kind: "user".into(),
                color: None,
                message_count: 0,
            },
        )
        .unwrap();
    }

    let server = start_token_server(&account_id).await;
    mount_failing_mail_endpoints(&server).await;
    let (_app, webview) = build_mail_webview(storage, auth_service, true);

    for (command, body) in failing_mail_command_cases(&account_id) {
        assert!(invoke(&webview, command, body).is_err(), "{command}");
    }
}

#[tokio::test]
async fn mutate_threads_rejects_a_non_trash_delta_on_a_thread_holding_a_draft() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = save_test_account(&auth_service, "draft@example.com").await;
    {
        let connection = storage.connection().unwrap();
        ensure_placeholder_labels(&connection, &account_id, &["INBOX", "DRAFT", "STARRED"]);
        seed_thread_and_message(
            &connection,
            SeededThreadMessage {
                account_id: &account_id,
                thread_id: "thread-draft",
                message_id: "message-draft",
                sent_at: 1,
                is_unread: false,
                html_presence: HtmlPresence::Absent,
                plain_body: None,
                truncated_body: None,
                labels: &["DRAFT"],
            },
        );
    }

    let server = start_token_server(&account_id).await;
    let (_app, webview) = build_mail_webview(storage, auth_service, false);

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
