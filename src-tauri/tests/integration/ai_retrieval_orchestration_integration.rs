use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Barrier,
};

use latentmail_lib::{
    ai::{
        chunker,
        provider::Provider,
        retrieval::{retrieve, HistoryMessage, Retrieval, RetrievalRequest, Role},
    },
    storage::{
        Account, AccountRepository, EmbeddingRepository, HtmlPresence, Message, MessageEmbedding,
        MessageRepository, Storage,
    },
};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, Request, Respond, ResponseTemplate,
};

const BODY: &str = "The Q3 budget deadline is Friday and Priya owns the reconciliation";
const QUESTION: &str = "what is the budget deadline";

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

fn message(id: &str, sender: &str, body: &str, sent_at: i64) -> Message {
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
        truncated_body: Some(body.into()),
        html_presence: HtmlPresence::Absent,
    }
}

fn build(entries: &[(Message, Vec<f32>)]) -> (tempfile::TempDir, Storage, Vec<i64>) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    EmbeddingRepository::create(&connection, "account", 2).unwrap();
    let mut sequences = Vec::new();
    for (stored, vector) in entries {
        MessageRepository::write_full_state(&connection, stored).unwrap();
        let sequence: i64 = connection
            .query_row(
                "SELECT seq FROM messages WHERE account_id='account' AND id=?1",
                [&stored.id],
                |row| row.get(0),
            )
            .unwrap();
        EmbeddingRepository::write(
            &connection,
            "account",
            &[MessageEmbedding {
                message_seq: sequence,
                chunk_index: 0,
                vector: vector.clone(),
            }],
        )
        .unwrap();
        sequences.push(sequence);
    }
    drop(connection);
    (directory, storage, sequences)
}

fn near_and_far() -> (tempfile::TempDir, Storage, Vec<i64>) {
    build(&[
        (
            message(
                "alice",
                "Alice Adams <alice@example.com>",
                BODY,
                1_700_000_100,
            ),
            vec![1.0, 0.0],
        ),
        (
            message(
                "bob",
                "Bob Brown <bob@example.com>",
                "Unrelated chatter about lunch plans",
                1_700_000_200,
            ),
            vec![0.0, 1.0],
        ),
    ])
}

fn lexical_only_extra() -> (tempfile::TempDir, Storage, Vec<i64>) {
    build(&[
        (
            message(
                "alice",
                "Alice Adams <alice@example.com>",
                BODY,
                1_700_000_100,
            ),
            vec![1.0, 0.0],
        ),
        (
            message(
                "bob",
                "Bob Brown <bob@example.com>",
                "Unrelated chatter about lunch plans",
                1_700_000_200,
            ),
            vec![0.0, 1.0],
        ),
        (
            message(
                "carol",
                "Carol Clark <carol@example.com>",
                "budget spreadsheet attached for review",
                1_700_000_300,
            ),
            vec![0.0, 1.0],
        ),
    ])
}

fn chronological_corpus() -> (tempfile::TempDir, Storage, Vec<i64>) {
    let mut entries = vec![
        (
            message("newest", "Ada <ada@example.com>", "budget deadline", 3_000),
            vec![0.0, 1.0],
        ),
        (
            message(
                "middle",
                "Ben <ben@example.com>",
                "budget deadline notes and some extra words here to lengthen the document",
                2_000,
            ),
            vec![0.0, 1.0],
        ),
        (
            message("oldest", "Cy <cy@example.com>", "budget only", 1_000),
            vec![0.0, 1.0],
        ),
    ];
    for index in 0..10 {
        entries.push((
            message(
                &format!("pad-{index}"),
                "Pad <pad@example.com>",
                "lunch plans",
                5_000 + index,
            ),
            vec![0.0, 1.0],
        ));
    }
    build(&entries)
}

async fn embeddings(server: &MockServer, vector: Vec<f32>) {
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"data": [{"embedding": vector}]})),
        )
        .mount(server)
        .await;
}

async fn plan_reply(server: &MockServer, content: &str) {
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"content": content}}]
        })))
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

async fn found(
    server: &MockServer,
    storage: &Storage,
    question: &str,
) -> latentmail_lib::ai::retrieval::Retrieved {
    let history = Vec::new();
    let outcome = retrieve(
        &provider(server),
        storage,
        &request(question, &history),
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    match outcome {
        Retrieval::Found(found) => *found,
        other => panic!("expected passages, got {other:?}"),
    }
}

struct CancelOnCall {
    cancel: Arc<AtomicBool>,
    body: serde_json::Value,
}

impl Respond for CancelOnCall {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        self.cancel.store(true, Ordering::SeqCst);
        ResponseTemplate::new(200).set_body_json(self.body.clone())
    }
}

async fn rendezvous_endpoint(arrivals: Arc<Mutex<Vec<String>>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let barrier = Arc::new(Barrier::new(2));
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(serve_after_rendezvous(
                socket,
                barrier.clone(),
                arrivals.clone(),
            ));
        }
    });
    format!("http://{address}")
}

async fn serve_after_rendezvous(
    mut socket: TcpStream,
    barrier: Arc<Barrier>,
    arrivals: Arc<Mutex<Vec<String>>>,
) {
    let mut received = Vec::new();
    let mut chunk = [0_u8; 2048];
    loop {
        let read = socket.read(&mut chunk).await.unwrap_or(0);
        if read == 0 {
            return;
        }
        received.extend_from_slice(&chunk[..read]);
        if let Some(head) = head_length(&received) {
            if received.len() >= head + declared_body_length(&received[..head]) {
                break;
            }
        }
    }
    let head = String::from_utf8_lossy(&received).into_owned();
    let embeddings = head.contains("/v1/embeddings");
    let path = if embeddings {
        "/v1/embeddings"
    } else {
        "/v1/chat/completions"
    };
    arrivals.lock().unwrap().push(path.to_owned());
    barrier.wait().await;
    let body = if embeddings {
        serde_json::json!({"data": [{"embedding": [1.0, 0.0]}]})
    } else {
        serde_json::json!({"choices": [{"message": {"content": "{\"dateOrder\":\"asc\"}"}}]})
    }
    .to_string();
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

fn head_length(received: &[u8]) -> Option<usize> {
    received
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|start| start + 4)
}

fn declared_body_length(head: &[u8]) -> usize {
    String::from_utf8_lossy(head)
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|value| value.trim().parse::<usize>().ok())
        })
        .unwrap_or(0)
}

#[tokio::test]
async fn the_planner_call_and_the_unfiltered_retrieval_pass_are_in_flight_at_the_same_time() {
    let (_directory, storage, sequences) = chronological_corpus();
    let arrivals = Arc::new(Mutex::new(Vec::new()));
    let base = rendezvous_endpoint(arrivals.clone()).await;
    let provider = Provider::new(&format!("{base}/v1"), None).unwrap();
    let history = Vec::new();
    let outcome = tokio::time::timeout(
        Duration::from_secs(2),
        retrieve(
            &provider,
            &storage,
            &request("budget deadline", &history),
            &AtomicBool::new(false),
        ),
    )
    .await
    .expect("the planner and the retrieval pass never overlapped")
    .unwrap();
    let Retrieval::Found(found) = outcome else {
        panic!("expected passages, got {outcome:?}");
    };
    assert_eq!(
        arrivals.lock().unwrap().clone(),
        vec![
            "/v1/embeddings".to_owned(),
            "/v1/chat/completions".to_owned()
        ]
    );
    assert_eq!(
        found
            .passages
            .iter()
            .map(|passage| passage.message_seq)
            .collect::<Vec<_>>(),
        vec![sequences[0], sequences[2], sequences[1]]
    );
}

#[tokio::test]
async fn the_pipeline_scores_similarity_as_one_minus_the_returned_distance() {
    let (_directory, storage, _sequences) = near_and_far();
    let server = MockServer::start().await;
    plan_reply(&server, "{}").await;
    embeddings(&server, vec![1.0, 0.0]).await;
    let found = found(&server, &storage, QUESTION).await;
    assert_eq!(found.passages.len(), 1);
    assert!(found.passages[0].similarity > 0.99);
    assert_eq!(found.passages[0].chunk_index, 0);
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
    assert_eq!(Role::User.label(), "user");
    assert_eq!(Role::Assistant.label(), "assistant");
}

#[tokio::test]
async fn two_candidates_from_one_message_yield_a_single_passage_from_one_chunking() {
    let words = (0..260)
        .map(|index| format!("word{index}"))
        .collect::<Vec<_>>()
        .join(" ");
    let body = format!("budget deadline {words}");
    let (_directory, storage, sequences) = build(&[(
        message(
            "alice",
            "Alice Adams <alice@example.com>",
            &body,
            1_700_000_100,
        ),
        vec![0.6, 0.8],
    )]);
    storage
        .run(move |connection| {
            EmbeddingRepository::write(
                connection,
                "account",
                &[MessageEmbedding {
                    message_seq: 1,
                    chunk_index: 1,
                    vector: vec![1.0, 0.0],
                }],
            )
        })
        .await
        .unwrap();
    let server = MockServer::start().await;
    plan_reply(&server, "{}").await;
    embeddings(&server, vec![1.0, 0.0]).await;
    let found = found(&server, &storage, QUESTION).await;
    assert_eq!(found.passages.len(), 1);
    assert_eq!(found.passages[0].message_seq, sequences[0]);
    assert_eq!(found.passages[0].chunk_index, 1);
    assert_eq!(found.sources.len(), 1);
    assert!(!found.passages[0].text.contains("From: Alice"));
}

#[tokio::test]
async fn the_vector_arm_and_the_lexical_arm_both_contribute_to_the_fused_result() {
    let (_directory, storage, sequences) = lexical_only_extra();
    let server = MockServer::start().await;
    plan_reply(&server, "{}").await;
    embeddings(&server, vec![1.0, 0.0]).await;
    let found = found(&server, &storage, QUESTION).await;
    assert_eq!(
        found
            .sources
            .iter()
            .map(|source| source.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["alice", "carol"]
    );
    assert_eq!(found.passages[0].message_seq, sequences[0]);
    assert_eq!(found.passages[1].message_seq, sequences[2]);
    assert!(found.passages[0].similarity > 0.99);
    assert_eq!(found.passages[1].similarity, 0.0);
    assert!(found.passages[0].sent_at < found.passages[1].sent_at);
}

#[tokio::test]
async fn a_planner_failure_a_malformed_reply_and_a_planner_timeout_all_answer_unfiltered() {
    for template in [
        ResponseTemplate::new(500),
        ResponseTemplate::new(408),
        ResponseTemplate::new(200)
            .set_body_json(serde_json::json!({"choices": [{"message": {"content": "sorry!"}}]})),
    ] {
        let (_directory, storage, _sequences) = near_and_far();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(template)
            .mount(&server)
            .await;
        embeddings(&server, vec![1.0, 0.0]).await;
        let found = found(&server, &storage, QUESTION).await;
        assert_eq!(found.sources.len(), 1);
        assert_eq!(found.sources[0].message_id, "alice");
    }
}

#[tokio::test]
async fn an_ascending_plan_adds_the_chronological_arm_and_lifts_the_oldest_match() {
    let (_directory, storage, sequences) = chronological_corpus();
    let question = "budget deadline";
    let default_server = MockServer::start().await;
    plan_reply(&default_server, "{}").await;
    embeddings(&default_server, vec![1.0, 0.0]).await;
    let unordered = found(&default_server, &storage, question).await;
    assert_eq!(
        unordered
            .passages
            .iter()
            .map(|passage| passage.message_seq)
            .collect::<Vec<_>>(),
        vec![sequences[0], sequences[1], sequences[2]]
    );

    let ascending_server = MockServer::start().await;
    plan_reply(&ascending_server, r#"{"dateOrder":"asc"}"#).await;
    embeddings(&ascending_server, vec![1.0, 0.0]).await;
    let ascending = found(&ascending_server, &storage, question).await;
    assert_eq!(
        ascending
            .passages
            .iter()
            .map(|passage| passage.message_seq)
            .collect::<Vec<_>>(),
        vec![sequences[0], sequences[2], sequences[1]]
    );
    assert_eq!(ascending.sources[1].message_id, "oldest");
}

#[tokio::test]
async fn a_planner_filter_narrows_the_result_without_removing_the_unfiltered_arms() {
    let (_directory, storage, _sequences) = lexical_only_extra();
    let server = MockServer::start().await;
    plan_reply(&server, r#"{"sender":"carol@example.com"}"#).await;
    embeddings(&server, vec![1.0, 0.0]).await;
    let found = found(&server, &storage, QUESTION).await;
    assert_eq!(
        found
            .sources
            .iter()
            .map(|source| source.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["alice", "carol"]
    );
    assert!(found.passages[1].similarity < f64::EPSILON);
}

#[tokio::test]
async fn one_failing_arm_does_not_fail_a_request_another_arm_can_answer() {
    let (_directory, storage, _sequences) = lexical_only_extra();
    storage
        .run(|connection| EmbeddingRepository::drop(connection, "account"))
        .await
        .unwrap();
    let server = MockServer::start().await;
    plan_reply(&server, "{}").await;
    embeddings(&server, vec![1.0, 0.0]).await;
    let found = found(&server, &storage, QUESTION).await;
    assert_eq!(
        found
            .sources
            .iter()
            .map(|source| source.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["alice", "carol"]
    );
}

#[tokio::test]
async fn a_short_embedding_batch_and_a_total_storage_failure_both_surface_as_errors() {
    let (_directory, storage, _sequences) = near_and_far();
    let server = MockServer::start().await;
    plan_reply(&server, "{}").await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": []})))
        .mount(&server)
        .await;
    let history = Vec::new();
    assert_eq!(
        retrieve(
            &provider(&server),
            &storage,
            &request(QUESTION, &history),
            &AtomicBool::new(false),
        )
        .await
        .unwrap_err(),
        "Provider returned an incomplete embedding batch"
    );

    let (_broken_directory, broken, _broken_sequences) = near_and_far();
    broken
        .run(|connection| {
            EmbeddingRepository::drop(connection, "account")?;
            connection.execute("DROP TABLE message_search", [])?;
            Ok(())
        })
        .await
        .unwrap();
    let broken_server = MockServer::start().await;
    plan_reply(&broken_server, "{}").await;
    embeddings(&broken_server, vec![1.0, 0.0]).await;
    assert!(retrieve(
        &provider(&broken_server),
        &broken,
        &request(QUESTION, &history),
        &AtomicBool::new(false),
    )
    .await
    .is_err());
}

#[tokio::test]
async fn a_question_no_arm_matches_reports_an_empty_retrieval() {
    let (_directory, storage, _sequences) = build(&[(
        message(
            "alice",
            "Alice Adams <alice@example.com>",
            BODY,
            1_700_000_100,
        ),
        vec![1.0, 0.0],
    )]);
    let server = MockServer::start().await;
    plan_reply(&server, "{}").await;
    embeddings(&server, vec![0.0, 1.0]).await;
    let history = Vec::new();
    assert_eq!(
        retrieve(
            &provider(&server),
            &storage,
            &request("zzzqqq wwwvvv", &history),
            &AtomicBool::new(false),
        )
        .await
        .unwrap(),
        Retrieval::Empty
    );
}

#[tokio::test]
async fn cancelling_before_the_planner_and_during_retrieval_both_report_cancelled() {
    let (_directory, storage, _sequences) = near_and_far();
    let unreachable = Provider::new("http://127.0.0.1:1/v1", None).unwrap();
    let history = Vec::new();
    assert_eq!(
        retrieve(
            &unreachable,
            &storage,
            &request(QUESTION, &history),
            &AtomicBool::new(true),
        )
        .await
        .unwrap(),
        Retrieval::Cancelled
    );

    let server = MockServer::start().await;
    let cancel = Arc::new(AtomicBool::new(false));
    plan_reply(&server, "{}").await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(CancelOnCall {
            cancel: cancel.clone(),
            body: serde_json::json!({"data": [{"embedding": [1.0, 0.0]}]}),
        })
        .mount(&server)
        .await;
    assert_eq!(
        retrieve(
            &provider(&server),
            &storage,
            &request(QUESTION, &history),
            &cancel,
        )
        .await
        .unwrap(),
        Retrieval::Cancelled
    );
}
