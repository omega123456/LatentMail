
use std::collections::HashSet;
use std::sync::Arc;

use latentmail_lib::{
    gmail::GmailClient,
    storage::{
        Account, AccountRepository, HtmlPresence, Label, LabelRepository, Message,
        MessageRepository, Storage,
    },
    sync::{
        create_queue_engine_with_events, noop_event_sink, MutationOutcome, SyncEngine, WorkRegistry,
    },
};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn account() -> Account {
    Account {
        id: "account".into(),
        email: "a@example.com".into(),
        display_name: "A".into(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 0,
        updated_at: 0,
    }
}

fn system_label(id: &str) -> Label {
    Label {
        account_id: "account".into(),
        id: id.into(),
        name: id.into(),
        kind: "system".into(),
        color: None,
        message_count: 0,
    }
}

fn message(id: &str, thread_id: &str) -> Message {
    Message {
        account_id: "account".into(),
        id: id.into(),
        thread_id: thread_id.into(),
        rfc_message_id: None,
        sender: "A".into(),
        recipients: "B".into(),
        subject: "Subject".into(),
        sent_at: 1,
        snippet: "before".into(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: true,
        is_starred: false,
        history_id: 1,
        truncated_body: None,
        html_presence: HtmlPresence::Absent,
    }
}


fn seed_many_threads(count: usize) -> (Storage, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    for id in ["INBOX", "TRASH", "STARRED", "UNREAD"] {
        LabelRepository::upsert(&connection, &system_label(id)).unwrap();
    }
    for n in 0..count {
        MessageRepository::write_full_state(
            &connection,
            &message(&format!("message-{n}"), &format!("thread-{n}")),
        )
        .unwrap();
    }
    drop(connection);
    (storage, directory)
}

#[tokio::test(start_paused = true)]
async fn a_move_produces_one_batch_call_carrying_both_directions() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-0", "threadId": "thread-0", "historyId": "20",
            "labelIds": ["TRASH"], "snippet": "moved",
            "internalDate": "1", "payload": { "headers": [] }
        })))
        .mount(&server)
        .await;
    let (storage, _directory) = seed_many_threads(1);
    let registry = WorkRegistry::new();
    let queue = create_queue_engine_with_events(
        1_000,
        1_000,
        Arc::clone(&registry),
        Arc::new(|_event, _payload| {}),
    );
    let engine = SyncEngine::new(
        storage.clone(),
        Arc::clone(&queue),
        registry,
        noop_event_sink(),
    );

    let outcome = engine
        .mutate(
            "account",
            GmailClient::with_base_url("token", server.uri()),
            "thread-0".into(),
            HashSet::from(["TRASH".to_owned()]),
            HashSet::from(["INBOX".to_owned()]),
        )
        .await
        .unwrap();
    assert_eq!(outcome, MutationOutcome::Applied);

    let requests = server.received_requests().await.unwrap();
    let batches = requests
        .iter()
        .filter(|request| request.url.path() == "/users/me/messages/batchModify")
        .collect::<Vec<_>>();
    assert_eq!(batches.len(), 1, "a move must be a single batchModify call");
    let body = batches[0].body_json::<serde_json::Value>().unwrap();
    assert_eq!(body["addLabelIds"], serde_json::json!(["TRASH"]));
    assert_eq!(body["removeLabelIds"], serde_json::json!(["INBOX"]));
}


#[test]
fn batch_modify_chunk_size_matches_gmails_documented_identifier_limit() {
    assert_eq!(latentmail_lib::sync::BATCH_MODIFY_CHUNK_SIZE, 1_000);
}


#[tokio::test(start_paused = true)]
async fn bulk_star_of_many_threads_groups_into_a_single_batch_call() {
    const COUNT: usize = 30;
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .respond_with(move |request: &wiremock::Request| {
            let id = request
                .url
                .path()
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_owned();
            let thread_id = id.replacen("message-", "thread-", 1);
            ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": id, "threadId": thread_id, "historyId": "20",
                "labelIds": ["INBOX", "STARRED"], "snippet": "starred",
                "internalDate": "1", "payload": { "headers": [] }
            }))
        })
        .mount(&server)
        .await;
    let (storage, _directory) = seed_many_threads(COUNT);
    let registry = WorkRegistry::new();
    let queue = create_queue_engine_with_events(
        1_000_000,
        1_000_000,
        Arc::clone(&registry),
        Arc::new(|_event, _payload| {}),
    );
    let engine = SyncEngine::new(storage, Arc::clone(&queue), registry, noop_event_sink());

    let tasks = (0..COUNT)
        .map(|n| {
            let engine = Arc::clone(&engine);
            let base_url = server.uri();
            tokio::spawn(async move {
                engine
                    .mutate(
                        "account",
                        GmailClient::with_base_url("token", base_url),
                        format!("thread-{n}"),
                        HashSet::from(["STARRED".to_owned()]),
                        HashSet::new(),
                    )
                    .await
            })
        })
        .collect::<Vec<_>>();
    for task in tasks {
        assert_eq!(task.await.unwrap().unwrap(), MutationOutcome::Applied);
    }

    let requests = server.received_requests().await.unwrap();
    let batches = requests
        .iter()
        .filter(|request| request.url.path() == "/users/me/messages/batchModify")
        .collect::<Vec<_>>();
    assert_eq!(
        batches.len(),
        1,
        "every thread shares the same delta, so a bulk star must be one call, not one per thread"
    );
    let ids = batches[0].body_json::<serde_json::Value>().unwrap()["ids"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(ids, COUNT);
}


#[tokio::test(start_paused = true)]
async fn sequential_mutations_outside_the_coalescing_window_are_separate_batch_calls() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(2)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-0", "threadId": "thread-0", "historyId": "20",
            "labelIds": ["INBOX"], "snippet": "updated",
            "internalDate": "1", "payload": { "headers": [] }
        })))
        .mount(&server)
        .await;
    let (storage, _directory) = seed_many_threads(1);
    let registry = WorkRegistry::new();
    let queue = create_queue_engine_with_events(
        1_000,
        1_000,
        Arc::clone(&registry),
        Arc::new(|_event, _payload| {}),
    );
    let engine = SyncEngine::new(storage, Arc::clone(&queue), registry, noop_event_sink());

    let first = engine
        .mutate(
            "account",
            GmailClient::with_base_url("token", server.uri()),
            "thread-0".into(),
            HashSet::from(["STARRED".to_owned()]),
            HashSet::new(),
        )
        .await
        .unwrap();
    let second = engine
        .mutate(
            "account",
            GmailClient::with_base_url("token", server.uri()),
            "thread-0".into(),
            HashSet::new(),
            HashSet::from(["STARRED".to_owned()]),
        )
        .await
        .unwrap();

    assert_eq!(first, MutationOutcome::Applied);
    assert_eq!(second, MutationOutcome::Applied);
}


#[tokio::test(start_paused = true)]
async fn mark_read_and_unread_reach_gmail_as_unread_label_removal_and_addition() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-0", "threadId": "thread-0", "historyId": "20",
            "labelIds": ["INBOX"], "snippet": "updated",
            "internalDate": "1", "payload": { "headers": [] }
        })))
        .mount(&server)
        .await;
    let (storage, _directory) = seed_many_threads(1);
    let registry = WorkRegistry::new();
    let queue = create_queue_engine_with_events(
        1_000,
        1_000,
        Arc::clone(&registry),
        Arc::new(|_event, _payload| {}),
    );
    let engine = SyncEngine::new(
        storage.clone(),
        Arc::clone(&queue),
        registry,
        noop_event_sink(),
    );


    let read = engine
        .mutate(
            "account",
            GmailClient::with_base_url("token", server.uri()),
            "thread-0".into(),
            HashSet::new(),
            HashSet::from(["UNREAD".to_owned()]),
        )
        .await
        .unwrap();
    assert_eq!(read, MutationOutcome::Applied);


    let unread = engine
        .mutate(
            "account",
            GmailClient::with_base_url("token", server.uri()),
            "thread-0".into(),
            HashSet::from(["UNREAD".to_owned()]),
            HashSet::new(),
        )
        .await
        .unwrap();
    assert_eq!(unread, MutationOutcome::Applied);

    let requests = server.received_requests().await.unwrap();
    let batches: Vec<_> = requests
        .iter()
        .filter(|request| request.url.path() == "/users/me/messages/batchModify")
        .collect();
    assert_eq!(batches.len(), 2);
    assert_eq!(
        batches[0].body_json::<serde_json::Value>().unwrap()["removeLabelIds"],
        serde_json::json!(["UNREAD"])
    );
    assert_eq!(
        batches[1].body_json::<serde_json::Value>().unwrap()["addLabelIds"],
        serde_json::json!(["UNREAD"])
    );
}


#[tokio::test(start_paused = true)]
async fn a_request_with_no_labels_settles_as_superseded_without_dispatching() {
    let (storage, _directory) = seed_many_threads(1);
    let registry = WorkRegistry::new();
    let queue = create_queue_engine_with_events(
        1_000,
        1_000,
        Arc::clone(&registry),
        Arc::new(|_event, _payload| {}),
    );
    let engine = SyncEngine::new(storage, Arc::clone(&queue), registry, noop_event_sink());

    let outcome = engine
        .mutate(
            "account",

            GmailClient::with_base_url("token", "http://127.0.0.1:0"),
            "thread-0".into(),
            HashSet::new(),
            HashSet::new(),
        )
        .await
        .unwrap();
    assert_eq!(outcome, MutationOutcome::Superseded);
}
