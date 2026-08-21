use std::collections::HashSet;

use chrono::{TimeZone, Utc};
use latentmail_lib::{
    search::{
        query::parse,
        scope::{resolve, SearchScope},
    },
    storage::{
        Account, AccountRepository, HtmlPresence, LabelRepository, Message, MessageRepository,
        SearchRepository, Storage, ThreadRepository,
    },
};

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap()
}

fn account() -> Account {
    Account {
        id: "account".into(),
        email: "mail@example.com".into(),
        display_name: "Mail".into(),
        avatar_url: None,
        history_id: Some(4),
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

fn seed_labels(connection: &rusqlite::Connection) {
    for label_id in ["INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "Label_1"] {
        LabelRepository::ensure_placeholder(connection, "account", label_id).unwrap();
    }
}

#[allow(clippy::too_many_arguments)]
fn insert_message(
    connection: &rusqlite::Connection,
    id: &str,
    thread_id: &str,
    sender: &str,
    subject: &str,
    body: &str,
    sent_at: i64,
    is_unread: bool,
    has_attachments: bool,
    labels: &[&str],
) {
    let message = Message {
        account_id: "account".into(),
        id: id.into(),
        thread_id: thread_id.into(),
        rfc_message_id: None,
        sender: sender.into(),
        recipients: String::new(),
        subject: subject.into(),
        sent_at,
        snippet: String::new(),
        html_body: None,
        plain_body: Some(body.into()),
        has_attachments,
        is_unread,
        is_starred: false,
        history_id: sent_at,
        truncated_body: None,
        html_presence: HtmlPresence::Absent,
    };
    MessageRepository::write_full_state(connection, &message).unwrap();
    for label in labels {
        MessageRepository::set_label_membership(connection, "account", id, label, true).unwrap();
    }
    ThreadRepository::recompute(connection, "account", thread_id).unwrap();
}

fn setup() -> rusqlite::Connection {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    seed_labels(&connection);
    connection
}

fn thread_ids(rows: &[latentmail_lib::storage::ThreadListRow]) -> Vec<String> {
    rows.iter().map(|row| row.thread.id.clone()).collect()
}

#[test]
fn a_bare_term_present_only_in_the_body_is_found() {
    let connection = setup();
    insert_message(
        &connection,
        "m1",
        "thread-1",
        "team@example.com",
        "Weekly update",
        "the migration used a zyxwvutriage rollback plan",
        10,
        false,
        false,
        &["INBOX"],
    );
    let parsed = parse("zyxwvutriage", now()).unwrap();
    let scope = resolve(&SearchScope::Default);
    let rows = SearchRepository::search(&connection, "account", &parsed, &scope, None, 10).unwrap();
    assert_eq!(thread_ids(&rows), vec!["thread-1"]);
}

#[test]
fn a_search_result_counts_trashed_messages_only_in_the_trash_scope() {
    let connection = setup();
    for (id, sent_at) in [("m1", 10), ("m2", 20)] {
        insert_message(
            &connection,
            id,
            "thread-1",
            "sender@example.com",
            "Quarterly report",
            "body",
            sent_at,
            false,
            false,
            &["INBOX"],
        );
    }
    insert_message(
        &connection,
        "m3",
        "thread-1",
        "sender@example.com",
        "Quarterly report",
        "body",
        30,
        false,
        false,
        &["INBOX", "TRASH"],
    );
    let parsed = parse("quarterly", now()).unwrap();

    let default_scope = resolve(&SearchScope::Default);
    let rows = SearchRepository::search(&connection, "account", &parsed, &default_scope, None, 10)
        .unwrap();
    assert_eq!(rows[0].thread.message_count, 2);

    let trash_scope = resolve(&SearchScope::Label {
        label_id: "TRASH".into(),
    });
    let rows =
        SearchRepository::search(&connection, "account", &parsed, &trash_scope, None, 10).unwrap();
    assert_eq!(rows[0].thread.message_count, 3);
}

#[test]
fn a_diacritic_bearing_term_matches_its_unaccented_form_and_vice_versa() {
    let connection = setup();
    insert_message(
        &connection,
        "m1",
        "thread-1",
        "team@example.com",
        "Café Meeting Notes",
        "let's discuss the roadmap",
        10,
        false,
        false,
        &["INBOX"],
    );
    let scope = resolve(&SearchScope::Default);

    let unaccented = parse("cafe", now()).unwrap();
    let rows =
        SearchRepository::search(&connection, "account", &unaccented, &scope, None, 10).unwrap();
    assert_eq!(thread_ids(&rows), vec!["thread-1"]);

    let accented = parse("café", now()).unwrap();
    let rows =
        SearchRepository::search(&connection, "account", &accented, &scope, None, 10).unwrap();
    assert_eq!(thread_ids(&rows), vec!["thread-1"]);
}

#[test]
fn is_unread_has_attachment_with_no_text_term_uses_the_predicate_only_shape() {
    let connection = setup();
    insert_message(
        &connection,
        "m1",
        "thread-1",
        "team@example.com",
        "Invoice",
        "body",
        10,
        true,
        true,
        &["INBOX"],
    );
    insert_message(
        &connection,
        "m2",
        "thread-2",
        "team@example.com",
        "Read only",
        "body",
        20,
        false,
        true,
        &["INBOX"],
    );
    let parsed = parse("is:unread has:attachment", now()).unwrap();
    assert!(!parsed.has_text_term);
    let scope = resolve(&SearchScope::Default);
    let rows = SearchRepository::search(&connection, "account", &parsed, &scope, None, 10).unwrap();
    assert_eq!(thread_ids(&rows), vec!["thread-1"]);
}

#[test]
fn from_anna_is_unread_requires_a_single_message_satisfying_both() {
    let connection = setup();
    insert_message(
        &connection,
        "m1",
        "thread-split",
        "anna@example.com",
        "Report",
        "body",
        10,
        false,
        false,
        &["INBOX"],
    );
    insert_message(
        &connection,
        "m2",
        "thread-split",
        "bob@example.com",
        "Re: Report",
        "body",
        20,
        true,
        false,
        &["INBOX"],
    );
    insert_message(
        &connection,
        "m3",
        "thread-together",
        "anna@example.com",
        "Report",
        "body",
        30,
        true,
        false,
        &["INBOX"],
    );
    let parsed = parse("from:anna is:unread", now()).unwrap();
    let scope = resolve(&SearchScope::Default);
    let rows = SearchRepository::search(&connection, "account", &parsed, &scope, None, 10).unwrap();
    assert_eq!(thread_ids(&rows), vec!["thread-together"]);
}

#[test]
fn matches_deduplicate_to_threads_order_newest_first_and_paginate_without_loss() {
    let connection = setup();
    for index in 0..5 {
        let thread_id = format!("thread-{index}");
        insert_message(
            &connection,
            &format!("m{index}a"),
            &thread_id,
            "team@example.com",
            "Quarterly summary",
            "quarterly numbers attached",
            10 + index,
            false,
            false,
            &["INBOX"],
        );
        insert_message(
            &connection,
            &format!("m{index}b"),
            &thread_id,
            "team@example.com",
            "Quarterly follow-up",
            "quarterly follow up notes",
            10 + index + 100,
            false,
            false,
            &["INBOX"],
        );
    }
    let parsed = parse("quarterly", now()).unwrap();
    let scope = resolve(&SearchScope::Default);

    let total = SearchRepository::count(&connection, "account", &parsed, &scope).unwrap();
    assert_eq!(total, 5);

    let mut collected = Vec::new();
    let mut cursor = None;
    loop {
        let page =
            SearchRepository::search(&connection, "account", &parsed, &scope, cursor.clone(), 2)
                .unwrap();
        if page.is_empty() {
            break;
        }
        for row in &page {
            collected.push(row.thread.id.clone());
        }
        let last = page.last().unwrap();
        cursor = Some((last.thread.latest_at, last.thread.id.clone()));
        if page.len() < 2 {
            break;
        }
    }

    let unique: HashSet<&String> = collected.iter().collect();
    assert_eq!(unique.len(), 5);
    assert_eq!(collected.len(), 5);

    let indexes: Vec<i64> = collected
        .iter()
        .map(|id| id.trim_start_matches("thread-").parse::<i64>().unwrap())
        .collect();
    let mut previous = i64::MAX;
    for index in indexes {
        assert!(index <= previous, "results must be ordered newest-first");
        previous = index;
    }
}

#[test]
fn default_scope_excludes_trash_and_all_scope_includes_it() {
    let connection = setup();
    insert_message(
        &connection,
        "m1",
        "thread-1",
        "team@example.com",
        "Invoice",
        "invoice attached",
        10,
        false,
        false,
        &["TRASH"],
    );
    let parsed = parse("invoice", now()).unwrap();

    let default_scope = resolve(&SearchScope::Default);
    let default_rows =
        SearchRepository::search(&connection, "account", &parsed, &default_scope, None, 10)
            .unwrap();
    assert!(thread_ids(&default_rows).is_empty());

    let all_scope = resolve(&SearchScope::All);
    let all_rows =
        SearchRepository::search(&connection, "account", &parsed, &all_scope, None, 10).unwrap();
    assert_eq!(thread_ids(&all_rows), vec!["thread-1"]);
}

#[test]
fn label_scope_narrows_results_to_a_single_label() {
    let connection = setup();
    insert_message(
        &connection,
        "m1",
        "thread-1",
        "team@example.com",
        "Invoice",
        "invoice attached",
        10,
        false,
        false,
        &["INBOX", "Label_1"],
    );
    insert_message(
        &connection,
        "m2",
        "thread-2",
        "team@example.com",
        "Invoice copy",
        "invoice attached",
        20,
        false,
        false,
        &["INBOX"],
    );
    let parsed = parse("invoice", now()).unwrap();
    let scope = resolve(&SearchScope::Label {
        label_id: "Label_1".into(),
    });
    let rows = SearchRepository::search(&connection, "account", &parsed, &scope, None, 10).unwrap();
    assert_eq!(thread_ids(&rows), vec!["thread-1"]);
}
