use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, Label, LabelRepository, Message, MessageRepository,
    RetrievalFilters, RetrievalRepository, Storage,
};

fn account(id: &str) -> Account {
    Account {
        id: id.into(),
        email: format!("{id}@example.com"),
        display_name: "Me".into(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

fn label(account_id: &str, id: &str, name: &str) -> Label {
    Label {
        account_id: account_id.into(),
        id: id.into(),
        name: name.into(),
        kind: "system".into(),
        color: None,
        message_count: 0,
    }
}

fn message(account_id: &str, id: &str, body: &str, sent_at: i64) -> Message {
    Message {
        account_id: account_id.into(),
        id: id.into(),
        thread_id: format!("thread-{id}"),
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: "recipient@example.com".into(),
        subject: "Subject".into(),
        sent_at,
        snippet: "Snippet".into(),
        html_body: None,
        plain_body: Some(body.into()),
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: None,
        html_presence: HtmlPresence::Absent,
    }
}

fn seq(connection: &rusqlite::Connection, account_id: &str, id: &str) -> i64 {
    connection
        .query_row(
            "SELECT seq FROM messages WHERE account_id=?1 AND id=?2",
            [account_id, id],
            |row| row.get(0),
        )
        .unwrap()
}

fn write(connection: &rusqlite::Connection, stored: &Message) -> i64 {
    MessageRepository::write_full_state(connection, stored).unwrap();
    seq(connection, &stored.account_id, &stored.id)
}

fn filtered_fixture() -> (rusqlite::Connection, i64, i64) {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    LabelRepository::upsert(&connection, &label("account", "INBOX", "Inbox")).unwrap();
    LabelRepository::upsert(&connection, &label("account", "SENT", "Sent")).unwrap();

    let mut early = message("account", "early", "quarterly ssd report", 1_000);
    early.sender = "Alice Adams <alice@example.com>".into();
    early.recipients = "me@example.com".into();
    early.has_attachments = true;
    early.is_unread = false;
    early.is_starred = true;
    let early_seq = write(&connection, &early);

    let mut late = message("account", "late", "quarterly ssd report", 2_000);
    late.sender = "Bob Brown <bob@example.com>".into();
    late.recipients = "team@example.com".into();
    late.has_attachments = false;
    late.is_unread = true;
    late.is_starred = false;
    let late_seq = write(&connection, &late);

    MessageRepository::set_label_membership(&connection, "account", "early", "INBOX", true)
        .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "late", "SENT", true).unwrap();

    (connection, early_seq, late_seq)
}

fn relevance(
    connection: &rusqlite::Connection,
    question: &str,
    filters: &RetrievalFilters,
) -> Vec<i64> {
    RetrievalRepository::lexical_relevance(connection, "account", question, 50, filters).unwrap()
}

fn chronological(
    connection: &rusqlite::Connection,
    question: &str,
    filters: &RetrievalFilters,
) -> Vec<i64> {
    RetrievalRepository::lexical_chronological(connection, "account", question, 50, filters)
        .unwrap()
}

#[test]
fn a_question_carrying_punctuation_and_quotes_produces_a_valid_expression_and_returns_matches() {
    let (connection, early_seq, late_seq) = filtered_fixture();
    let question = "How is my \"ssd\" health? It's Alice's report.";

    let expression = RetrievalRepository::match_expression(question);
    let mut matched = relevance(&connection, question, &RetrievalFilters::default());
    matched.sort_unstable();

    assert_eq!(
        expression,
        Some("\"ssd\" OR \"health\" OR \"alice\" OR \"report\"".into())
    );
    assert_eq!(matched, vec![early_seq, late_seq]);
}

#[test]
fn the_builder_drops_stop_words_and_single_character_tokens_and_joins_survivors_with_or() {
    assert_eq!(
        RetrievalRepository::match_expression("What is a ssd health report?"),
        Some("\"ssd\" OR \"health\" OR \"report\"".into())
    );
}

#[test]
fn a_nine_word_question_matches_a_message_carrying_only_one_of_its_terms() {
    let (connection, early_seq, late_seq) = filtered_fixture();
    let question = "when did the drive controller firmware ssd warranty expire";

    let mut matched = relevance(&connection, question, &RetrievalFilters::default());
    matched.sort_unstable();

    assert_eq!(matched, vec![early_seq, late_seq]);
}

#[test]
fn a_question_reducing_to_no_usable_tokens_returns_no_expression_and_no_rows() {
    let (connection, _, _) = filtered_fixture();
    let question = "What is it? A or the?";

    assert_eq!(RetrievalRepository::match_expression(question), None);
    assert!(relevance(&connection, question, &RetrievalFilters::default()).is_empty());
    assert!(chronological(&connection, question, &RetrievalFilters::default()).is_empty());
}

#[test]
fn the_relevance_path_ranks_a_rare_term_above_messages_matching_only_common_terms() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    for index in 0..12 {
        write(
            &connection,
            &message(
                "account",
                &format!("common-{index}"),
                "quarterly report",
                1_000 + index,
            ),
        );
    }
    let rare_seq = write(
        &connection,
        &message("account", "rare", "ssd diagnostics", 5_000),
    );

    let ranked = relevance(
        &connection,
        "ssd quarterly report",
        &RetrievalFilters::default(),
    );

    assert_eq!(ranked.len(), 13);
    assert_eq!(ranked.first().copied(), Some(rare_seq));
}

#[test]
fn the_relevance_path_is_scoped_to_one_account() {
    let (connection, early_seq, late_seq) = filtered_fixture();
    AccountRepository::upsert(&connection, &account("other")).unwrap();
    let other_seq = write(
        &connection,
        &message("other", "other", "quarterly ssd report", 1_500),
    );

    let mut matched = relevance(&connection, "ssd report", &RetrievalFilters::default());
    matched.sort_unstable();

    assert_eq!(matched, vec![early_seq, late_seq]);
    assert_eq!(
        RetrievalRepository::lexical_relevance(
            &connection,
            "other",
            "ssd report",
            50,
            &RetrievalFilters::default()
        )
        .unwrap(),
        vec![other_seq]
    );
}

#[test]
fn the_chronological_path_returns_the_oldest_matches_as_the_corpus_grows_past_any_window() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    let oldest_seq = write(
        &connection,
        &message("account", "oldest", "ssd diagnostics", 10),
    );
    let second_seq = write(
        &connection,
        &message("account", "second", "ssd diagnostics", 20),
    );

    let before = RetrievalRepository::lexical_chronological(
        &connection,
        "account",
        "ssd diagnostics",
        2,
        &RetrievalFilters::default(),
    )
    .unwrap();
    assert_eq!(before, vec![oldest_seq, second_seq]);

    for index in 0..200 {
        write(
            &connection,
            &message(
                "account",
                &format!("later-{index}"),
                "ssd diagnostics",
                1_000 + index,
            ),
        );
    }

    let after = RetrievalRepository::lexical_chronological(
        &connection,
        "account",
        "ssd diagnostics",
        2,
        &RetrievalFilters::default(),
    )
    .unwrap();

    assert_eq!(after, before);
}

#[test]
fn an_empty_filter_set_leaves_both_paths_unrestricted() {
    let (connection, early_seq, late_seq) = filtered_fixture();
    let filters = RetrievalFilters::default();

    let mut ranked = relevance(&connection, "ssd report", &filters);
    ranked.sort_unstable();

    assert!(filters.is_empty());
    assert_eq!(ranked, vec![early_seq, late_seq]);
    assert_eq!(
        chronological(&connection, "ssd report", &filters),
        vec![early_seq, late_seq]
    );
}

#[test]
fn every_filter_field_restricts_both_lexical_paths() {
    let (connection, early_seq, late_seq) = filtered_fixture();
    let cases = [
        (
            RetrievalFilters {
                date_from: Some(1_500),
                ..RetrievalFilters::default()
            },
            late_seq,
        ),
        (
            RetrievalFilters {
                date_to: Some(1_500),
                ..RetrievalFilters::default()
            },
            early_seq,
        ),
        (
            RetrievalFilters {
                sender: Some("alice@example.com".into()),
                ..RetrievalFilters::default()
            },
            early_seq,
        ),
        (
            RetrievalFilters {
                recipient: Some("team@example.com".into()),
                ..RetrievalFilters::default()
            },
            late_seq,
        ),
        (
            RetrievalFilters {
                folder: Some("Inbox".into()),
                ..RetrievalFilters::default()
            },
            early_seq,
        ),
        (
            RetrievalFilters {
                has_attachment: Some(true),
                ..RetrievalFilters::default()
            },
            early_seq,
        ),
        (
            RetrievalFilters {
                is_read: Some(true),
                ..RetrievalFilters::default()
            },
            early_seq,
        ),
        (
            RetrievalFilters {
                is_starred: Some(true),
                ..RetrievalFilters::default()
            },
            early_seq,
        ),
    ];

    for (filters, expected) in cases {
        assert_eq!(
            relevance(&connection, "ssd report", &filters),
            vec![expected],
            "relevance path ignored {filters:?}"
        );
        assert_eq!(
            chronological(&connection, "ssd report", &filters),
            vec![expected],
            "chronological path ignored {filters:?}"
        );
    }
}

#[test]
fn the_folder_filter_resolves_through_the_label_join_and_is_read_binds_inverted() {
    let (connection, early_seq, late_seq) = filtered_fixture();

    let sent = RetrievalFilters {
        folder: Some("Sent".into()),
        ..RetrievalFilters::default()
    };
    let unknown_folder = RetrievalFilters {
        folder: Some("SENT".into()),
        ..RetrievalFilters::default()
    };
    let unread = RetrievalFilters {
        is_read: Some(false),
        ..RetrievalFilters::default()
    };

    assert_eq!(relevance(&connection, "ssd report", &sent), vec![late_seq]);
    assert!(relevance(&connection, "ssd report", &unknown_folder).is_empty());
    assert_eq!(
        relevance(&connection, "ssd report", &unread),
        vec![late_seq]
    );
    assert_eq!(
        chronological(&connection, "ssd report", &unread),
        vec![late_seq]
    );
    assert_ne!(late_seq, early_seq);
}
