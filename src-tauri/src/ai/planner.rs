use chrono::{Local, NaiveDate, TimeZone};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    ai::{
        prompts,
        provider::Provider,
        retrieval::{HistoryMessage, RetrievalRequest, Role},
    },
    storage::RetrievalFilters,
};

const DATE_FORMAT: &str = "%Y-%m-%d";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RetrievalPlan {
    pub query: Option<String>,
    pub filters: RetrievalFilters,
    pub ascending: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanResponse {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    date_from: Option<String>,
    #[serde(default)]
    date_to: Option<String>,
    #[serde(default)]
    sender: Option<String>,
    #[serde(default)]
    recipient: Option<String>,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    has_attachment: Option<Value>,
    #[serde(default)]
    is_read: Option<Value>,
    #[serde(default)]
    is_starred: Option<Value>,
    #[serde(default)]
    date_order: Option<String>,
}

pub fn response_format() -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "retrieval_plan",
            "strict": true,
            "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "query": {"type": ["string", "null"]},
                    "dateFrom": {"type": ["string", "null"]},
                    "dateTo": {"type": ["string", "null"]},
                    "sender": {"type": ["string", "null"]},
                    "recipient": {"type": ["string", "null"]},
                    "folder": {"type": ["string", "null"]},
                    "hasAttachment": {"type": ["boolean", "null"]},
                    "isRead": {"type": ["boolean", "null"]},
                    "isStarred": {"type": ["boolean", "null"]},
                    "dateOrder": {"type": ["string", "null"], "enum": ["asc", null]}
                },
                "required": [
                    "query", "dateFrom", "dateTo", "sender", "recipient", "folder",
                    "hasAttachment", "isRead", "isStarred", "dateOrder"
                ]
            }
        }
    })
}

pub fn parse(raw: &str) -> RetrievalPlan {
    let Ok(parsed) = serde_json::from_str::<Value>(raw.trim()) else {
        return RetrievalPlan::default();
    };
    let candidate = match parsed {
        Value::Array(entries) => entries.into_iter().next(),
        value => Some(value),
    };
    let Some(response) =
        candidate.and_then(|value| serde_json::from_value::<PlanResponse>(value).ok())
    else {
        return RetrievalPlan::default();
    };
    RetrievalPlan {
        query: text(response.query),
        filters: RetrievalFilters {
            date_from: day_start(response.date_from),
            date_to: day_end(response.date_to),
            sender: text(response.sender),
            recipient: text(response.recipient),
            folder: text(response.folder),
            has_attachment: flag(response.has_attachment),
            is_read: flag(response.is_read),
            is_starred: flag(response.is_starred),
        },
        ascending: response.date_order.as_deref() == Some("asc"),
    }
}

pub async fn plan(
    provider: &Provider,
    request: &RetrievalRequest<'_>,
    folders: &[String],
) -> RetrievalPlan {
    let system = prompts::plan(Local::now(), request.account_email, folders);
    let user = format!(
        "{}New question: {}",
        conversation_label(request.history),
        request.question
    );
    let messages = json!([
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]);
    provider
        .chat_completion(request.chat_model, messages, Some(response_format()))
        .await
        .map_or_else(
            |_| RetrievalPlan::default(),
            |raw| sanitize(parse(&raw), request, folders),
        )
}

fn sanitize(
    mut plan: RetrievalPlan,
    request: &RetrievalRequest<'_>,
    folders: &[String],
) -> RetrievalPlan {
    let question = request.question.to_lowercase();
    let account_email = request.account_email.to_lowercase();
    let words = question
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    plan.query = plan.query.filter(|query| {
        !request.history.is_empty() && !query.trim().eq_ignore_ascii_case(request.question.trim())
    });
    plan.filters.folder = plan.filters.folder.and_then(|folder| {
        folders
            .iter()
            .find(|available| available.eq_ignore_ascii_case(&folder))
            .filter(|available| folder_is_stated(&words, available))
            .cloned()
    });
    plan.filters.has_attachment = plan.filters.has_attachment.filter(|_| {
        has_word(
            &words,
            &["attachment", "attachments", "attached", "file", "files"],
        )
    });
    plan.filters.is_read = plan
        .filters
        .is_read
        .filter(|_| has_word(&words, &["read", "unread"]));
    plan.filters.is_starred = plan
        .filters
        .is_starred
        .filter(|_| has_word(&words, &["star", "starred", "flag", "flagged"]));
    if !date_scope_is_stated(&question, &words) {
        plan.filters.date_from = None;
        plan.filters.date_to = None;
    }
    plan.ascending &= has_word(&words, &["first", "earliest", "oldest", "original"]);
    if plan
        .filters
        .sender
        .as_deref()
        .is_some_and(|sender| sender.eq_ignore_ascii_case(request.account_email))
        && !question.contains(&account_email)
        && ![
            "from me",
            "from myself",
            "sent by me",
            "i sent",
            "i have sent",
            "did i send",
            "my sent",
        ]
        .iter()
        .any(|phrase| question.contains(phrase))
    {
        plan.filters.sender = None;
    }
    if plan
        .filters
        .recipient
        .as_deref()
        .is_some_and(|recipient| recipient.eq_ignore_ascii_case(request.account_email))
        && !question.contains(&account_email)
        && ![
            "to me",
            "sent me",
            "send me",
            "addressed to me",
            "i received",
        ]
        .iter()
        .any(|phrase| question.contains(phrase))
    {
        plan.filters.recipient = None;
    }
    plan
}

fn has_word(words: &[&str], expected: &[&str]) -> bool {
    words.iter().any(|word| expected.contains(word))
}

fn folder_is_stated(words: &[&str], folder: &str) -> bool {
    folder
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty() && *word != "category" && *word != "mail")
        .all(|word| words.contains(&word))
}

fn date_scope_is_stated(question: &str, words: &[&str]) -> bool {
    has_word(
        words,
        &[
            "today",
            "yesterday",
            "tomorrow",
            "day",
            "days",
            "week",
            "weeks",
            "fortnight",
            "month",
            "months",
            "quarter",
            "quarters",
            "year",
            "years",
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
        ],
    ) || words.iter().any(|word| {
        (word.len() == 4 && word.chars().all(|character| character.is_ascii_digit()))
            || matches!(*word, "q1" | "q2" | "q3" | "q4")
    }) || question.split_whitespace().any(|word| {
        word.chars().any(|character| character.is_ascii_digit())
            && (word.contains('/') || word.contains('-'))
    })
}

fn conversation_label(history: &[HistoryMessage]) -> String {
    if history.is_empty() {
        return "Conversation: (empty)\n".to_owned();
    }
    let lines = history
        .iter()
        .map(|message| {
            let role = match message.role {
                Role::User => "User",
                Role::Assistant => "Assistant",
            };
            format!("{role}: {}", message.content)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("Conversation:\n{lines}\n")
}

fn text(value: Option<String>) -> Option<String> {
    value.filter(|entry| !entry.trim().is_empty())
}

fn flag(value: Option<Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(value)) => Some(value),
        Some(Value::String(value)) => match value.to_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn day_start(value: Option<String>) -> Option<i64> {
    let day = NaiveDate::parse_from_str(text(value)?.trim(), DATE_FORMAT).ok()?;
    Local
        .from_local_datetime(&day.and_hms_opt(0, 0, 0)?)
        .earliest()
        .map(|moment| moment.timestamp())
}

fn day_end(value: Option<String>) -> Option<i64> {
    let day = NaiveDate::parse_from_str(text(value)?.trim(), DATE_FORMAT).ok()?;
    Local
        .from_local_datetime(&day.and_hms_opt(23, 59, 59)?)
        .latest()
        .map(|moment| moment.timestamp())
}
