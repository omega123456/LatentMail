use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{Local, NaiveDate, TimeZone};
use serde::Deserialize;

use crate::{
    ai::{chunker, prompts, provider::Provider},
    storage::{
        CandidatePassage, PassageSource, RetrievalFilters, RetrievalRepository, Storage,
        StorageError,
    },
};

pub const VARIANT_COUNT: usize = 5;
pub const CANDIDATE_BUDGET: i64 = 1360;
pub const SIMILARITY_FLOOR: f64 = 0.5;
pub const PASSAGE_LIMIT: usize = 15;

const DATE_FORMAT: &str = "%Y-%m-%d";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    pub fn label(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Variant {
    pub query: String,
    pub filters: RetrievalFilters,
    pub ascending: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Passage {
    pub message_seq: i64,
    pub chunk_index: i64,
    pub similarity: f64,
    pub sent_at: i64,
    pub sender: String,
    pub recipients: String,
    pub subject: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Retrieved {
    pub passages: Vec<Passage>,
    pub context: String,
    pub sources: Vec<PassageSource>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Retrieval {
    Found(Box<Retrieved>),
    Empty,
    Cancelled,
}

pub struct RetrievalRequest<'a> {
    pub chat_model: &'a str,
    pub embedding_model: &'a str,
    pub account_id: &'a str,
    pub account_email: &'a str,
    pub question: &'a str,
    pub history: &'a [HistoryMessage],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RewriteVariant {
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
    has_attachment: Option<serde_json::Value>,
    #[serde(default)]
    is_read: Option<serde_json::Value>,
    #[serde(default)]
    is_starred: Option<serde_json::Value>,
    #[serde(default)]
    date_order: Option<String>,
}

#[derive(Deserialize)]
struct RelevanceVerdict {
    relevant: bool,
}

fn storage_error(error: StorageError) -> String {
    error.to_string()
}

fn cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::SeqCst)
}

fn text(value: Option<String>) -> Option<String> {
    value.filter(|entry| !entry.trim().is_empty())
}

fn flag(value: Option<serde_json::Value>) -> Option<bool> {
    match value {
        Some(serde_json::Value::Bool(value)) => Some(value),
        Some(serde_json::Value::String(value)) => match value.to_lowercase().as_str() {
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

fn raw_variant(question: &str) -> Variant {
    Variant {
        query: question.to_owned(),
        filters: RetrievalFilters::default(),
        ascending: false,
    }
}

fn fallback_variants(question: &str) -> Vec<Variant> {
    (0..VARIANT_COUNT).map(|_| raw_variant(question)).collect()
}

pub fn parse_variants(raw: &str, question: &str) -> Vec<Variant> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw.trim()) else {
        return fallback_variants(question);
    };
    let array = match parsed {
        serde_json::Value::Array(entries) => Some(entries),
        serde_json::Value::Object(entries) => {
            entries.values().find_map(|value| value.as_array().cloned())
        }
        _ => None,
    };
    let Some(array) = array else {
        return fallback_variants(question);
    };
    let mut variants: Vec<Variant> = array
        .into_iter()
        .filter_map(|entry| serde_json::from_value::<RewriteVariant>(entry).ok())
        .map(|entry| Variant {
            query: text(entry.query).unwrap_or_else(|| question.to_owned()),
            filters: RetrievalFilters {
                date_from: day_start(entry.date_from),
                date_to: day_end(entry.date_to),
                sender: text(entry.sender),
                recipient: text(entry.recipient),
                folder: text(entry.folder),
                has_attachment: flag(entry.has_attachment),
                is_read: flag(entry.is_read),
                is_starred: flag(entry.is_starred),
            },
            ascending: entry.date_order.as_deref() == Some("asc"),
        })
        .take(VARIANT_COUNT)
        .collect();
    while variants.len() < VARIANT_COUNT {
        variants.push(raw_variant(question));
    }
    variants
}

fn history_json(history: &[HistoryMessage]) -> Vec<serde_json::Value> {
    history
        .iter()
        .map(
            |message| serde_json::json!({"role": message.role.label(), "content": message.content}),
        )
        .collect()
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

pub async fn rewrite_variants(
    provider: &Provider,
    request: &RetrievalRequest<'_>,
    folders: &[String],
) -> Vec<Variant> {
    let system = prompts::rewrite(Local::now(), request.account_email, folders);
    let user = format!(
        "{}New question: {}",
        conversation_label(request.history),
        request.question
    );
    let messages = serde_json::json!([
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]);
    match provider.chat_completion(request.chat_model, messages).await {
        Ok(raw) => parse_variants(&raw, request.question),
        Err(_) => fallback_variants(request.question),
    }
}

async fn is_relevant(provider: &Provider, request: &RetrievalRequest<'_>, context: &str) -> bool {
    let mut messages = vec![serde_json::json!({"role":"system","content":prompts::relevance()})];
    messages.extend(history_json(request.history));
    messages.push(serde_json::json!({
        "role": "user",
        "content": format!(
            "## Email Context\n\n{context}\n\n## Question\n\n{}",
            request.question
        ),
    }));
    match provider
        .chat_completion(request.chat_model, serde_json::Value::Array(messages))
        .await
    {
        Ok(raw) => serde_json::from_str::<RelevanceVerdict>(raw.trim())
            .map(|verdict| verdict.relevant)
            .unwrap_or(true),
        Err(_) => true,
    }
}

fn order_candidates(candidates: &mut [(CandidatePassage, f64)], ascending: bool) {
    candidates.sort_by(|left, right| {
        let by_date = if ascending {
            left.0.sent_at.cmp(&right.0.sent_at)
        } else {
            right.0.sent_at.cmp(&left.0.sent_at)
        };
        by_date.then_with(|| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
}

fn assemble(candidates: &[(CandidatePassage, f64)], sources: &[PassageSource]) -> Vec<Passage> {
    candidates
        .iter()
        .filter_map(|(candidate, similarity)| {
            let source = sources
                .iter()
                .find(|source| source.message_seq == candidate.message_seq)?;
            let chunks = chunker::chunks(
                &source.sender,
                &source.recipients,
                &source.subject,
                source.truncated_body.as_deref(),
                source.plain_body.as_deref(),
                source.html_body.as_deref(),
            );
            let index = usize::try_from(candidate.chunk_index).ok()?;
            let raw = chunks.get(index)?;
            let body = if index == 0 {
                raw.split_once("\n\n")
                    .map_or(raw.as_str(), |(_, rest)| rest)
            } else {
                raw.as_str()
            };
            Some(Passage {
                message_seq: candidate.message_seq,
                chunk_index: candidate.chunk_index,
                similarity: *similarity,
                sent_at: candidate.sent_at,
                sender: source.sender.clone(),
                recipients: source.recipients.clone(),
                subject: source.subject.clone(),
                text: body.to_owned(),
            })
        })
        .collect()
}

fn ordered_sequences(passages: &[Passage]) -> Vec<i64> {
    let mut sequences = Vec::new();
    for passage in passages {
        if !sequences.contains(&passage.message_seq) {
            sequences.push(passage.message_seq);
        }
    }
    sequences
}

fn cited_sources(passages: &[Passage], sources: &[PassageSource]) -> Vec<PassageSource> {
    ordered_sequences(passages)
        .into_iter()
        .filter_map(|sequence| {
            sources
                .iter()
                .find(|source| source.message_seq == sequence)
                .cloned()
        })
        .collect()
}

async fn variant_passages(
    storage: &Storage,
    account_id: &str,
    variant: &Variant,
    vector: Vec<f32>,
) -> Result<(Vec<Passage>, Vec<PassageSource>), String> {
    let account = account_id.to_owned();
    let filters = variant.filters.clone();
    let ascending = variant.ascending;
    storage
        .run(move |connection| {
            let mut retained: Vec<(CandidatePassage, f64)> = RetrievalRepository::candidates(
                connection,
                &account,
                &vector,
                CANDIDATE_BUDGET,
                &filters,
            )?
            .into_iter()
            .map(|candidate| {
                let similarity = 1.0 - candidate.distance;
                (candidate, similarity)
            })
            .filter(|(_, similarity)| *similarity >= SIMILARITY_FLOOR)
            .collect();
            order_candidates(&mut retained, ascending);
            retained.truncate(PASSAGE_LIMIT);
            let mut sequences: Vec<i64> = Vec::new();
            for (candidate, _) in &retained {
                if !sequences.contains(&candidate.message_seq) {
                    sequences.push(candidate.message_seq);
                }
            }
            let sources = RetrievalRepository::sources(connection, &account, &sequences)?;
            Ok((assemble(&retained, &sources), sources))
        })
        .await
        .map_err(storage_error)
}

pub async fn retrieve(
    provider: &Provider,
    storage: &Storage,
    request: &RetrievalRequest<'_>,
    cancel: &AtomicBool,
) -> Result<Retrieval, String> {
    let account = request.account_id.to_owned();
    let folders = storage
        .run(move |connection| RetrievalRepository::folder_names(connection, &account))
        .await
        .map_err(storage_error)?;
    if cancelled(cancel) {
        return Ok(Retrieval::Cancelled);
    }
    let variants = rewrite_variants(provider, request, &folders).await;
    if cancelled(cancel) {
        return Ok(Retrieval::Cancelled);
    }
    let mut queries: Vec<String> = Vec::new();
    for variant in &variants {
        if !queries.contains(&variant.query) {
            queries.push(variant.query.clone());
        }
    }
    let vectors = provider
        .embed(request.embedding_model, queries.clone())
        .await
        .map_err(|error| error.to_string())?;
    if vectors.len() != queries.len() {
        return Err("Provider returned an incomplete embedding batch".to_owned());
    }
    let last = variants.len().saturating_sub(1);
    let mut seen: Vec<String> = Vec::new();
    for (index, variant) in variants.iter().enumerate() {
        if cancelled(cancel) {
            return Ok(Retrieval::Cancelled);
        }
        let key = format!("{}|{:?}", variant.query, variant.filters);
        if index < last && seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let Some(position) = queries.iter().position(|query| query == &variant.query) else {
            continue;
        };
        let (passages, sources) = variant_passages(
            storage,
            request.account_id,
            variant,
            vectors[position].clone(),
        )
        .await?;
        if passages.is_empty() {
            if index < last {
                continue;
            }
            return Ok(Retrieval::Empty);
        }
        let context = prompts::passage_block(&passages);
        if cancelled(cancel) {
            return Ok(Retrieval::Cancelled);
        }
        if index < last && !is_relevant(provider, request, &context).await {
            continue;
        }
        return Ok(Retrieval::Found(Box::new(Retrieved {
            sources: cited_sources(&passages, &sources),
            context,
            passages,
        })));
    }
    Ok(Retrieval::Empty)
}
