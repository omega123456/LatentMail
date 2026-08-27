use chrono::{Local, NaiveDate, TimeZone};
use latentmail_lib::{
    ai::{
        prompts,
        retrieval::{parse_variants, Passage},
    },
    storage::{
        Account, AccountRepository, EmbeddingRepository, HtmlPresence, Label, LabelRepository,
        Message, MessageEmbedding, MessageRepository, RetrievalFilters, RetrievalRepository,
        Storage,
    },
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

fn day_end(day: &str) -> i64 {
    Local
        .from_local_datetime(
            &NaiveDate::parse_from_str(day, "%Y-%m-%d")
                .unwrap()
                .and_hms_opt(23, 59, 59)
                .unwrap(),
        )
        .latest()
        .unwrap()
        .timestamp()
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

#[test]
fn the_rewriter_response_maps_onto_every_structured_filter() {
    let variants = parse_variants(
        r#"[{"query":"budget","dateFrom":"2026-03-01","dateTo":"2026-03-05","sender":"alice@example.com","recipient":"me@example.com","folder":"Inbox","hasAttachment":true,"isRead":"false","isStarred":true,"dateOrder":"asc"}]"#,
        "raw question",
    );
    assert_eq!(variants.len(), 5);
    assert_eq!(variants[0].query, "budget");
    assert!(variants[0].ascending);
    assert_eq!(
        variants[0].filters,
        RetrievalFilters {
            date_from: Some(day_start("2026-03-01")),
            date_to: Some(day_end("2026-03-05")),
            sender: Some("alice@example.com".into()),
            recipient: Some("me@example.com".into()),
            folder: Some("Inbox".into()),
            has_attachment: Some(true),
            is_read: Some(false),
            is_starred: Some(true),
        }
    );
    assert_eq!(variants[4].query, "raw question");
    assert!(variants[4].filters.is_empty());
    assert!(!variants[4].ascending);
}

#[test]
fn an_unusable_rewriter_response_falls_back_to_the_raw_question() {
    for raw in ["not json", "\"a string\"", "{\"reason\":\"no array here\"}"] {
        let variants = parse_variants(raw, "raw question");
        assert_eq!(variants.len(), 5);
        assert!(variants
            .iter()
            .all(|variant| variant.query == "raw question" && variant.filters.is_empty()));
    }
    let wrapped = parse_variants(r#"{"queries":[{"query":"wrapped","folder":"  "}]}"#, "raw");
    assert_eq!(wrapped[0].query, "wrapped");
    assert!(wrapped[0].filters.is_empty());
    let overflow = parse_variants(
        r#"[{"query":"a"},{"query":"b"},{"query":"c"},{"query":"d"},{"query":"e"},{"query":"f"}]"#,
        "raw",
    );
    assert_eq!(
        overflow
            .iter()
            .map(|variant| variant.query.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b", "c", "d", "e"]
    );
    let malformed = parse_variants(
        r#"[{"query":"kept","hasAttachment":"maybe","dateFrom":"not-a-date"},7]"#,
        "raw",
    );
    assert_eq!(malformed[0].query, "kept");
    assert!(malformed[0].filters.is_empty());
}

#[test]
fn the_prompts_carry_their_placeholders_and_the_numbered_passage_block() {
    let now = Local
        .from_local_datetime(
            &NaiveDate::from_ymd_opt(2026, 8, 26)
                .unwrap()
                .and_hms_opt(14, 30, 0)
                .unwrap(),
        )
        .earliest()
        .unwrap();
    let system = prompts::system(now, "me@example.com");
    assert!(system.contains("Wednesday, August 26, 2026, 2:30 PM"));
    assert!(system.contains("me@example.com"));
    assert!(!system.contains("{{"));
    let rewrite = prompts::rewrite(now, "me@example.com", &["Inbox".into(), "Sent".into()]);
    assert!(rewrite.contains("Today's date: 2026-08-26"));
    assert!(rewrite.contains("Available folders: Inbox, Sent"));
    assert!(rewrite.contains("Required baseline filters"));
    assert!(!rewrite.contains("{{"));
    assert!(prompts::relevance().contains("{\"relevant\": true}"));
    let block = prompts::passage_block(&[
        Passage {
            message_seq: 1,
            chunk_index: 0,
            similarity: 0.9,
            sent_at: seconds("2026-08-26", 14),
            sender: "Alice <alice@example.com>".into(),
            recipients: "me@example.com".into(),
            subject: "Budget".into(),
            text: "first passage".into(),
        },
        Passage {
            message_seq: 2,
            chunk_index: 1,
            similarity: 0.8,
            sent_at: seconds("2026-08-26", 15),
            sender: "Bob <bob@example.com>".into(),
            recipients: "me@example.com".into(),
            subject: "Venue".into(),
            text: "second passage".into(),
        },
    ]);
    assert!(block.starts_with("[1] From: Alice <alice@example.com>\nTo: me@example.com\nSubject: Budget\nDate: Wednesday, August 26, 2026, 2:00 PM\nfirst passage"));
    assert!(block.contains("\n\n---\n\n[2] From: Bob <bob@example.com>"));
    assert!(block.ends_with("second passage"));
    assert!(prompts::passage_block(&[]).is_empty());
}
