use crate::storage::truncate_body;

const CHUNK_SIZE: usize = 200;
const CHUNK_OVERLAP: usize = 50;
const MAX_WORD_CHARS: usize = 80;
const LONG_WORD_PLACEHOLDER: &str = "[URL]";

fn normalize_word(word: &str) -> String {
    if word.chars().count() > MAX_WORD_CHARS {
        return LONG_WORD_PLACEHOLDER.to_owned();
    }
    word.to_owned()
}

fn format_chunk(
    start: usize,
    sender: &str,
    recipients: &str,
    subject: &str,
    text: String,
) -> String {
    if start == 0 {
        return format!("From: {sender}\nTo: {recipients}\nSubject: {subject}\n\n{text}");
    }
    text
}

pub fn chunks(
    sender: &str,
    recipients: &str,
    subject: &str,
    truncated_body: Option<&str>,
    plain_body: Option<&str>,
    html_body: Option<&str>,
) -> Vec<String> {
    let body = truncated_body
        .map(str::to_owned)
        .unwrap_or_else(|| truncate_body(plain_body, html_body).unwrap_or_default());
    let words: Vec<String> = body.split_whitespace().map(normalize_word).collect();
    let mut output = Vec::new();
    if words.is_empty() {
        return vec![format!(
            "From: {sender}\nTo: {recipients}\nSubject: {subject}\n\n"
        )];
    }
    let mut start = 0;
    while start < words.len() {
        let end = (start + CHUNK_SIZE).min(words.len());
        let text = words[start..end].join(" ");
        output.push(format_chunk(start, sender, recipients, subject, text));
        if end == words.len() {
            break;
        }
        start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
    output
}
