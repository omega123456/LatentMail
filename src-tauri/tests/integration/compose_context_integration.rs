use chrono::{DateTime, Utc};
use latentmail_lib::compose::context::ReplyInput;
use latentmail_lib::{
    compose::context::{display_quote, forward, outgoing_quote, reply, ReplyAttachment},
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
        ReplyInput {
            to: "me@example.com, other@example.com",
            cc: "ME@example.com, copy@example.com",
            account_email: "me@example.com",
            all: true,
            references: Some("<old@example.com>"),
            attachments: Vec::new(),
        },
    );
    assert_eq!(reply.to, vec!["Other <other@example.com>".to_owned()]);
    assert_eq!(reply.cc, vec!["copy@example.com".to_owned()]);
    assert_eq!(reply.subject, "re: Hello");
    assert_eq!(reply.target_thread_id.as_deref(), Some("t"));
    assert_eq!(
        reply.references,
        vec!["<old@example.com>", "<m@example.com>"]
    );
    let forwarded = forward(&original, Vec::new());
    assert!(
        forwarded.target_thread_id.is_none()
            && forwarded.in_reply_to.is_none()
            && forwarded.references.is_empty()
    );
    assert_eq!(forwarded.subject, "Fwd: re: Hello");
}

#[test]
fn reply_context_normalizes_self_replies_and_display_quotes() {
    let mut original = message("Me <ME@example.com>", "Hello");
    original.rfc_message_id = None;
    original.sent_at = DateTime::<Utc>::from_timestamp(0, 0).unwrap().timestamp();
    original.plain_body = Some("One & <two>\nthree".into());

    let reply = reply(
        &original,
        ReplyInput {
            to: "ME@example.com, Other <OTHER@example.com>, other@example.com",
            cc: "copy@example.com",
            account_email: "me@example.com",
            all: false,
            references: None,
            attachments: Vec::new(),
        },
    );
    assert_eq!(reply.to, vec!["Other <OTHER@example.com>"]);
    assert!(reply.cc.is_empty());
    assert!(reply.references.is_empty());
    assert_eq!(reply.subject, "Re: Hello");
    assert_eq!(
        reply.display_quote.unwrap().html,
        "<p>One &amp; &lt;two&gt;<br>three</p>"
    );

    original.html_body = Some("<script>bad()</script><p>safe</p>".into());
    assert_eq!(display_quote(&original).unwrap().html, "<p>safe</p>");
    original.html_body = None;
    original.plain_body = None;
    assert!(display_quote(&original).is_none());
}

#[test]
fn forward_carries_the_originals_attachment_metadata() {
    let original = message("Other <other@example.com>", "Report");
    let attachments = vec![ReplyAttachment {
        id: "att-1".into(),
        filename: "report.pdf".into(),
        mime_type: "application/pdf".into(),
        size: 1024,
    }];
    let forwarded = forward(&original, attachments.clone());
    assert_eq!(forwarded.attachments, attachments);
}

#[test]
fn reply_all_keeps_a_quoted_display_name_that_contains_a_comma_whole() {
    let original = message(r#""Doe, John" <john@example.com>"#, "Hello");
    let reply = reply(
        &original,
        ReplyInput {
            to: r#""Roe, Jane" <jane@example.com>, me@example.com"#,
            cc: r#""Poe, Edgar" <edgar@example.com>"#,
            account_email: "me@example.com",
            all: true,
            references: None,
            attachments: Vec::new(),
        },
    );
    assert_eq!(
        reply.to,
        vec![
            r#""Doe, John" <john@example.com>"#.to_owned(),
            r#""Roe, Jane" <jane@example.com>"#.to_owned()
        ]
    );
    assert_eq!(
        reply.cc,
        vec![r#""Poe, Edgar" <edgar@example.com>"#.to_owned()]
    );
}

#[test]
fn the_outgoing_quote_escapes_the_sender_and_a_plain_text_original() {
    let mut original = message("Alice <alice@example.com>", "Hello");
    original.sent_at = DateTime::<Utc>::from_timestamp(0, 0).unwrap().timestamp();
    original.plain_body = Some("1 < 2 & <b>bold</b>".into());
    assert_eq!(
        outgoing_quote(&original),
        "<p>On Jan 1, 1970 at 00:00, Alice &lt;alice@example.com&gt; wrote:</p>\
         <blockquote><pre>1 &lt; 2 &amp; &lt;b&gt;bold&lt;/b&gt;</pre></blockquote>"
    );
    original.html_body = Some("<p>rich</p>".into());
    assert!(outgoing_quote(&original).ends_with("<blockquote><p>rich</p></blockquote>"));
}
