use latentmail_lib::{
    storage::{HtmlPresence, Message},
    sync::message_dto,
};

const QUOTED_RECIPIENTS: &str = r#""Doe, John" <john@example.com>, other@example.com"#;

fn message_with_recipients() -> Message {
    Message {
        account_id: "account".into(),
        id: "message".into(),
        thread_id: "thread".into(),
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: QUOTED_RECIPIENTS.into(),
        subject: "Hello".into(),
        sent_at: 0,
        snippet: String::new(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: None,
        html_presence: HtmlPresence::Absent,
    }
}

#[test]
fn every_recipient_list_keeps_a_quoted_display_name_that_contains_a_comma_whole() {
    let expected = vec![
        r#""Doe, John" <john@example.com>"#.to_owned(),
        "other@example.com".to_owned(),
    ];
    let dto = message_dto(
        message_with_recipients(),
        (
            QUOTED_RECIPIENTS.to_owned(),
            QUOTED_RECIPIENTS.to_owned(),
            QUOTED_RECIPIENTS.to_owned(),
        ),
        Vec::new(),
        None,
        false,
        None,
        Vec::new(),
    );
    assert_eq!(dto.recipients, expected);
    assert_eq!(dto.to_recipients, expected);
    assert_eq!(dto.cc_recipients, expected);
    assert_eq!(dto.bcc_recipients, expected);
}
