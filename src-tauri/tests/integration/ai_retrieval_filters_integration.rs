use chrono::{Local, NaiveDate, TimeZone};
use latentmail_lib::storage::{
    Account, AccountRepository, EmbeddingRepository, HtmlPresence, Label, LabelRepository, Message,
    MessageEmbedding, MessageRepository, RetrievalFilters, RetrievalRepository, Storage,
};

fn seconds(day: &str, hour: u32) -> i64 {
    Local
        .from_local_datetime(
            &NaiveDate::parse_from_str(day, "%Y-%m-%d")
                .unwrap()
                .and_hms_opt(hour, 0, 0)
                .unwrap(),
        )
        .earliest()
        .unwrap()
        .timestamp()
}

fn day_start(day: &str) -> i64 {
    seconds(day, 0)
}

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

fn label(id: &str, name: &str) -> Label {
    Label {
        account_id: "account".into(),
        id: id.into(),
        name: name.into(),
        kind: "system".into(),
        color: None,
        message_count: 0,
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
        sent_at: 1,
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

fn seq(connection: &rusqlite::Connection, id: &str) -> i64 {
    connection
        .query_row(
            "SELECT seq FROM messages WHERE account_id='account' AND id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
}

fn fixture() -> (rusqlite::Connection, i64, i64) {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    LabelRepository::upsert(&connection, &label("INBOX", "Inbox")).unwrap();
    LabelRepository::upsert(&connection, &label("SENT", "Sent")).unwrap();
    EmbeddingRepository::create(&connection, "account", 2).unwrap();

    let mut early = message("early");
    early.sender = "Alice Adams <alice@example.com>".into();
    early.recipients = "me@example.com".into();
    early.sent_at = seconds("2026-03-01", 12);
    early.has_attachments = true;
    early.is_unread = false;
    early.is_starred = true;
    MessageRepository::write_full_state(&connection, &early).unwrap();

    let mut late = message("late");
    late.sender = "Bob Brown <bob@example.com>".into();
    late.recipients = "team@example.com".into();
    late.sent_at = seconds("2026-03-05", 12);
    late.has_attachments = false;
    late.is_unread = true;
    late.is_starred = false;
    MessageRepository::write_full_state(&connection, &late).unwrap();

    let early_seq = seq(&connection, "early");
    let late_seq = seq(&connection, "late");
    MessageRepository::set_label_membership(&connection, "account", "early", "INBOX", true)
        .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "late", "SENT", true).unwrap();
    EmbeddingRepository::write(
        &connection,
        "account",
        &[
            MessageEmbedding {
                message_seq: early_seq,
                chunk_index: 0,
                vector: vec![1.0, 0.0],
            },
            MessageEmbedding {
                message_seq: late_seq,
                chunk_index: 0,
                vector: vec![1.0, 0.0],
            },
        ],
    )
    .unwrap();
    (connection, early_seq, late_seq)
}

fn matched(connection: &rusqlite::Connection, filters: &RetrievalFilters) -> Vec<i64> {
    let mut sequences: Vec<i64> =
        RetrievalRepository::candidates(connection, "account", &[1.0, 0.0], 100, filters)
            .unwrap()
            .into_iter()
            .map(|candidate| candidate.message_seq)
            .collect();
    sequences.sort_unstable();
    sequences
}

#[test]
fn an_empty_filter_set_keeps_every_candidate() {
    let (connection, early, late) = fixture();
    assert_eq!(
        matched(&connection, &RetrievalFilters::default()),
        vec![early, late]
    );
    assert!(RetrievalFilters::default().is_empty());
}

#[test]
fn every_structured_filter_narrows_the_candidate_set() {
    let (connection, early, late) = fixture();
    assert_eq!(
        matched(
            &connection,
            &RetrievalFilters {
                date_from: Some(day_start("2026-03-03")),
                ..RetrievalFilters::default()
            }
        ),
        vec![late]
    );
    assert_eq!(
        matched(
            &connection,
            &RetrievalFilters {
                date_to: Some(day_start("2026-03-03")),
                ..RetrievalFilters::default()
            }
        ),
        vec![early]
    );
    assert_eq!(
        matched(
            &connection,
            &RetrievalFilters {
                sender: Some("alice@example.com".into()),
                ..RetrievalFilters::default()
            }
        ),
        vec![early]
    );
    assert_eq!(
        matched(
            &connection,
            &RetrievalFilters {
                recipient: Some("team@example.com".into()),
                ..RetrievalFilters::default()
            }
        ),
        vec![late]
    );
    assert_eq!(
        matched(
            &connection,
            &RetrievalFilters {
                folder: Some("Inbox".into()),
                ..RetrievalFilters::default()
            }
        ),
        vec![early]
    );
    assert_eq!(
        matched(
            &connection,
            &RetrievalFilters {
                folder: Some("Sent".into()),
                ..RetrievalFilters::default()
            }
        ),
        vec![late]
    );
    assert_eq!(
        matched(
            &connection,
            &RetrievalFilters {
                has_attachment: Some(true),
                ..RetrievalFilters::default()
            }
        ),
        vec![early]
    );
    assert_eq!(
        matched(
            &connection,
            &RetrievalFilters {
                has_attachment: Some(false),
                ..RetrievalFilters::default()
            }
        ),
        vec![late]
    );
    assert_eq!(
        matched(
            &connection,
            &RetrievalFilters {
                is_read: Some(true),
                ..RetrievalFilters::default()
            }
        ),
        vec![early]
    );
    assert_eq!(
        matched(
            &connection,
            &RetrievalFilters {
                is_read: Some(false),
                ..RetrievalFilters::default()
            }
        ),
        vec![late]
    );
    assert_eq!(
        matched(
            &connection,
            &RetrievalFilters {
                is_starred: Some(true),
                ..RetrievalFilters::default()
            }
        ),
        vec![early]
    );
    assert_eq!(
        matched(
            &connection,
            &RetrievalFilters {
                is_starred: Some(false),
                ..RetrievalFilters::default()
            }
        ),
        vec![late]
    );
}

#[test]
fn source_metadata_and_folder_names_resolve_for_the_account() {
    let (connection, early, late) = fixture();
    let sources =
        RetrievalRepository::sources(&connection, "account", &[late, early, 9_999]).unwrap();
    assert_eq!(sources.len(), 2);
    let found = |message_seq: i64| {
        sources
            .iter()
            .find(|source| source.message_seq == message_seq)
            .unwrap()
    };
    assert_eq!(found(late).message_id, "late");
    assert_eq!(found(late).thread_id, "thread-late");
    assert_eq!(found(late).sender, "Bob Brown <bob@example.com>");
    assert_eq!(found(late).subject, "Subject");
    assert_eq!(found(late).sent_at, seconds("2026-03-05", 12));
    assert_eq!(found(early).message_id, "early");
    assert_eq!(
        RetrievalRepository::folder_names(&connection, "account").unwrap(),
        vec!["Inbox".to_owned(), "Sent".to_owned()]
    );
}
