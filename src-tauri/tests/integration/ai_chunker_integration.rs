use latentmail_lib::ai::{chunker::chunks, index::MAX_CHUNKS_PER_OPERATION};

#[test]
fn chunks_use_immutable_body_and_overlap() {
    let body = (0..250)
        .map(|index| format!("word{index}"))
        .collect::<Vec<_>>()
        .join(" ");
    let result = chunks(
        "Sender",
        "Recipient",
        "Subject",
        Some(&body),
        Some("changed"),
        None,
    );
    assert_eq!(result.len(), 2);
    assert!(result[0].starts_with("From: Sender\nTo: Recipient\nSubject: Subject\n\nword0"));
    assert!(result[1].starts_with("word150"));
}

#[test]
fn chunks_strip_html_replace_long_words_and_preserve_empty_messages() {
    let long_word = "x".repeat(81);
    let html = format!("<p>first {long_word}</p> <p>last</p>");
    let result = chunks("Sender", "Recipient", "Subject", None, None, Some(&html));
    assert_eq!(
        result,
        vec!["From: Sender\nTo: Recipient\nSubject: Subject\n\nfirst [URL] last"]
    );
    assert_eq!(
        chunks("Sender", "Recipient", "Subject", None, None, None),
        vec!["From: Sender\nTo: Recipient\nSubject: Subject\n\n"]
    );
}

#[test]
fn a_truncated_message_never_exceeds_the_embedding_operation_chunk_limit() {
    let body = "a ".repeat(5_000);
    assert!(
        chunks("Sender", "Recipient", "Subject", Some(&body), None, None).len()
            <= MAX_CHUNKS_PER_OPERATION
    );
}
