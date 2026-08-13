use latentmail_lib::{
    compose::context::{forward, reply},
    storage::{HtmlPresence, Message},
};

fn message(sender: &str, subject: &str) -> Message {
    Message {
        account_id: "a".into(),
        id: "m".into(),
        thread_id: "t".into(),
        rfc_message_id: Some("<m@example.com>".into()),
        sender: sender.into(),
        recipients: String::new(),
        subject: subject.into(),
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
fn reply_and_forward_preserve_their_distinct_threading_contracts() {
    let original = message("Other <other@example.com>", "re: Hello");
    let reply = reply(
        &original,
        "me@example.com, other@example.com",
        "ME@example.com, copy@example.com",
        "me@example.com",
        true,
        Some("<old@example.com>"),
    );
    assert_eq!(reply.to, vec!["Other <other@example.com>".to_owned()]);
    assert_eq!(reply.cc, vec!["copy@example.com".to_owned()]);
    assert_eq!(reply.subject, "re: Hello");
    assert_eq!(reply.target_thread_id.as_deref(), Some("t"));
    assert_eq!(
        reply.references,
        vec!["<old@example.com>", "<m@example.com>"]
    );
    let forwarded = forward(&original);
    assert!(
        forwarded.target_thread_id.is_none()
            && forwarded.in_reply_to.is_none()
            && forwarded.references.is_empty()
    );
    assert_eq!(forwarded.subject, "Fwd: re: Hello");
}
