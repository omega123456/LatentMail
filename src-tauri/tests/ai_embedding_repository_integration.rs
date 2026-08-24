use latentmail_lib::storage::{
    Account, AccountRepository, EmbeddingRepository, HtmlPresence, Label, LabelRepository, Message,
    MessageEmbedding, MessageRepository, Storage,
};

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
        history_id,
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

#[test]
fn account_vector_tables_accept_different_dimensions() {
    let connection = Storage::in_memory().unwrap();
    for id in ["one", "two"] {
        AccountRepository::upsert(
            &connection,
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
                vector: vec![0.0, 0.0],
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
            vector: vec![0.0, 0.0, 0.0],
        }],
    )
    .unwrap();
    let nearest = EmbeddingRepository::nearest(&connection, "one", &[0.0, 0.0], 2).unwrap();
    assert_ne!(
        EmbeddingRepository::table_name(1),
        EmbeddingRepository::table_name(2)
    );
    assert_eq!(
        nearest
            .iter()
            .map(|(message_seq, _)| *message_seq)
            .collect::<Vec<_>>(),
        vec![1, 1]
    );
    assert!(nearest[0].1 <= nearest[1].1);
    assert_eq!(metadata_count(&connection, "one"), 2);
    assert_eq!(metadata_count(&connection, "two"), 1);
    assert_eq!(
        EmbeddingRepository::counts(&connection, "one").unwrap(),
        latentmail_lib::storage::EmbeddingCounts {
            indexed_messages: 1,
            total_eligible_messages: 1,
            indexed_passages: 2,
        }
    );
    assert_eq!(
        EmbeddingRepository::counts(&connection, "two").unwrap(),
        latentmail_lib::storage::EmbeddingCounts {
            indexed_messages: 1,
            total_eligible_messages: 1,
            indexed_passages: 1,
        }
    );
}

#[test]
fn triggers_remove_vectors_for_text_exclusion_and_message_deletion() {
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
    let entry = MessageEmbedding {
        message_seq: 1,
        chunk_index: 0,
        vector: vec![0.0, 0.0],
    };
    EmbeddingRepository::write(&connection, "one", std::slice::from_ref(&entry)).unwrap();
    let mut changed = message("one", "message", 2);
    changed.subject = "Changed".into();
    MessageRepository::write_full_state(&connection, &changed).unwrap();
    assert_eq!(metadata_count(&connection, "one"), 0);
    EmbeddingRepository::write(&connection, "one", std::slice::from_ref(&entry)).unwrap();
    MessageRepository::set_label_membership(&connection, "one", "message", "TRASH", true).unwrap();
    assert_eq!(metadata_count(&connection, "one"), 0);
    MessageRepository::set_label_membership(&connection, "one", "message", "TRASH", false).unwrap();
    assert_eq!(
        EmbeddingRepository::backlog(&connection, "one", 64)
            .unwrap()
            .len(),
        1
    );
    EmbeddingRepository::write(&connection, "one", &[entry]).unwrap();
    MessageRepository::delete(&connection, "one", "message").unwrap();
    assert_eq!(metadata_count(&connection, "one"), 0);
}

#[test]
fn startup_reconciliation_keeps_backfilled_body_hydration_indexed() {
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
    let mut stored = message("one", "message", 1);
    stored.plain_body = None;
    MessageRepository::write_full_state(&connection, &stored).unwrap();
    EmbeddingRepository::create(&connection, "one", 2).unwrap();
    connection
        .execute_batch("DROP TRIGGER message_vectors_1_update; CREATE TRIGGER message_vectors_1_update BEFORE UPDATE OF subject,sender,to_recipients,cc_recipients,bcc_recipients,plain_body,truncated_body ON messages WHEN old.account_id='one' BEGIN DELETE FROM message_embeddings WHERE account_id=old.account_id AND message_seq=old.seq; END;")
        .unwrap();
    EmbeddingRepository::create(&connection, "one", 2).unwrap();
    EmbeddingRepository::write(
        &connection,
        "one",
        &[MessageEmbedding {
            message_seq: 1,
            chunk_index: 0,
            vector: vec![0.0, 0.0],
        }],
    )
    .unwrap();
    MessageRepository::set_body(
        &connection,
        "one",
        "message",
        None,
        Some("hydrated body"),
        HtmlPresence::Absent,
    )
    .unwrap();
    assert_eq!(metadata_count(&connection, "one"), 1);
    assert!(EmbeddingRepository::backlog(&connection, "one", 64)
        .unwrap()
        .is_empty());
    assert_eq!(
        EmbeddingRepository::nearest(&connection, "one", &[0.0, 0.0], 1)
            .unwrap()
            .len(),
        1
    );
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
    let mut mutable = message("one", "plain", 1);
    mutable.truncated_body = None;
    MessageRepository::write_full_state(&connection, &mutable).unwrap();
    let mutable_seq = connection
        .query_row(
            "SELECT seq FROM messages WHERE account_id='one' AND id='plain'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    EmbeddingRepository::write(
        &connection,
        "one",
        &[MessageEmbedding {
            message_seq: mutable_seq,
            chunk_index: 0,
            vector: vec![0.0, 0.0],
        }],
    )
    .unwrap();
    MessageRepository::set_body(
        &connection,
        "one",
        "plain",
        None,
        Some("changed body"),
        HtmlPresence::Absent,
    )
    .unwrap();
    assert_eq!(metadata_count(&connection, "one"), 0);
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
            vector: vec![0.0, 0.0],
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
        EmbeddingRepository::nearest(&connection, "one", &[0.0, 0.0], 1)
            .unwrap()
            .len(),
        1
    );
}
