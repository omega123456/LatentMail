use std::sync::atomic::AtomicBool;

use latentmail_lib::{
    ai::{
        chunker,
        provider::Provider,
        retrieval::{
            retrieve, rewrite_variants, HistoryMessage, Retrieval, RetrievalRequest, Role,
        },
    },
    storage::{
        Account, AccountRepository, EmbeddingRepository, HtmlPresence, Message, MessageEmbedding,
        MessageRepository, Storage,
    },
};
use wiremock::{
    matchers::{body_string_contains, method, path},
    Mock, MockServer, ResponseTemplate,
};

const BODY: &str = "The Q3 budget deadline is Friday and Priya owns the reconciliation";

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

fn fixture() -> (tempfile::TempDir, Storage) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    EmbeddingRepository::create(&connection, "account", 2).unwrap();
    MessageRepository::write_full_state(
        &connection,
        &message("alice", "Alice Adams <alice@example.com>", 1_700_000_100),
    )
    .unwrap();
    MessageRepository::write_full_state(
        &connection,
        &message("bob", "Bob Brown <bob@example.com>", 1_700_000_200),
    )
    .unwrap();
    let sequences: Vec<i64> = connection
        .prepare("SELECT seq FROM messages WHERE account_id='account' ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    EmbeddingRepository::write(
        &connection,
        "account",
        &[
            MessageEmbedding {
                message_seq: sequences[0],
                chunk_index: 0,
                vector: vec![1.0, 0.0],
            },
            MessageEmbedding {
                message_seq: sequences[1],
                chunk_index: 0,
                vector: vec![0.98, 0.2],
            },
        ],
    )
    .unwrap();
    drop(connection);
    (directory, storage)
}

fn unrelated_vector(storage: &Storage) {
    let connection = storage.connection().unwrap();
    let sequence: i64 = connection
        .query_row(
            "SELECT seq FROM messages WHERE account_id='account' AND id='bob'",
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
            vector: vec![0.0, 1.0],
        }],
    )
    .unwrap();
}

async fn embeddings(server: &MockServer, count: usize) {
    let data: Vec<serde_json::Value> = (0..count)
        .map(|_| serde_json::json!({"embedding": [1.0, 0.0]}))
        .collect();
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": data})))
        .mount(server)
        .await;
}

async fn rewriter(server: &MockServer, variants: serde_json::Value) {
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("search query rewriter"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"content": variants.to_string()}}]
        })))
        .mount(server)
        .await;
}

async fn relevance(server: &MockServer, relevant: bool) {
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("relevance assessor"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"content": format!("{{\"relevant\": {relevant}}}")}}]
        })))
        .expect(1)
        .mount(server)
        .await;
}

fn provider(server: &MockServer) -> Provider {
    Provider::new(&format!("{}/v1", server.uri()), Some("secret".into())).unwrap()
}

fn request<'a>(question: &'a str, history: &'a [HistoryMessage]) -> RetrievalRequest<'a> {
    RetrievalRequest {
        chat_model: "chat",
        embedding_model: "embedding",
        account_id: "account",
        account_email: "me@example.com",
        question,
        history,
    }
}

#[tokio::test]
async fn the_pipeline_scores_similarity_as_one_minus_the_returned_distance() {
    let (_directory, storage) = fixture();
    unrelated_vector(&storage);
    let server = MockServer::start().await;
    rewriter(
        &server,
        serde_json::json!([
            {"query": "budget"},
            {"query": "budget"},
            {"query": "budget"},
            {"query": "budget"},
            {"query": "budget"}
        ]),
    )
    .await;
    embeddings(&server, 1).await;
    let history = Vec::new();
    let outcome = retrieve(
        &provider(&server),
        &storage,
        &request("what is the budget deadline", &history),
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    let Retrieval::Found(found) = outcome else {
        panic!("expected passages");
    };
    assert_eq!(found.passages.len(), 1);
    assert!(found.passages[0].similarity > 0.99);
    assert_eq!(found.sources.len(), 1);
    assert_eq!(found.sources[0].message_id, "alice");
    let expected = chunker::chunks(
        "Alice Adams <alice@example.com>",
        "me@example.com",
        "Subject alice",
        Some(BODY),
        None,
        None,
    );
    assert!(expected[0].ends_with(&found.passages[0].text));
    assert_eq!(found.passages[0].text, BODY);
    assert!(found
        .context
        .starts_with("[1] From: Alice Adams <alice@example.com>"));
    assert!(found.context.ends_with(BODY));
}

#[tokio::test]
async fn variant_iteration_skips_duplicates_advances_past_a_rejection_and_reports_nothing_found() {
    let (_directory, storage) = fixture();
    let server = MockServer::start().await;
    rewriter(
        &server,
        serde_json::json!([
            {"query": "alice budget", "sender": "alice@example.com"},
            {"query": "alice budget", "sender": "alice@example.com"},
            {"query": "alice budget", "sender": "alice@example.com"},
            {"query": "alice budget", "sender": "alice@example.com"},
            {"query": "everything", "dateOrder": "asc"}
        ]),
    )
    .await;
    embeddings(&server, 2).await;
    relevance(&server, false).await;
    let history = vec![
        HistoryMessage {
            role: Role::User,
            content: "who owns the budget".into(),
        },
        HistoryMessage {
            role: Role::Assistant,
            content: "Priya does".into(),
        },
    ];
    let outcome = retrieve(
        &provider(&server),
        &storage,
        &request("what is the deadline", &history),
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    let Retrieval::Found(found) = outcome else {
        panic!("expected passages");
    };
    assert_eq!(found.passages.len(), 2);
    assert_eq!(
        found
            .sources
            .iter()
            .map(|source| source.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["alice", "bob"]
    );
    assert_eq!(Role::User.label(), "user");
    assert_eq!(Role::Assistant.label(), "assistant");

    let (_empty_directory, empty_storage) = fixture();
    let empty_server = MockServer::start().await;
    rewriter(
        &empty_server,
        serde_json::json!([
            {"query": "nobody", "sender": "nobody@example.com"},
            {"query": "nobody", "sender": "nobody@example.com"},
            {"query": "nobody", "sender": "nobody@example.com"},
            {"query": "nobody", "sender": "nobody@example.com"},
            {"query": "nobody", "sender": "nobody@example.com"}
        ]),
    )
    .await;
    embeddings(&empty_server, 1).await;
    assert_eq!(
        retrieve(
            &provider(&empty_server),
            &empty_storage,
            &request("who is nobody", &[]),
            &AtomicBool::new(false),
        )
        .await
        .unwrap(),
        Retrieval::Empty
    );
}

#[tokio::test]
async fn a_failed_rewrite_falls_back_to_the_raw_question_in_every_slot() {
    let (_directory, storage) = fixture();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    embeddings(&server, 1).await;
    let history = Vec::new();
    let variants = rewrite_variants(
        &provider(&server),
        &request("what is the budget deadline", &history),
        &["Inbox".to_owned()],
    )
    .await;
    assert_eq!(variants.len(), 5);
    assert!(variants
        .iter()
        .all(|variant| variant.query == "what is the budget deadline"
            && variant.filters.is_empty()
            && !variant.ascending));
    let Retrieval::Found(found) = retrieve(
        &provider(&server),
        &storage,
        &request("what is the budget deadline", &history),
        &AtomicBool::new(false),
    )
    .await
    .unwrap() else {
        panic!("expected passages");
    };
    assert_eq!(found.passages.len(), 2);
}

#[tokio::test]
async fn provider_and_storage_failures_surface_as_errors() {
    let (_directory, storage) = fixture();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(401))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    let history = Vec::new();
    assert!(retrieve(
        &provider(&server),
        &storage,
        &request("what is the budget deadline", &history),
        &AtomicBool::new(false),
    )
    .await
    .is_err());
    embeddings(&server, 1).await;
    storage
        .connection()
        .unwrap()
        .execute("DELETE FROM accounts WHERE id='account'", [])
        .unwrap();
    assert!(retrieve(
        &provider(&server),
        &storage,
        &request("what is the budget deadline", &history),
        &AtomicBool::new(false),
    )
    .await
    .is_err());

    let (_short_directory, short_storage) = fixture();
    let short_server = MockServer::start().await;
    rewriter(
        &short_server,
        serde_json::json!([
            {"query": "one"},
            {"query": "two"},
            {"query": "three"},
            {"query": "four"},
            {"query": "five"}
        ]),
    )
    .await;
    embeddings(&short_server, 2).await;
    assert!(retrieve(
        &provider(&short_server),
        &short_storage,
        &request("what is the budget deadline", &history),
        &AtomicBool::new(false),
    )
    .await
    .is_err());
}

#[tokio::test]
async fn a_cancelled_request_stops_before_the_provider_is_asked_anything() {
    let (_directory, storage) = fixture();
    let unreachable = Provider::new("http://127.0.0.1:1/v1", None).unwrap();
    let history = Vec::new();
    assert_eq!(
        retrieve(
            &unreachable,
            &storage,
            &request("what is the budget deadline", &history),
            &AtomicBool::new(true),
        )
        .await
        .unwrap(),
        Retrieval::Cancelled
    );
}
