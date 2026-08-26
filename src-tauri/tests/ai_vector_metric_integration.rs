use latentmail_lib::{
    ai::{index, AiService, IndexState},
    storage::{
        Account, AccountAiConfigRepository, AccountRepository, EmbeddingRepository, HtmlPresence,
        Message, MessageEmbedding, MessageRepository, RetrievalFilters, RetrievalRepository,
        Storage,
    },
};

fn account() -> Account {
    Account {
        id: "account".into(),
        email: "mail@example.com".into(),
        display_name: "Mail".into(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

fn message(id: &str) -> Message {
    Message {
        account_id: "account".into(),
        id: id.into(),
        thread_id: format!("thread-{id}"),
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: "recipient@example.com".into(),
        subject: "Subject".into(),
        sent_at: 1_700_000_000,
        snippet: "Snippet".into(),
        html_body: None,
        plain_body: Some("Body".into()),
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: Some("Immutable body".into()),
        html_presence: HtmlPresence::Absent,
    }
}

fn message_seq(connection: &rusqlite::Connection, id: &str) -> i64 {
    connection
        .query_row(
            "SELECT seq FROM messages WHERE account_id='account' AND id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
}

fn vector_count(connection: &rusqlite::Connection) -> i64 {
    connection
        .query_row("SELECT COUNT(*) FROM message_vectors_1", [], |row| {
            row.get(0)
        })
        .unwrap()
}

fn declaration(connection: &rusqlite::Connection) -> String {
    connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='message_vectors_1'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn a_new_vector_table_declares_cosine_distance() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    EmbeddingRepository::create(&connection, "account", 2).unwrap();
    assert!(declaration(&connection).contains("distance_metric=cosine"));
    assert!(!EmbeddingRepository::needs_rebuild(&connection, "account").unwrap());
}

#[test]
fn a_legacy_vector_table_is_reported_and_never_dropped() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    connection
        .execute_batch("CREATE VIRTUAL TABLE message_vectors_1 USING vec0(embedding float[2])")
        .unwrap();
    MessageRepository::write_full_state(&connection, &message("legacy")).unwrap();
    let seq = message_seq(&connection, "legacy");
    EmbeddingRepository::write(
        &connection,
        "account",
        &[MessageEmbedding {
            message_seq: seq,
            chunk_index: 0,
            vector: vec![1.0, 0.0],
        }],
    )
    .unwrap();
    assert!(EmbeddingRepository::needs_rebuild(&connection, "account").unwrap());
    EmbeddingRepository::create(&connection, "account", 2).unwrap();
    assert!(EmbeddingRepository::needs_rebuild(&connection, "account").unwrap());
    assert_eq!(vector_count(&connection), 1);
    assert!(!declaration(&connection).contains("distance_metric=cosine"));
    EmbeddingRepository::drop(&connection, "account").unwrap();
    EmbeddingRepository::create(&connection, "account", 2).unwrap();
    assert!(!EmbeddingRepository::needs_rebuild(&connection, "account").unwrap());
}

#[tokio::test]
async fn a_legacy_table_outranks_paused_and_building_and_fails_the_readiness_check() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    {
        let connection = storage.connection().unwrap();
        AccountRepository::upsert(&connection, &account()).unwrap();
        AccountAiConfigRepository::set_enabled(&connection, "account", true).unwrap();
        AccountAiConfigRepository::set_base_url(&connection, "account", "http://localhost/v1")
            .unwrap();
        AccountAiConfigRepository::set_embedding_model(&connection, "account", "embedding", 2)
            .unwrap();
        connection
            .execute_batch("CREATE VIRTUAL TABLE message_vectors_1 USING vec0(embedding float[2])")
            .unwrap();
        AccountAiConfigRepository::set_index_paused(&connection, "account", true).unwrap();
    }
    let service = AiService::new(storage);
    service
        .set_index_state("account", IndexState::Building)
        .unwrap();
    assert_eq!(
        index::status(&service, "account".to_owned())
            .await
            .unwrap()
            .state,
        IndexState::NeedsRebuild
    );
    assert!(!service.index_ready("account").await.unwrap());
}

#[test]
fn cosine_distance_scores_a_near_identical_vector_far_above_an_unrelated_one() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    EmbeddingRepository::create(&connection, "account", 2).unwrap();
    MessageRepository::write_full_state(&connection, &message("same")).unwrap();
    MessageRepository::write_full_state(&connection, &message("other")).unwrap();
    let same = message_seq(&connection, "same");
    let other = message_seq(&connection, "other");
    EmbeddingRepository::write(
        &connection,
        "account",
        &[
            MessageEmbedding {
                message_seq: same,
                chunk_index: 0,
                vector: vec![1.0, 0.0],
            },
            MessageEmbedding {
                message_seq: other,
                chunk_index: 0,
                vector: vec![0.0, 1.0],
            },
        ],
    )
    .unwrap();
    let candidates = RetrievalRepository::candidates(
        &connection,
        "account",
        &[1.0, 0.0],
        10,
        &RetrievalFilters::default(),
    )
    .unwrap();
    let near = candidates
        .iter()
        .find(|candidate| candidate.message_seq == same)
        .unwrap();
    let far = candidates
        .iter()
        .find(|candidate| candidate.message_seq == other)
        .unwrap();
    assert!(1.0 - near.distance > 0.99);
    assert!(1.0 - far.distance < 0.5);
}

#[test]
fn the_invalidation_trigger_follows_a_recipients_change() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    EmbeddingRepository::create(&connection, "account", 2).unwrap();
    let mut stored = message("drift");
    MessageRepository::write_full_state(&connection, &stored).unwrap();
    let seq = message_seq(&connection, "drift");
    EmbeddingRepository::write(
        &connection,
        "account",
        &[MessageEmbedding {
            message_seq: seq,
            chunk_index: 0,
            vector: vec![1.0, 0.0],
        }],
    )
    .unwrap();
    assert_eq!(vector_count(&connection), 1);
    stored.recipients = "someone-else@example.com".into();
    stored.history_id = 2;
    MessageRepository::write_full_state(&connection, &stored).unwrap();
    assert_eq!(vector_count(&connection), 0);
    assert_eq!(
        EmbeddingRepository::count_passages(&connection, "account").unwrap(),
        0
    );
}

#[test]
fn the_invalidation_trigger_follows_an_html_body_change_without_a_truncated_body() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    EmbeddingRepository::create(&connection, "account", 2).unwrap();
    let mut stored = message("html");
    stored.truncated_body = None;
    stored.plain_body = None;
    stored.html_body = Some("<p>first</p>".into());
    MessageRepository::write_full_state(&connection, &stored).unwrap();
    let seq = message_seq(&connection, "html");
    EmbeddingRepository::write(
        &connection,
        "account",
        &[MessageEmbedding {
            message_seq: seq,
            chunk_index: 0,
            vector: vec![1.0, 0.0],
        }],
    )
    .unwrap();
    assert_eq!(vector_count(&connection), 1);
    MessageRepository::set_body(
        &connection,
        "account",
        "html",
        Some("<p>second</p>"),
        None,
        HtmlPresence::Present,
    )
    .unwrap();
    assert_eq!(vector_count(&connection), 0);
    assert_eq!(
        EmbeddingRepository::count_passages(&connection, "account").unwrap(),
        0
    );
}
