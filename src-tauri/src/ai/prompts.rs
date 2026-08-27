use chrono::{DateTime, Local, TimeZone};

use crate::ai::retrieval::Passage;

const SYSTEM: &str = include_str!("../../prompts/inbox-chat-system.md");
const PLAN: &str = include_str!("../../prompts/inbox-chat-plan.md");

const DATE_TIME_FORMAT: &str = "%A, %B %-d, %Y, %-I:%M %p";
const DATE_FORMAT: &str = "%Y-%m-%d";
const PASSAGE_SEPARATOR: &str = "\n\n---\n\n";

pub fn system(now: DateTime<Local>, account_email: &str) -> String {
    SYSTEM
        .trim()
        .replace(
            "{{CURRENT_DATETIME}}",
            &now.format(DATE_TIME_FORMAT).to_string(),
        )
        .replace("{{USER_EMAIL}}", account_email)
}

pub fn plan(now: DateTime<Local>, account_email: &str, folders: &[String]) -> String {
    PLAN.trim()
        .replace("{{TODAY_DATE}}", &now.format(DATE_FORMAT).to_string())
        .replace("{{FOLDERS}}", &folders.join(", "))
        .replace("{{USER_EMAIL}}", account_email)
}

pub fn passage_block(passages: &[Passage]) -> String {
    passages
        .iter()
        .enumerate()
        .map(|(index, passage)| {
            format!(
                "[{}] From: {}\nTo: {}\nSubject: {}\nDate: {}\n{}",
                index + 1,
                passage.sender,
                passage.recipients,
                passage.subject,
                sent_at_label(passage.sent_at),
                passage.text
            )
        })
        .collect::<Vec<_>>()
        .join(PASSAGE_SEPARATOR)
}

fn sent_at_label(sent_at: i64) -> String {
    Local
        .timestamp_opt(sent_at, 0)
        .single()
        .map(|moment| moment.format(DATE_TIME_FORMAT).to_string())
        .unwrap_or_default()
}
