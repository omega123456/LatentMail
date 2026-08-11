use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use latentmail_lib::{
    gmail::GmailClient,
    queue::{Executor, Lane, OperationKind, QueueEngine, QueueOperation},
    storage::{Account, AccountRepository, Message, MessageRepository, Storage},
};
use wiremock::{
    matchers::{body_json, method, path},
    Mock, MockServer, ResponseTemplate,
};

fn operation(id: String, lane: Lane, entity_key: String) -> QueueOperation {
    QueueOperation {
        id,
        account_id: "account".into(),
        lane,
        kind: OperationKind::Star,
        entity_key,
        cost: 0,
        attempts: 0,
    }
}

#[tokio::test]
async fn interactive_star_dispatches_with_500_background_operations_queued() {
    let star_started = Arc::new(AtomicBool::new(false));
    let executor: Executor = {
        let star_started = Arc::clone(&star_started);
        Arc::new(move |operation| {
            let star_started = Arc::clone(&star_started);
            Box::pin(async move {
                if operation.lane == Lane::Interactive {
                    star_started.store(true, Ordering::Release);
                } else {
                    std::future::pending::<()>().await;
                }
                Ok(())
            })
        })
    };
    let queue = QueueEngine::new(1_000, 1_000, executor);
    for index in 0..500 {
        queue
            .enqueue(operation(
                format!("background-{index}"),
                Lane::Background,
                format!("background-{index}"),
            ))
            .await
            .unwrap();
    }
    queue
        .enqueue(operation(
            "star".into(),
            Lane::Interactive,
            "thread:starred".into(),
        ))
        .await
        .unwrap();
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    assert!(star_started.load(Ordering::Acquire));
}

#[test]
fn mutation_history_write_back_rejects_an_older_full_state() {
    let connection = Storage::in_memory().unwrap();
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
    let message = |history_id| Message {
        account_id: "account".into(),
        id: "message".into(),
        thread_id: "thread".into(),
        rfc_message_id: None,
        sender: "A".into(),
        recipients: "B".into(),
        subject: "Subject".into(),
        sent_at: 0,
        snippet: "".into(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: true,
        is_starred: false,
        history_id,
    };
    assert!(MessageRepository::write_full_state(&connection, &message(10)).unwrap());
    MessageRepository::write_mutation_history(&connection, "account", &["message".into()], 20)
        .unwrap();
    assert!(!MessageRepository::write_full_state(&connection, &message(15)).unwrap());
}

#[tokio::test]
async fn rapid_distinct_thread_stars_coalesce_into_one_batch_modify_request() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .and(body_json(serde_json::json!({"ids":["message-a","message-b"],"addLabelIds":["STARRED"],"removeLabelIds":[]})))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(1)
        .mount(&server)
        .await;
    GmailClient::with_base_url("token", server.uri())
        .batch_modify(
            &["message-a".into(), "message-b".into()],
            &["STARRED".into()],
            &[],
        )
        .await
        .unwrap();
}
