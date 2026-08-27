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
    #[serde(default)]
    direction: Option<String>,
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
                    "dateOrder": {"type": ["string", "null"], "enum": ["asc", null]},
                    "direction": {"type": ["string", "null"], "enum": ["sent", "received", null]}
                },
                "required": [
                    "query", "dateFrom", "dateTo", "sender", "recipient", "folder",
                    "hasAttachment", "isRead", "isStarred", "dateOrder", "direction"
                ]
            }
        }
    })
}

pub fn parse(raw: &str, account_email: &str) -> RetrievalPlan {
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
    let direction = response.direction.as_deref();
    let self_address = |side| (direction == Some(side)).then(|| account_email.to_owned());
    RetrievalPlan {
        query: text(response.query),
        filters: RetrievalFilters {
            date_from: day_start(response.date_from),
            date_to: day_end(response.date_to),
            sender: self_address("sent").or_else(|| other_party(response.sender, account_email)),
            recipient: self_address("received")
                .or_else(|| other_party(response.recipient, account_email)),
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
            |raw| sanitize(parse(&raw, request.account_email), request, folders),
        )
}

fn sanitize(
    mut plan: RetrievalPlan,
    request: &RetrievalRequest<'_>,
    folders: &[String],
) -> RetrievalPlan {
    plan.query = plan.query.filter(|query| {
        !request.history.is_empty() && !query.trim().eq_ignore_ascii_case(request.question.trim())
    });
    plan.filters.folder = plan.filters.folder.and_then(|folder| {
        folders
            .iter()
            .find(|available| available.eq_ignore_ascii_case(&folder))
            .cloned()
    });
    if matches!((plan.filters.date_from, plan.filters.date_to), (Some(from), Some(to)) if from > to)
    {
        plan.filters.date_from = None;
        plan.filters.date_to = None;
    }
    plan
}

fn other_party(value: Option<String>, account_email: &str) -> Option<String> {
    text(value).filter(|address| !address.eq_ignore_ascii_case(account_email))
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
