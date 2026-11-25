use crate::compose_drafts_save_integration::{
    admit_on_booted, base_payload, boot, default_target, draft_response, failed_reports,
    mock_token, operation_status, stage_text_file, upsert_default_account, wait_for,
    wait_for_queue_idle, APP_ENV,
};
use latentmail_lib::compose::drafts::{self, DraftOperationMode};
use latentmail_lib::storage::{
    ComposeDraftMetadata, ComposeDraftMetadataRepository, HtmlPresence, Message, MessageKey,
    MessageRepository, Operation, OperationRepository, Storage,
};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use tauri::Listener;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

async fn mount_send_mocks(server: &MockServer, call_order: Arc<Mutex<Vec<&'static str>>>) {
    mock_token().mount(server).await;
    let update_order = Arc::clone(&call_order);
    Mock::given(method("PUT"))
        .and(path("/upload/gmail/v1/users/me/drafts/d1"))
        .respond_with(move |_: &wiremock::Request| {
            update_order.lock().unwrap().push("update");
            ResponseTemplate::new(200).set_body_json(draft_response("d1", "m-updated", "t1"))
        })
        .mount(server)
        .await;
    let send_order = Arc::clone(&call_order);
    let sends = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(path("/users/me/drafts/send"))
        .respond_with(move |_: &wiremock::Request| {
            send_order.lock().unwrap().push("send");
            let message_id = match sends.fetch_add(1, Ordering::SeqCst) {
                0 => "sent-1",
                _ => "sent-2",
            };
            ResponseTemplate::new(200)
                .set_body_json(draft_response("ignored", message_id, "t1")["message"].clone())
        })
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d2", "m2", "t2")))
        .mount(server)
        .await;
    for (message_id, thread_id) in [("sent-1", "t1"), ("sent-2", "t2")] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{message_id}")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    draft_response("ignored", message_id, thread_id)["message"].clone(),
                ),
            )
            .mount(server)
            .await;
    }
}

fn seed_local_draft_state(storage: &Storage) {
    let connection = storage.connection().unwrap();
    upsert_default_account(&connection);
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: "account".into(),
            id: "local-1".into(),
            thread_id: "t1".into(),
            rfc_message_id: None,
            sender: "me@example.com".into(),
            recipients: "them@example.com".into(),
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
            html_presence: HtmlPresence::Present,
        },
    )
    .unwrap();
    MessageRepository::set_draft_id(
        &connection,
        MessageKey {
            account_id: "account",
            message_id: "local-1",
        },
        "d1",
    )
    .unwrap();
    ComposeDraftMetadataRepository::upsert(
        &connection,
        &ComposeDraftMetadata {
            account_id: "account".into(),
            draft_id: "d1".into(),
            mode: "new".into(),
            original_message_id: None,
            original_gmail_message_id: None,
            target_thread_id: None,
            in_reply_to: None,
            rfc_references: None,
            boundary_version: 1,
            editable_body_fingerprint: None,
            quote_html: None,
            quote_plain: None,
        },
    )
    .unwrap();
}

#[tokio::test]
async fn discard_marks_queued_and_active_session_creates_for_cancellation() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    upsert_default_account(&storage.connection().unwrap());
    for (id, status, entity_key) in [
        ("queued", "queued", "session"),
        ("active", "active", "session"),
        ("other", "queued", "other"),
    ] {
        OperationRepository::upsert(
            &storage.connection().unwrap(),
            &Operation {
                id: id.into(),
                account_id: "account".into(),
                lane: "interactive".into(),
                kind: "draft".into(),
                entity_key: entity_key.into(),
                payload: "{}".into(),
                status: status.into(),
                attempts: 0,
                next_attempt_at: None,
                error: None,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
    }
    storage
        .run(|connection| {
            OperationRepository::discard_session_creates(connection, "account", "session")
        })
        .await
        .unwrap();
    assert_eq!(operation_status(&storage, "queued"), "discarded");
    assert_eq!(operation_status(&storage, "active"), "discarded");
    assert_eq!(operation_status(&storage, "other"), "queued");
}

#[tokio::test]
async fn send_consumes_the_draft_and_releases_canonical_staging() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    let call_order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    mount_send_mocks(&server, Arc::clone(&call_order)).await;

    let booted = boot(&server);
    let (_source, part) = stage_text_file(&booted.staging, "d1", "part-1");
    admit_on_booted(
        &booted,
        drafts::DraftAdmission {
            id: "op-send".into(),
            account_id: "account".into(),
            entity_key: "draft:d1".into(),
            payload: base_payload(DraftOperationMode::Send, Some("d1")),
        },
        std::slice::from_ref(&part),
    )
    .await;
    wait_for_queue_idle(&booted.queue).await;

    let connection = booted.storage.connection().unwrap();
    assert!(MessageRepository::get(&connection, "account", "sent-1")
        .unwrap()
        .is_some());
    assert!(
        ComposeDraftMetadataRepository::get(&connection, "account", "d1")
            .unwrap()
            .is_none(),
        "a confirmed send removes compose-draft metadata for the consumed draft"
    );
    drop(connection);
    assert!(
        !part.path.exists(),
        "a confirmed send releases canonical staging"
    );
    assert_eq!(
        *call_order.lock().unwrap(),
        vec!["update", "send"],
        "send must upload the current assembled document to the existing draft \
         before promoting it — never promote a stale draft"
    );

    let (_second_source, first_click_part) =
        stage_text_file(&booted.staging, "session-2", "part-2");
    admit_on_booted(
        &booted,
        drafts::DraftAdmission {
            id: "op-first-send".into(),
            account_id: "account".into(),
            entity_key: "session-2".into(),
            payload: base_payload(DraftOperationMode::Send, None),
        },
        std::slice::from_ref(&first_click_part),
    )
    .await;
    wait_for_queue_idle(&booted.queue).await;
    assert!(
        MessageRepository::get(&booted.storage.connection().unwrap(), "account", "sent-2")
            .unwrap()
            .is_some()
    );
    assert!(!first_click_part.path.exists());
}

#[tokio::test]
async fn discard_racing_an_active_create_deletes_the_returned_draft() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token().mount(&server).await;
    let booted = boot(&server);

    let storage_for_create = booted.storage.clone();
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(move |_: &wiremock::Request| {
            storage_for_create
                .connection()
                .unwrap()
                .execute(
                    "UPDATE operations SET status='discarded' WHERE id='op-race'",
                    [],
                )
                .unwrap();
            ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1"))
        })
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1")))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/gmail/v1/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    admit_on_booted(
        &booted,
        drafts::DraftAdmission {
            id: "op-race".into(),
            account_id: "account".into(),
            entity_key: "session-race".into(),
            payload: base_payload(DraftOperationMode::Create, None),
        },
        &[],
    )
    .await;
    wait_for_queue_idle(&booted.queue).await;

    assert!(
        MessageRepository::get(&booted.storage.connection().unwrap(), "account", "m1")
            .unwrap()
            .is_none()
    );
    assert!(booted.staging.snapshot_manifest("op-race").is_err());
}

#[tokio::test]
async fn delete_reuses_the_existing_endpoint_and_removes_local_state() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/gmail/v1/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    let client = latentmail_lib::gmail::GmailClient::with_base_url(
        "token",
        format!("{}/gmail/v1", server.uri()),
    );
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    seed_local_draft_state(&storage);

    drafts::delete(&client, &storage, default_target())
        .await
        .unwrap();

    let connection = storage.connection().unwrap();
    assert!(MessageRepository::get(&connection, "account", "local-1")
        .unwrap()
        .is_none());
    assert!(
        ComposeDraftMetadataRepository::get(&connection, "account", "d1")
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn delete_surfaces_a_failing_gmail_endpoint() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/gmail/v1/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(400))
        .mount(&server)
        .await;
    let client = latentmail_lib::gmail::GmailClient::with_base_url(
        "token",
        format!("{}/gmail/v1", server.uri()),
    );
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();

    assert!(drafts::delete(&client, &storage, default_target())
        .await
        .is_err());
}

#[tokio::test]
async fn delete_surfaces_an_unreadable_database_after_gmail_accepts_the_removal() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/gmail/v1/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    let client = latentmail_lib::gmail::GmailClient::with_base_url(
        "token",
        format!("{}/gmail/v1", server.uri()),
    );
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("mail.sqlite");
    let storage = Storage::open(&database).unwrap();
    std::fs::write(&database, b"not a database").unwrap();

    assert!(drafts::delete(&client, &storage, default_target())
        .await
        .is_err());
}

#[tokio::test]
async fn a_sent_message_whose_local_write_fails_is_still_reported_as_sent() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token().mount(&server).await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(draft_response("d-sent", "m-sent", "t-sent")),
        )
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/drafts/send"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            draft_response("ignored", "sent-local-fail", "t-sent")["message"].clone(),
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/sent-local-fail"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            draft_response("ignored", "sent-local-fail", "t-sent")["message"].clone(),
        ))
        .mount(&server)
        .await;
    let booted = boot(&server);
    booted
        .storage
        .connection()
        .unwrap()
        .execute("DROP TABLE contacts", [])
        .unwrap();
    let reported = failed_reports(&booted.app);
    let completed = Arc::new(AtomicBool::new(false));
    let completion = Arc::clone(&completed);
    booted
        .app
        .handle()
        .listen(latentmail_lib::events::SEND_COMPLETE, move |_| {
            completion.store(true, Ordering::SeqCst);
        });

    admit_on_booted(
        &booted,
        drafts::DraftAdmission {
            id: "op-sent-local-fail".into(),
            account_id: "account".into(),
            entity_key: "session-local-fail".into(),
            payload: base_payload(DraftOperationMode::Send, None),
        },
        &[],
    )
    .await;
    wait_for(|| completed.load(Ordering::SeqCst)).await;

    assert_eq!(
        operation_status(&booted.storage, "op-sent-local-fail"),
        "done"
    );
    assert!(reported.lock().unwrap().is_empty());
    server.verify().await;
}
