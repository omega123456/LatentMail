use crate::storage::truncate_body;

const CHUNK_SIZE: usize = 200;
const CHUNK_OVERLAP: usize = 50;
const MAX_WORD_CHARS: usize = 80;
const LONG_WORD_PLACEHOLDER: &str = "[URL]";

pub struct ChunkMessage<'a> {
    pub sender: &'a str,
    pub recipients: &'a str,
    pub subject: &'a str,
    pub truncated_body: Option<&'a str>,
    pub plain_body: Option<&'a str>,
    pub html_body: Option<&'a str>,
}

fn normalize_word(word: &str) -> String {
    if word.chars().count() > MAX_WORD_CHARS {
        return LONG_WORD_PLACEHOLDER.to_owned();
    }
    word.to_owned()
}

fn format_chunk(start: usize, message: &ChunkMessage<'_>, text: String) -> String {
    if start == 0 {
        return format!(
            "From: {}\nTo: {}\nSubject: {}\n\n{text}",
            message.sender, message.recipients, message.subject
        );
    }
    text
}

pub fn chunks(message: &ChunkMessage<'_>) -> Vec<String> {
    let body = message
        .truncated_body
        .map(str::to_owned)
        .unwrap_or_else(|| {
            truncate_body(message.plain_body, message.html_body).unwrap_or_default()
        });
    let words: Vec<String> = body.split_whitespace().map(normalize_word).collect();
    let mut output = Vec::new();
    if words.is_empty() {
        return vec![format!(
            "From: {}\nTo: {}\nSubject: {}\n\n",
            message.sender, message.recipients, message.subject
        )];
    }
    let mut start = 0;
    while start < words.len() {
        let end = (start + CHUNK_SIZE).min(words.len());
        let text = words[start..end].join(" ");
        output.push(format_chunk(start, message, text));
        if end == words.len() {
            break;
        }
        start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
    output
}
