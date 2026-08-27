use std::sync::{Arc, Mutex};

use latentmail_lib::{
    ai::{
        chat::{citations, validate_question, ChatRun, HISTORY_LIMIT, NO_RESULTS, QUESTION_LIMIT},
        retrieval::Passage,
        AiService,
    },
    storage::{
        Account, AccountAiConfigRepository, AccountRepository, EmbeddingRepository, HtmlPresence,
        Message, MessageEmbedding, MessageRepository, PassageSource, Storage,
    },
};
use tauri::Listener;
use wiremock::{
    matchers::{body_string_contains, method, path},
    Mock, MockServer, ResponseTemplate,
};

const BODY: &str = "The Q3 budget deadline is Friday and Priya owns the reconciliation";
const ANSWER: &str = "The deadline is Friday [1] and Priya owns it [1][9].";
const CITED_ANSWER: &str = "The deadline is Friday [1] and Priya owns it [1].";

fn account() -> Account {
    Account {
        id: "account".into(),
        email: "me@example.com".into(),
        display_name: "Me".into(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

fn message(id: &str, sender: &str, sent_at: i64) -> Message {
    Message {
        account_id: "account".into(),
        id: id.into(),
        thread_id: format!("thread-{id}"),
        rfc_message_id: None,
        sender: sender.into(),
        recipients: "me@example.com".into(),
        subject: format!("Subject {id}"),
        sent_at,
        snippet: "Snippet".into(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: Some(BODY.into()),
        html_presence: HtmlPresence::Absent,
    }
}

fn source(message_seq: i64, id: &str, sender: &str) -> PassageSource {
    PassageSource {
        message_seq,
        message_id: id.into(),
        thread_id: format!("thread-{id}"),
        sender: sender.into(),
        recipients: "me@example.com".into(),
        subject: format!("Subject {id}"),
        sent_at: 1_700_000_100,
        plain_body: None,
        html_body: None,
        truncated_body: Some(BODY.into()),
        has_attachments: false,
        attachment_count: 0,
        is_starred: false,
        is_unread: false,
    }
}

fn passage(message_seq: i64) -> Passage {
    Passage {
        message_seq,
        chunk_index: 0,
        similarity: 0.9,
        sent_at: 1_700_000_100,
        sender: "Alice Adams <alice@example.com>".into(),
        recipients: "me@example.com".into(),
        subject: "Subject alice".into(),
        text: BODY.into(),
        has_attachments: false,
        attachment_count: 0,
        is_starred: false,
        is_unread: false,
    }
}

async fn fixture(base_url: &str) -> (tempfile::TempDir, AiService) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    AccountAiConfigRepository::ensure(&connection, "account").unwrap();
    AccountAiConfigRepository::set_enabled(&connection, "account", true).unwrap();
    AccountAiConfigRepository::set_base_url(&connection, "account", base_url).unwrap();
    AccountAiConfigRepository::set_chat_model(&connection, "account", Some("chat")).unwrap();
    AccountAiConfigRepository::set_embedding_model(&connection, "account", "embedding", 2).unwrap();
    EmbeddingRepository::create(&connection, "account", 2).unwrap();
    MessageRepository::write_full_state(
        &connection,
        &message("alice", "Alice Adams <alice@example.com>", 1_700_000_100),
    )
    .unwrap();
    let sequence: i64 = connection
        .query_row(
            "SELECT seq FROM messages WHERE account_id='account' AND id='alice'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    EmbeddingRepository::write(
        &connection,
        "account",
        &[MessageEmbedding {
            message_seq: sequence,
            chunk_index: 0,
            vector: vec![1.0, 0.0],
        }],
    )
    .unwrap();
    drop(connection);
    (directory, AiService::new(storage))
}

async fn pipeline(server: &MockServer, answer_body: String) {
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("retrieval planner"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"content": "{}"}}]
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"data": [{"embedding": [1.0, 0.0]}]})),
        )
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("\"stream\":true"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(answer_body),
        )
        .mount(server)
        .await;
}

fn answer_stream() -> String {
    format!(
        "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n\ndata: [DONE]\n\n",
        serde_json::Value::String(ANSWER.to_owned())
    )
}

struct Recorder {
    app: tauri::App<tauri::test::MockRuntime>,
    events: Arc<Mutex<Vec<serde_json::Value>>>,
}

fn recorder() -> Recorder {
    let app = tauri::test::mock_app();
    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let collected = events.clone();
    app.handle().listen("ai-chat://event", move |event| {
        collected
            .lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });
    Recorder { app, events }
}

impl Recorder {
    fn kinds(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .map(|event| event["kind"].as_str().unwrap().to_owned())
            .collect()
    }
    fn of_kind(&self, kind: &str) -> Vec<serde_json::Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event["kind"] == kind)
            .cloned()
            .collect()
    }
}

#[test]
fn a_blank_a_whitespace_only_and_an_over_long_question_are_all_rejected() {
    assert!(validate_question("").is_err());
    assert!(validate_question("   \n\t ").is_err());
    assert!(validate_question(&"q".repeat(QUESTION_LIMIT + 1)).is_err());
    assert_eq!(
        validate_question(&"q".repeat(QUESTION_LIMIT))
            .unwrap()
            .len(),
        QUESTION_LIMIT
    );
    assert_eq!(validate_question("  ask me  ").unwrap(), "ask me");
}

#[tokio::test]
async fn only_one_request_is_active_and_cancellation_and_completion_cannot_clear_each_other() {
    let (_directory, service) = fixture("http://127.0.0.1:1/v1").await;
    let registry = service.chat();
    let first = registry.begin("account", "session", "question").unwrap();
    assert!(registry.begin("account", "session", "another").is_err());

    assert!(!registry.cancel("chat-unknown").unwrap());
    assert!(registry.cancel(&first.request_id).unwrap());
    assert!(first.cancel.load(std::sync::atomic::Ordering::SeqCst));
    assert!(!registry.retire(&first.request_id).unwrap());

    let second = registry.begin("account", "session", "question").unwrap();
    assert_ne!(second.request_id, first.request_id);
    assert!(registry.retire(&second.request_id).unwrap());
    assert!(!registry.cancel(&second.request_id).unwrap());
}

#[tokio::test]
async fn only_the_ten_most_recent_messages_travel_with_a_new_question() {
    let (_directory, service) = fixture("http://127.0.0.1:1/v1").await;
    let registry = service.chat();
    let first = registry.begin("account", "session", "question").unwrap();
    registry.retire(&first.request_id).unwrap();
    for index in 0..6 {
        registry
            .record("session", &format!("question {index}"), "answer")
            .unwrap();
    }
    let request = registry.begin("account", "session", "next").unwrap();
    assert_eq!(request.history.len(), HISTORY_LIMIT);
    assert_eq!(request.history[0].content, "question 1");
    registry.retire(&request.request_id).unwrap();

    let fresh = registry.begin("account", "other-session", "next").unwrap();
    assert!(fresh.history.is_empty());
    registry.retire(&fresh.request_id).unwrap();
    registry
        .record("session", "ignored for a stale session", "answer")
        .unwrap();
    let unchanged = registry.begin("account", "other-session", "next").unwrap();
    assert!(unchanged.history.is_empty());
    registry.retire(&unchanged.request_id).unwrap();
}

#[test]
fn citations_are_deduplicated_by_first_appearance_renumbered_and_pruned() {
    let passages = vec![passage(2), passage(7), passage(9)];
    let sources = vec![
        source(2, "alice", "Alice Adams <alice@example.com>"),
        source(7, "bob", "bob@example.com"),
        source(9, "cara", "Cara"),
    ];
    assert_eq!(
        citations("plain answer [x] [12a] [", &passages, &sources).0,
        "plain answer [x] [12a] ["
    );
    let (rewritten, resolved) = citations(
        "Second [2], first [1], again [2], unknown [8].",
        &passages,
        &sources,
    );
    assert_eq!(rewritten, "Second [1], first [2], again [1], unknown.");
    assert_eq!(
        resolved
            .iter()
            .map(|entry| (entry.number, entry.message_id.as_str()))
            .collect::<Vec<_>>(),
        vec![(1, "bob"), (2, "alice")]
    );
    assert_eq!(resolved[0].sender_name, "bob@example.com");
    assert_eq!(resolved[0].sender_address, "bob@example.com");
    assert_eq!(resolved[1].sender_name, "Alice Adams");
    assert_eq!(resolved[1].sender_address, "alice@example.com");
    assert_eq!(resolved[1].thread_id, "thread-alice");
    assert_eq!(resolved[1].sent_at_millis, 1_700_000_100_000);
    assert!(citations("No citation at all.", &passages, &sources)
        .1
        .is_empty());
    let (pruned, none) = citations("Out of range [4].", &passages, &sources);
    assert!(none.is_empty());
    assert_eq!(pruned, "Out of range.");
}

#[tokio::test]
async fn a_full_exchange_streams_deltas_then_sources_and_writes_no_chat_content_to_the_log() {
    let server = MockServer::start().await;
    pipeline(&server, answer_stream()).await;
    let (_directory, service) = fixture(&format!("{}/v1", server.uri())).await;
    let recorder = recorder();
    let logs = tempfile::tempdir().unwrap();
    let (dispatch, guard, _handle) = latentmail_lib::logging::subscriber(
        logs.path(),
        tracing_subscriber::filter::LevelFilter::DEBUG,
    )
    .unwrap();
    let request = service
        .chat()
        .begin("account", "session", "deadline?")
        .unwrap();
    let request_id = request.request_id.clone();
    {
        let _default = tracing::dispatcher::set_default(&dispatch);
        latentmail_lib::ai::chat::run(recorder.app.handle(), &service, request).await;
    }
    drop(guard);

    assert_eq!(
        recorder.kinds(),
        vec!["started", "delta", "sources", "done"]
    );
    let delta = recorder.of_kind("delta");
    assert_eq!(delta[0]["text"], ANSWER);
    assert_eq!(delta[0]["requestId"], request_id.as_str());
    assert_eq!(delta[0]["sessionId"], "session");
    assert_eq!(delta[0]["accountId"], "account");
    let sources = recorder.of_kind("sources");
    assert_eq!(sources[0]["answer"], CITED_ANSWER);
    assert_eq!(sources[0]["sources"][0]["number"], 1);
    assert_eq!(sources[0]["sources"][0]["senderName"], "Alice Adams");
    assert_eq!(sources[0]["sources"][0]["messageId"], "alice");
    assert_eq!(
        sources[0]["sources"][0]["sentAtMillis"],
        1_700_000_100_000i64
    );
    let done = recorder.of_kind("done");
    assert_eq!(done[0]["cancelled"], false);
    assert_eq!(done[0]["error"], serde_json::Value::Null);
    let following = service.chat().begin("account", "session", "next").unwrap();
    assert_eq!(following.history.len(), 2);
    assert_eq!(following.history[0].content, "deadline?");
    assert_eq!(following.history[1].content, CITED_ANSWER);
    service.chat().retire(&following.request_id).unwrap();

    let log = std::fs::read_to_string(
        std::fs::read_dir(logs.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path(),
    )
    .unwrap();
    assert!(!log.contains(ANSWER));
    assert!(!log.contains(BODY));
    assert!(!log.contains("deadline?"));
}

#[tokio::test]
async fn a_cancelled_request_keeps_its_partial_text_and_gains_no_sources() {
    let server = MockServer::start().await;
    pipeline(&server, answer_stream()).await;
    let (_directory, service) = fixture(&format!("{}/v1", server.uri())).await;
    let recorder = recorder();
    let request = service
        .chat()
        .begin("account", "session", "deadline?")
        .unwrap();
    assert!(service.chat().cancel(&request.request_id).unwrap());
    latentmail_lib::ai::chat::run(recorder.app.handle(), &service, request).await;

    assert_eq!(recorder.kinds(), vec!["started", "done"]);
    assert_eq!(recorder.of_kind("done")[0]["cancelled"], true);
    assert!(recorder.of_kind("sources").is_empty());
    let following = service
        .chat()
        .begin("account", "session", "next")
        .expect("a cancelled request no longer occupies the registry");
    assert!(following.history.is_empty());
}

#[tokio::test]
async fn retrieval_that_finds_nothing_answers_without_calling_the_chat_model() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("retrieval planner"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"content": "{}"}}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"data": [{"embedding": [0.0, 1.0]}]})),
        )
        .mount(&server)
        .await;
    let (_directory, service) = fixture(&format!("{}/v1", server.uri())).await;
    let recorder = recorder();
    let request = service
        .chat()
        .begin("account", "session", "zzzqqq wwwvvv?")
        .unwrap();
    latentmail_lib::ai::chat::run(recorder.app.handle(), &service, request).await;

    assert_eq!(recorder.kinds(), vec!["started", "delta", "done"]);
    assert_eq!(recorder.of_kind("delta")[0]["text"], NO_RESULTS);
    assert_eq!(
        recorder.of_kind("done")[0]["error"],
        serde_json::Value::Null
    );
}

#[tokio::test]
async fn a_failure_reaching_the_provider_ends_the_request_with_its_error() {
    let (_directory, service) = fixture("http://127.0.0.1:1/v1").await;
    let recorder = recorder();
    let request = service
        .chat()
        .begin("account", "session", "deadline?")
        .unwrap();
    let request_id = request.request_id.clone();
    latentmail_lib::ai::chat::run(recorder.app.handle(), &service, request).await;

    let done = recorder.of_kind("done");
    assert_eq!(done[0]["cancelled"], false);
    assert!(done[0]["error"].as_str().unwrap().contains("provider"));
    assert!(!service.chat().retire(&request_id).unwrap());
}

#[tokio::test]
async fn a_storage_backed_readiness_failure_names_the_missing_prerequisite() {
    let (_directory, service) = fixture("http://127.0.0.1:1/v1").await;
    assert!(service.chat_ready("account").await.is_ok());
    assert!(service.chat_ready("missing").await.is_err());
    service
        .storage()
        .run(|connection| AccountAiConfigRepository::set_chat_model(connection, "account", None))
        .await
        .unwrap();
    assert_eq!(
        service.chat_ready("account").await.unwrap_err(),
        "Select a chat model first"
    );
    service
        .storage()
        .run(|connection| AccountAiConfigRepository::set_enabled(connection, "account", false))
        .await
        .unwrap();
    assert_eq!(
        service.chat_ready("account").await.unwrap_err(),
        "AI is turned off for this account"
    );
}

#[tokio::test]
async fn a_request_carries_its_own_identity_for_every_event() {
    let (_directory, service) = fixture("http://127.0.0.1:1/v1").await;
    let request: ChatRun = service.chat().begin("account", "session", "hello").unwrap();
    assert!(request.request_id.starts_with("chat-"));
    assert_eq!(request.session_id, "session");
    assert_eq!(request.account_id, "account");
    assert_eq!(request.question, "hello");
}

#[tokio::test]
async fn a_configuration_gap_discovered_after_the_request_started_ends_it_with_that_reason() {
    let (_directory, service) = fixture("http://127.0.0.1:1/v1").await;
    let recorder = recorder();
    for (clear, reason) in [
        ("embedding_model", "Select an embedding model first"),
        ("chat_model", "Select a chat model first"),
        ("base_url", "Save an API root first"),
    ] {
        let column = clear.to_owned();
        service
            .storage()
            .run(move |connection| {
                connection.execute(
                    &format!(
                        "UPDATE account_ai_config SET {column}=NULL WHERE account_id='account'"
                    ),
                    [],
                )
            })
            .await
            .unwrap();
        let request = service
            .chat()
            .begin("account", "session", "deadline?")
            .unwrap();
        latentmail_lib::ai::chat::run(recorder.app.handle(), &service, request).await;
        assert_eq!(
            recorder.of_kind("done").last().unwrap()["error"],
            serde_json::Value::String(reason.to_owned())
        );
    }
}
