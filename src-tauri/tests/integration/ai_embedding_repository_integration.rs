use latentmail_lib::storage::{
    Account, AccountRepository, EmbeddingRepository, HtmlPresence, Label, LabelRepository, Message,
    MessageEmbedding, MessageRepository, Storage,
};
use latentmail_lib::storage::{LabelMembershipChange, MessageBodyUpdate, MessageKey, NearestQuery};

fn message(account_id: &str, id: &str, history_id: i64) -> Message {
    Message {
        account_id: account_id.into(),
        id: id.into(),
        thread_id: format!("thread-{id}"),
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: "recipient@example.com".into(),
        subject: "Subject".into(),
        sent_at: 1,
        snippet: "Snippet".into(),
        html_body: None,
        plain_body: Some("Body".into()),
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: history_id,
        truncated_body: Some("Immutable body".into()),
        html_presence: HtmlPresence::Absent,
    }
}

fn metadata_count(connection: &rusqlite::Connection, account_id: &str) -> i64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM message_embeddings WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .unwrap()
}

fn upsert_account(connection: &rusqlite::Connection, id: &str) {
    AccountRepository::upsert(
        connection,
        &Account {
            id: id.into(),
            email: format!("{id}@example.com"),
            display_name: id.into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
}

fn assert_counts(connection: &rusqlite::Connection, account_id: &str, indexed_passages: i64) {
    assert_eq!(
        EmbeddingRepository::counts(connection, account_id).unwrap(),
        latentmail_lib::storage::EmbeddingCounts {
            indexed_messages: 1,
            total_eligible_messages: 1,
            indexed_passages: indexed_passages,
        }
    );
}

fn set_trash(connection: &rusqlite::Connection, message_id: &str, present: bool) {
    MessageRepository::set_label_membership(
        connection,
        MessageKey {
            account_id: "one",
            message_id: message_id,
        },
        LabelMembershipChange {
            label_id: "TRASH",
            present: present,
        },
    )
    .unwrap();
}

fn set_plain_body(connection: &rusqlite::Connection, message_id: &str, plain_body: &str) {
    MessageRepository::set_body(
        connection,
        MessageKey {
            account_id: "one",
            message_id: message_id,
        },
        MessageBodyUpdate {
            html_body: None,
            plain_body: Some(plain_body),
            presence: HtmlPresence::Absent,
        },
    )
    .unwrap();
}

fn write_unit_vector(connection: &rusqlite::Connection, message_seq: i64) {
    EmbeddingRepository::write(
        connection,
        "one",
        &[MessageEmbedding {
            message_seq: message_seq,
            chunk_index: 0,
            vector: vec![1.0, 0.0],
        }],
    )
    .unwrap();
}

fn nearest_count(connection: &rusqlite::Connection) -> usize {
    EmbeddingRepository::nearest(
        connection,
        "one",
        NearestQuery {
            vector: &[1.0, 0.0],
            limit: 1,
        },
    )
    .unwrap()
    .len()
}

fn assert_mutable_body_update_invalidates_embedding(connection: &rusqlite::Connection) {
    let mut mutable = message("one", "plain", 1);
    mutable.truncated_body = None;
    MessageRepository::write_full_state(connection, &mutable).unwrap();
    let mutable_seq = connection
        .query_row(
            "SELECT seq FROM messages WHERE account_id='one' AND id='plain'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    write_unit_vector(connection, mutable_seq);
    set_plain_body(connection, "plain", "changed body");
    assert_eq!(metadata_count(connection, "one"), 0);
}

#[test]
fn account_vector_tables_accept_different_dimensions() {
    let connection = Storage::in_memory().unwrap();
    upsert_account(&connection, "one");
    upsert_account(&connection, "two");
    EmbeddingRepository::create(&connection, "one", 2).unwrap();
    EmbeddingRepository::create(&connection, "two", 3).unwrap();
    MessageRepository::write_full_state(&connection, &message("one", "message", 1)).unwrap();
    MessageRepository::write_full_state(&connection, &message("two", "message", 1)).unwrap();
    EmbeddingRepository::write(
        &connection,
        "one",
        &[
            MessageEmbedding {
                message_seq: 1,
                chunk_index: 0,
                vector: vec![1.0, 0.0],
            },
            MessageEmbedding {
                message_seq: 1,
                chunk_index: 1,
                vector: vec![2.0, 2.0],
            },
        ],
    )
    .unwrap();
    EmbeddingRepository::write(
        &connection,
        "two",
        &[MessageEmbedding {
            message_seq: 2,
            chunk_index: 0,
            vector: vec![1.0, 0.0, 0.0],
        }],
    )
    .unwrap();
    let nearest = EmbeddingRepository::nearest(
        &connection,
        "one",
        NearestQuery {
            vector: &[1.0, 0.0],
            limit: 2,
        },
    )
    .unwrap();
    assert_ne!(
        EmbeddingRepository::table_name(1),
        EmbeddingRepository::table_name(2)
    );
    assert_eq!(
        nearest
            .iter()
            .map(|passage| passage.message_seq)
            .collect::<Vec<_>>(),
        vec![1, 1]
    );
    assert!(nearest[0].distance <= nearest[1].distance);
    assert_eq!(metadata_count(&connection, "one"), 2);
    assert_eq!(metadata_count(&connection, "two"), 1);
    assert_counts(&connection, "one", 2);
    assert_counts(&connection, "two", 1);
}

#[test]
fn triggers_remove_vectors_for_text_exclusion_and_message_deletion() {
    let connection = Storage::in_memory().unwrap();
    upsert_account(&connection, "one");
    LabelRepository::upsert(
        &connection,
        &Label {
            account_id: "one".into(),
            id: "TRASH".into(),
            name: "Trash".into(),
            kind: "system".into(),
            color: None,
            message_count: 0,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(&connection, &message("one", "message", 1)).unwrap();
    EmbeddingRepository::create(&connection, "one", 2).unwrap();
    write_unit_vector(&connection, 1);
    let mut changed = message("one", "message", 2);
    changed.subject = "Changed".into();
    MessageRepository::write_full_state(&connection, &changed).unwrap();
    assert_eq!(metadata_count(&connection, "one"), 0);
    write_unit_vector(&connection, 1);
    set_trash(&connection, "message", true);
    assert_eq!(metadata_count(&connection, "one"), 0);
    set_trash(&connection, "message", false);
    assert_eq!(
        EmbeddingRepository::backlog(&connection, "one", 64)
            .unwrap()
            .len(),
        1
    );
    write_unit_vector(&connection, 1);
    MessageRepository::delete(&connection, "one", "message").unwrap();
    assert_eq!(metadata_count(&connection, "one"), 0);
}

#[test]
fn startup_reconciliation_keeps_backfilled_body_hydration_indexed() {
    let connection = Storage::in_memory().unwrap();
    upsert_account(&connection, "one");
    let mut stored = message("one", "message", 1);
    stored.plain_body = None;
    MessageRepository::write_full_state(&connection, &stored).unwrap();
    EmbeddingRepository::create(&connection, "one", 2).unwrap();
    connection
        .execute_batch("DROP TRIGGER message_vectors_1_update; CREATE TRIGGER message_vectors_1_update BEFORE UPDATE OF subject,sender,to_recipients,cc_recipients,bcc_recipients,plain_body,truncated_body ON messages WHEN old.account_id='one' BEGIN DELETE FROM message_embeddings WHERE account_id=old.account_id AND message_seq=old.seq; END;")
        .unwrap();
    EmbeddingRepository::create(&connection, "one", 2).unwrap();
    write_unit_vector(&connection, 1);
    set_plain_body(&connection, "message", "hydrated body");
    assert_eq!(metadata_count(&connection, "one"), 1);
    assert!(EmbeddingRepository::backlog(&connection, "one", 64)
        .unwrap()
        .is_empty());
    assert_eq!(nearest_count(&connection), 1);
    stored.subject = "Changed".into();
    stored.history_id = 2;
    MessageRepository::write_full_state(&connection, &stored).unwrap();
    assert_eq!(metadata_count(&connection, "one"), 0);
    assert_eq!(
        EmbeddingRepository::backlog(&connection, "one", 64)
            .unwrap()
            .len(),
        1
    );
    assert_mutable_body_update_invalidates_embedding(&connection);
}

#[test]
fn rolled_back_model_lifecycle_keeps_the_prior_vector_objects_consistent() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "one".into(),
            email: "one@example.com".into(),
            display_name: "one".into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(&connection, &message("one", "message", 1)).unwrap();
    EmbeddingRepository::create(&connection, "one", 2).unwrap();
    EmbeddingRepository::write(
        &connection,
        "one",
        &[MessageEmbedding {
            message_seq: 1,
            chunk_index: 0,
            vector: vec![1.0, 0.0],
        }],
    )
    .unwrap();
    {
        let transaction = connection.unchecked_transaction().unwrap();
        EmbeddingRepository::drop(&transaction, "one").unwrap();
        EmbeddingRepository::create(&transaction, "one", 3).unwrap();
    }
    assert_eq!(metadata_count(&connection, "one"), 1);
    assert_eq!(
        EmbeddingRepository::nearest(
            &connection,
            "one",
            NearestQuery {
                vector: &[1.0, 0.0],
                limit: 1
            }
        )
        .unwrap()
        .len(),
        1
    );
}
