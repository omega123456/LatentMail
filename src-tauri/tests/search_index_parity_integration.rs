use std::collections::HashSet;

use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, Label, LabelRepository, Message, MessageRepository,
    Storage,
};

fn account(id: &str) -> Account {
    Account {
        id: id.into(),
        email: format!("{id}@example.com"),
        display_name: "Mail".into(),
        avatar_url: None,
        history_id: Some(1),
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

fn message(account_id: &str, id: &str, history_id: i64) -> Message {
    Message {
        account_id: account_id.into(),
        id: id.into(),
        thread_id: format!("thread-{id}"),
        rfc_message_id: Some(format!("<{id}>")),
        sender: "sender@example.com".into(),
        recipients: "recipient@example.com".into(),
        subject: format!("Subject {id}"),
        sent_at: 1,
        snippet: "Snippet".into(),
        html_body: None,
        plain_body: Some(format!("Unique plain body token quokka{id}")),
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id,
        truncated_body: None,
        html_presence: HtmlPresence::Absent,
    }
}

fn search_index_rowids(connection: &rusqlite::Connection) -> HashSet<i64> {
    let mut statement = connection.prepare("SELECT rowid FROM message_search").unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<HashSet<i64>>>()
        .unwrap()
}

fn message_seqs(connection: &rusqlite::Connection) -> HashSet<i64> {
    let mut statement = connection.prepare("SELECT seq FROM messages").unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<HashSet<i64>>>()
        .unwrap()
}

fn message_count(connection: &rusqlite::Connection) -> i64 {
    connection
        .query_row("SELECT count(*) FROM messages", [], |row| row.get(0))
        .unwrap()
}

fn search_index_count(connection: &rusqlite::Connection) -> i64 {
    connection
        .query_row("SELECT count(*) FROM message_search", [], |row| row.get(0))
        .unwrap()
}

fn assert_index_matches_messages(connection: &rusqlite::Connection) {
    assert_eq!(
        search_index_rowids(connection),
        message_seqs(connection),
        "message_search rowids must exactly match messages.seq"
    );
    assert_eq!(
        search_index_count(connection),
        message_count(connection),
        "message_search row count must exactly match the messages table"
    );
}

fn matches(connection: &rusqlite::Connection, term: &str) -> HashSet<i64> {
    let mut statement = connection
        .prepare("SELECT rowid FROM message_search WHERE message_search MATCH ?1")
        .unwrap();
    statement
        .query_map([term], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<HashSet<i64>>>()
        .unwrap()
}

#[test]
fn inserting_a_message_adds_exactly_one_search_index_entry() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    assert_index_matches_messages(&connection);

    MessageRepository::write_full_state(&connection, &message("account", "one", 1)).unwrap();
    assert_index_matches_messages(&connection);
    assert_eq!(search_index_count(&connection), 1);
    assert_eq!(matches(&connection, "quokkaone").len(), 1);
}

#[test]
fn deleting_a_message_removes_exactly_one_search_index_entry() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    MessageRepository::write_full_state(&connection, &message("account", "one", 1)).unwrap();
    MessageRepository::write_full_state(&connection, &message("account", "two", 1)).unwrap();
    assert_index_matches_messages(&connection);

    MessageRepository::delete(&connection, "account", "one").unwrap();

    assert_index_matches_messages(&connection);
    assert_eq!(search_index_count(&connection), 1);
    assert!(matches(&connection, "quokkaone").is_empty());
    assert_eq!(matches(&connection, "quokkatwo").len(), 1);
}

#[test]
fn deleting_by_draft_id_removes_its_search_index_entry() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    MessageRepository::write_full_state(&connection, &message("account", "one", 1)).unwrap();
    MessageRepository::set_draft_id(&connection, "account", "one", "draft-1").unwrap();
    assert_index_matches_messages(&connection);

    MessageRepository::delete_by_draft_id(&connection, "account", "draft-1").unwrap();

    assert_index_matches_messages(&connection);
    assert_eq!(search_index_count(&connection), 0);
}

#[test]
fn deleting_an_account_cascades_every_owned_message_out_of_the_search_index() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account-a")).unwrap();
    AccountRepository::upsert(&connection, &account("account-b")).unwrap();
    MessageRepository::write_full_state(&connection, &message("account-a", "one", 1)).unwrap();
    MessageRepository::write_full_state(&connection, &message("account-a", "two", 1)).unwrap();
    MessageRepository::write_full_state(&connection, &message("account-b", "three", 1)).unwrap();
    assert_index_matches_messages(&connection);
    assert_eq!(search_index_count(&connection), 3);

    connection
        .execute("DELETE FROM accounts WHERE id=?1", ["account-a"])
        .unwrap();

    assert_index_matches_messages(&connection);
    assert_eq!(search_index_count(&connection), 1);
    assert!(matches(&connection, "quokkaone").is_empty());
    assert!(matches(&connection, "quokkatwo").is_empty());
    assert_eq!(matches(&connection, "quokkathree").len(), 1);
}

#[test]
fn updating_a_text_bearing_column_re_indexes_the_message() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    MessageRepository::write_full_state(&connection, &message("account", "one", 1)).unwrap();
    assert_eq!(matches(&connection, "quokkaone").len(), 1);

    let mut updated = message("account", "one", 2);
    updated.plain_body = Some("Unique plain body token quokkarewrite".into());
    MessageRepository::write_full_state(&connection, &updated).unwrap();

    assert_index_matches_messages(&connection);
    assert_eq!(search_index_count(&connection), 1);
    assert!(matches(&connection, "quokkaone").is_empty());
    assert_eq!(matches(&connection, "quokkarewrite").len(), 1);
}

#[test]
fn setting_the_body_re_indexes_the_message() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    MessageRepository::write_full_state(&connection, &message("account", "one", 1)).unwrap();

    MessageRepository::set_body(
        &connection,
        "account",
        "one",
        None,
        Some("Unique plain body token quokkasetbody"),
        HtmlPresence::Absent,
    )
    .unwrap();

    assert_index_matches_messages(&connection);
    assert_eq!(matches(&connection, "quokkasetbody").len(), 1);
    assert!(matches(&connection, "quokkaone").is_empty());
}

#[test]
fn setting_the_truncated_body_re_indexes_the_message() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    let mut backfilled = message("account", "one", 1);
    backfilled.plain_body = None;
    MessageRepository::write_full_state(&connection, &backfilled).unwrap();
    assert!(matches(&connection, "quokkatruncated").is_empty());

    MessageRepository::set_truncated_body(
        &connection,
        "account",
        "one",
        Some("Unique plain body token quokkatruncated"),
    )
    .unwrap();

    assert_index_matches_messages(&connection);
    assert_eq!(matches(&connection, "quokkatruncated").len(), 1);
}

#[test]
fn setting_recipient_roles_re_indexes_the_message() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    MessageRepository::write_full_state(&connection, &message("account", "one", 1)).unwrap();

    MessageRepository::set_recipient_roles(
        &connection,
        "account",
        "one",
        "quokkato@example.com",
        "quokkacc@example.com",
        "quokkabcc@example.com",
        None,
    )
    .unwrap();

    assert_index_matches_messages(&connection);
    assert_eq!(matches(&connection, "quokkato").len(), 1);
    assert_eq!(matches(&connection, "quokkacc").len(), 1);
    assert_eq!(matches(&connection, "quokkabcc").len(), 1);
}

#[test]
fn marking_unread_or_starred_leaves_the_search_index_untouched() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    for label_id in ["UNREAD", "STARRED"] {
        LabelRepository::ensure_placeholder(&connection, "account", label_id).unwrap();
    }
    MessageRepository::write_full_state(&connection, &message("account", "one", 1)).unwrap();
    let before = search_index_rowids(&connection);

    MessageRepository::set_label_membership(&connection, "account", "one", "UNREAD", true)
        .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "one", "STARRED", true)
        .unwrap();

    assert_eq!(
        search_index_rowids(&connection),
        before,
        "flag-only mutations must not touch the search index"
    );
    assert_index_matches_messages(&connection);
}

#[test]
fn changing_label_membership_leaves_the_search_index_untouched() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    let label = Label {
        account_id: "account".into(),
        id: "INBOX".into(),
        name: "Inbox".into(),
        kind: "system".into(),
        color: None,
        message_count: 0,
    };
    LabelRepository::upsert(&connection, &label).unwrap();
    MessageRepository::write_full_state(&connection, &message("account", "one", 1)).unwrap();
    let before = search_index_rowids(&connection);

    MessageRepository::overwrite_membership(
        &connection,
        "account",
        "one",
        &["INBOX".to_owned()],
    )
    .unwrap();

    assert_eq!(
        search_index_rowids(&connection),
        before,
        "label-membership mutations must not touch the search index"
    );
    assert_index_matches_messages(&connection);
}

#[test]
fn parity_survives_a_vacuum() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    for id in ["one", "two", "three"] {
        MessageRepository::write_full_state(&connection, &message("account", id, 1)).unwrap();
    }
    MessageRepository::delete(&connection, "account", "two").unwrap();
    assert_index_matches_messages(&connection);

    connection.execute_batch("VACUUM").unwrap();

    assert_index_matches_messages(&connection);
    assert_eq!(search_index_count(&connection), 2);
    assert_eq!(matches(&connection, "quokkaone").len(), 1);
    assert_eq!(matches(&connection, "quokkathree").len(), 1);
    assert!(matches(&connection, "quokkatwo").is_empty());
}
