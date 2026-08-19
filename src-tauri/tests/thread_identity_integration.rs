
use latentmail_lib::gmail::GmailMessage;
use latentmail_lib::storage::addresses::{domain_of, first_identity, parse_address, split_addresses};
use latentmail_lib::storage::{Account, AccountRepository, Storage, ThreadRepository};
use latentmail_lib::sync::materialize;

fn message(id: &str, thread_id: &str, sender: &str, to: &str, sent_at: i64, sent_label: bool) -> GmailMessage {
    GmailMessage {
        id: id.into(),
        thread_id: thread_id.into(),
        history_id: sent_at,
        label_ids: if sent_label {
            vec!["SENT".into()]
        } else {
            vec!["INBOX".into()]
        },
        snippet: String::new(),
        sent_at,
        rfc_message_id: None,
        sender: sender.into(),
        recipients: to.into(),
        to_recipients: to.into(),
        cc_recipients: String::new(),
        bcc_recipients: String::new(),
        rfc_references: None,
        subject: "Subject".into(),
        html_body: None,
        plain_body: Some("body".into()),
        has_attachments: false,
        inline_parts: Vec::new(),
        attachment_parts: Vec::new(),
        oversize: false,
    }
}

fn account_row() -> Account {
    Account {
        id: "a".into(),
        email: "me@example.com".into(),
        display_name: "Me".into(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}



#[test]
fn split_addresses_respects_a_comma_inside_a_quoted_display_name() {
    let entries = split_addresses(r#""Kovacs, Jozsef" <j@example.com>, other@x.com"#);
    assert_eq!(
        entries,
        vec![
            r#""Kovacs, Jozsef" <j@example.com>"#.to_owned(),
            "other@x.com".to_owned(),
        ]
    );
}

#[test]
fn split_addresses_handles_empty_input() {
    assert!(split_addresses("").is_empty());
    assert!(split_addresses("   ").is_empty());
}

#[test]
fn parse_address_recovers_the_bare_address_from_a_quoted_display_name() {
    let identity = parse_address(r#""Kovacs, Jozsef" <j@example.com>"#).unwrap();
    assert_eq!(identity.display, "Kovacs, Jozsef");
    assert_eq!(identity.address, "j@example.com");
}

#[test]
fn parse_address_uses_the_address_itself_as_the_display_when_bare() {
    let identity = parse_address("bare@example.com").unwrap();
    assert_eq!(identity.display, "bare@example.com");
    assert_eq!(identity.address, "bare@example.com");
}

#[test]
fn parse_address_is_none_for_empty_or_addressless_input() {
    assert!(parse_address("").is_none());
    assert!(parse_address("Display Name Only <>").is_none());
}

#[test]
fn parse_address_falls_back_to_the_address_when_angle_brackets_carry_no_name() {
    let identity = parse_address("<j@example.com>").unwrap();
    assert_eq!(identity.display, "j@example.com");
    assert_eq!(identity.address, "j@example.com");
}

#[test]
fn first_identity_takes_the_first_recoverable_entry() {
    let identity = first_identity(r#""Kovacs, Jozsef" <j@example.com>, other@x.com"#).unwrap();
    assert_eq!(identity.address, "j@example.com");
}

#[test]
fn domain_of_lower_cases_and_handles_missing_at_sign() {
    assert_eq!(domain_of("Someone@Example.COM").as_deref(), Some("example.com"));
    assert_eq!(domain_of("not-an-address"), None);
}

#[test]
fn domain_of_is_none_when_the_domain_portion_is_empty() {
    assert_eq!(domain_of("user@"), None);
}



#[test]
fn the_stored_sender_is_the_newest_messages_sender_not_the_first() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account_row()).unwrap();

    materialize::persist(
        &connection,
        "a",
        &message("m1", "t1", "old@example.com", "me@example.com", 100, false),
    )
    .unwrap();
    materialize::persist(
        &connection,
        "a",
        &message(
            "m2",
            "t1",
            r#""Kovacs, Jozsef" <j@example.com>"#,
            "me@example.com",
            200,
            false,
        ),
    )
    .unwrap();
    ThreadRepository::recompute(&connection, "a", "t1").unwrap();

    let thread = ThreadRepository::get(&connection, "a", "t1").unwrap().unwrap();

    assert_eq!(thread.sender_identity.display, "Kovacs, Jozsef");
    assert_eq!(thread.sender_identity.address.as_deref(), Some("j@example.com"));
}

#[test]
fn a_thread_with_no_sent_message_carries_no_recipient_identity() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account_row()).unwrap();
    materialize::persist(
        &connection,
        "a",
        &message("m1", "t1", "sender@example.com", "me@example.com", 100, false),
    )
    .unwrap();
    ThreadRepository::recompute(&connection, "a", "t1").unwrap();

    let thread = ThreadRepository::get(&connection, "a", "t1").unwrap().unwrap();
    assert!(thread.recipient_identity.is_none());
}

#[test]
fn a_sent_thread_carries_the_newest_sent_messages_first_recipient() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account_row()).unwrap();
    materialize::persist(
        &connection,
        "a",
        &message("m1", "t1", "me@example.com", "old-recipient@example.com", 100, true),
    )
    .unwrap();
    materialize::persist(
        &connection,
        "a",
        &message(
            "m2",
            "t1",
            "me@example.com",
            r#""Doe, Jane" <jane@example.com>, cc@example.com"#,
            200,
            true,
        ),
    )
    .unwrap();
    ThreadRepository::recompute(&connection, "a", "t1").unwrap();

    let thread = ThreadRepository::get(&connection, "a", "t1").unwrap().unwrap();
    let recipient = thread.recipient_identity.expect("Sent thread must carry a recipient identity");
    assert_eq!(recipient.display, "Doe, Jane");
    assert_eq!(recipient.address.as_deref(), Some("jane@example.com"));
}

#[test]
fn missing_sender_and_recipient_data_produce_both_fallback_strings() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account_row()).unwrap();
    materialize::persist(&connection, "a", &message("m1", "t1", "", "", 100, true)).unwrap();
    ThreadRepository::recompute(&connection, "a", "t1").unwrap();

    let thread = ThreadRepository::get(&connection, "a", "t1").unwrap().unwrap();
    assert_eq!(thread.sender_identity.display, "(No sender)");
    assert_eq!(thread.sender_identity.address, None);
    let recipient = thread.recipient_identity.expect("still carries an identity slot for the Sent message");
    assert_eq!(recipient.display, "(No recipient)");
    assert_eq!(recipient.address, None);
}

#[test]
fn a_thread_with_malformed_stored_identity_json_falls_back_instead_of_erroring() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account_row()).unwrap();
    materialize::persist(
        &connection,
        "a",
        &message("m1", "t1", "sender@example.com", "me@example.com", 100, true),
    )
    .unwrap();
    ThreadRepository::recompute(&connection, "a", "t1").unwrap();

    connection
        .execute(
            "UPDATE threads SET sender_identity='not valid json', recipient_identity='also not valid json' WHERE account_id='a' AND id='t1'",
            [],
        )
        .unwrap();

    let thread = ThreadRepository::get(&connection, "a", "t1").unwrap().unwrap();
    assert_eq!(thread.sender_identity.display, "(No sender)");
    assert_eq!(thread.sender_identity.address, None);
    let recipient = thread.recipient_identity.expect("still carries an identity slot");
    assert_eq!(recipient.display, "(No recipient)");
    assert_eq!(recipient.address, None);
}

