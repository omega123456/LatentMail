use latentmail_lib::compose::mime::{
    assemble, validate_encoded_size, OutgoingMessage, Part, MAX_RFC2822_BYTES,
};

fn outgoing() -> OutgoingMessage {
    OutgoingMessage { from: "Sender <sender@example.com>".into(), to: vec!["Recipient <recipient@example.com>".into()], cc: vec![], bcc: vec![], subject: "Résumé".into(), html: "<h1>Heading</h1><ul><li>One</li></ul><blockquote>Quote</blockquote><a href=\"https://example.com\">Link</a>".into(), quote_html: None, in_reply_to: Some("<original@example.com>".into()), references: vec!["<earlier@example.com>".into(), "<original@example.com>".into()], inline: vec![], attachments: vec![] }
}

#[test]
fn assembles_plain_and_html_with_threading_headers() {
    let raw = String::from_utf8(assemble(&outgoing()).unwrap()).unwrap();
    assert!(raw.contains("multipart/alternative"));
    assert!(raw.contains("In-Reply-To: <original@example.com>"));
    assert!(raw.contains("Heading"));
}

/// A draft is saved long before it has anywhere to go — the composer
/// autosaves as soon as there is a subject or a body — so assembly must not
/// require a destination the way a message about to be handed to an SMTP
/// transport would.
#[test]
fn assembles_a_draft_that_has_no_recipients_yet() {
    let mut message = outgoing();
    message.to.clear();
    let raw = String::from_utf8(assemble(&message).unwrap()).unwrap();
    assert!(raw.contains("From: Sender <sender@example.com>"));
    // Anchored to the header line: `In-Reply-To:` also ends in "To:".
    assert!(!raw.contains("\r\nTo:"));
}

/// Gmail derives recipients from the document's own headers — there is no
/// envelope alongside it — so a stripped `Bcc` header is a bcc recipient
/// who silently never receives the message.
#[test]
fn keeps_the_bcc_header_gmail_delivers_from() {
    let mut message = outgoing();
    message.cc.push("Copied <cc@example.com>".into());
    message.bcc.push("Hidden <bcc@example.com>".into());
    let raw = String::from_utf8(assemble(&message).unwrap()).unwrap();
    assert!(raw.contains("Cc: Copied <cc@example.com>"));
    assert!(raw.contains("Bcc: Hidden <bcc@example.com>"));
}

#[test]
fn rejects_an_encoded_document_over_the_limit() {
    let mut message = outgoing();
    message.attachments.push(Part {
        filename: "large.bin".into(),
        mime_type: "application/octet-stream".into(),
        bytes: vec![0; MAX_RFC2822_BYTES],
        content_id: None,
    });
    assert!(assemble(&message).is_err());
}

#[test]
fn accepts_the_exact_encoded_ceiling_and_rejects_one_byte_over() {
    let mut message = outgoing();
    message.subject.clear();
    // Fixed by the deterministic lettre encoder; this fixture was found once
    // by search and avoids repeatedly assembling 25 MB documents in a test.
    let low = 18_268_380usize;
    message.attachments = vec![Part {
        filename: "a".into(),
        mime_type: "application/octet-stream".into(),
        bytes: vec![0; low],
        content_id: None,
    }];
    // Base64 moves in small steps; subject bytes fill the final exact encoded
    // boundary without hand-calculating MIME overhead.
    for suffix in 0..16 {
        message.subject = "x".repeat(suffix);
        let raw = assemble(&message).unwrap();
        if raw.len() == MAX_RFC2822_BYTES {
            assert!(validate_encoded_size(MAX_RFC2822_BYTES).is_ok());
            assert!(validate_encoded_size(MAX_RFC2822_BYTES + 1).is_err());
            return;
        }
    }
    panic!("unable to construct exact encoded boundary");
}

#[test]
fn nests_related_and_mixed_parts_when_needed() {
    let mut message = outgoing();
    message.html = r#"<img src="cid:logo">"#.into();
    message.inline.push(Part {
        filename: "logo.png".into(),
        mime_type: "image/png".into(),
        bytes: vec![1, 2],
        content_id: Some("logo".into()),
    });
    let related = String::from_utf8(assemble(&message).unwrap()).unwrap();
    assert!(related.contains("multipart/related"));
    assert!(related.contains("Content-ID: <logo>"));
    assert!(related.contains("cid:logo"));
    message.attachments.push(Part {
        filename: "notes.txt".into(),
        mime_type: "text/plain".into(),
        bytes: b"notes".to_vec(),
        content_id: None,
    });
    let mixed = String::from_utf8(assemble(&message).unwrap()).unwrap();
    assert!(mixed.contains("multipart/mixed"));
    assert!(mixed.contains("notes.txt"));
}

#[test]
fn rejects_invalid_mailboxes_before_building_a_message() {
    let mut message = outgoing();
    message.to = vec!["not an address".into()];
    assert!(assemble(&message).is_err());
}
