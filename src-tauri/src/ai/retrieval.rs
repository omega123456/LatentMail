use std::sync::atomic::{AtomicBool, Ordering};

use crate::{
    ai::{
        chunker,
        fusion::{self, Selected},
        planner, prompts,
        provider::Provider,
    },
    storage::{PassageSource, RetrievalFilters, RetrievalRepository, Storage, StorageError},
};

pub const CANDIDATE_BUDGET: i64 = 1360;
pub const SIMILARITY_FLOOR: f64 = 0.5;
pub const PASSAGE_LIMIT: usize = 15;
pub const LEXICAL_LIMIT: i64 = 50;
pub const CHRONOLOGICAL_LIMIT: i64 = 15;
pub const RECENCY_LIMIT: i64 = 15;

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
    pub has_attachments: bool,
    pub attachment_count: i64,
    pub is_starred: bool,
    pub is_unread: bool,
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

enum Arm {
    Vector(Vec<f32>, RetrievalFilters),
    Lexical(RetrievalFilters),
    Chronological(RetrievalFilters),
    Recency(RetrievalFilters, bool),
}

enum ArmOutput {
    Passages(Vec<Selected>),
    Sequences(Vec<i64>),
}

fn storage_error(error: StorageError) -> String {
    error.to_string()
}

fn cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::SeqCst)
}

async fn run_arm(
    storage: Storage,
    account_id: String,
    question: String,
    arm: Arm,
) -> Result<ArmOutput, String> {
    storage
        .run(move |connection| match arm {
            Arm::Vector(vector, filters) => Ok(ArmOutput::Passages(
                RetrievalRepository::candidates(
                    connection,
                    &account_id,
                    &vector,
                    CANDIDATE_BUDGET,
                    &filters,
                )?
                .into_iter()
                .map(|candidate| Selected {
                    message_seq: candidate.message_seq,
                    chunk_index: candidate.chunk_index,
                    similarity: 1.0 - candidate.distance,
                })
                .filter(|entry| entry.similarity >= SIMILARITY_FLOOR)
                .collect(),
            )),
            Arm::Lexical(filters) => Ok(ArmOutput::Sequences(
                RetrievalRepository::lexical_relevance(
                    connection,
                    &account_id,
                    &question,
                    LEXICAL_LIMIT,
                    &filters,
                )?,
            )),
            Arm::Chronological(filters) => Ok(ArmOutput::Sequences(
                RetrievalRepository::lexical_chronological(
                    connection,
                    &account_id,
                    &question,
                    CHRONOLOGICAL_LIMIT,
                    &filters,
                )?,
            )),
            Arm::Recency(filters, ascending) => {
                Ok(ArmOutput::Sequences(RetrievalRepository::recency(
                    connection,
                    &account_id,
                    RECENCY_LIMIT,
                    &filters,
                    ascending,
                )?))
            }
        })
        .await
        .map_err(storage_error)
}

async fn run_arms(
    storage: &Storage,
    account_id: &str,
    question: &str,
    arms: Vec<Arm>,
) -> Vec<Result<ArmOutput, String>> {
    let mut set = tokio::task::JoinSet::new();
    for (index, arm) in arms.into_iter().enumerate() {
        let storage = storage.clone();
        let account_id = account_id.to_owned();
        let question = question.to_owned();
        set.spawn(async move { (index, run_arm(storage, account_id, question, arm).await) });
    }
    let mut collected: Vec<(usize, Result<ArmOutput, String>)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(entry) = joined {
            collected.push(entry);
        }
    }
    collected.sort_by_key(|(index, _)| *index);
    collected.into_iter().map(|(_, result)| result).collect()
}

fn sequences(output: &ArmOutput) -> Vec<i64> {
    match output {
        ArmOutput::Sequences(entries) => entries.clone(),
        ArmOutput::Passages(entries) => {
            let mut ordered: Vec<i64> = Vec::new();
            for entry in entries {
                if !ordered.contains(&entry.message_seq) {
                    ordered.push(entry.message_seq);
                }
            }
            ordered
        }
    }
}

fn split(outcomes: Vec<Result<ArmOutput, String>>) -> (Vec<ArmOutput>, Option<String>) {
    let mut outputs = Vec::new();
    let mut failure = None;
    for outcome in outcomes {
        match outcome {
            Ok(output) => outputs.push(output),
            Err(error) => failure = failure.or(Some(error)),
        }
    }
    (outputs, failure)
}

fn scored(outputs: &[ArmOutput]) -> Vec<Selected> {
    outputs
        .iter()
        .filter_map(|output| match output {
            ArmOutput::Passages(entries) => Some(entries.clone()),
            ArmOutput::Sequences(_) => None,
        })
        .flatten()
        .collect()
}

fn assemble(selected: &[Selected], sources: &[PassageSource]) -> Vec<Passage> {
    let chunked: Vec<(i64, Vec<String>)> = sources
        .iter()
        .map(|source| {
            (
                source.message_seq,
                chunker::chunks(
                    &source.sender,
                    &source.recipients,
                    &source.subject,
                    source.truncated_body.as_deref(),
                    source.plain_body.as_deref(),
                    source.html_body.as_deref(),
                ),
            )
        })
        .collect();
    selected
        .iter()
        .filter_map(|entry| {
            let source = sources
                .iter()
                .find(|source| source.message_seq == entry.message_seq)?;
            let chunks = &chunked
                .iter()
                .find(|(message_seq, _)| *message_seq == entry.message_seq)?
                .1;
            let index = usize::try_from(entry.chunk_index).ok()?;
            let raw = chunks.get(index)?;
            let body = if index == 0 {
                raw.split_once("\n\n")
                    .map_or(raw.as_str(), |(_, rest)| rest)
            } else {
                raw.as_str()
            };
            Some(Passage {
                message_seq: entry.message_seq,
                chunk_index: entry.chunk_index,
                similarity: entry.similarity,
                sent_at: source.sent_at,
                sender: source.sender.clone(),
                recipients: source.recipients.clone(),
                subject: source.subject.clone(),
                text: body.to_owned(),
                has_attachments: source.has_attachments,
                attachment_count: source.attachment_count,
                is_starred: source.is_starred,
                is_unread: source.is_unread,
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

async fn unfiltered_pass(
    provider: &Provider,
    storage: &Storage,
    request: &RetrievalRequest<'_>,
) -> Result<(Vec<f32>, Vec<Result<ArmOutput, String>>), String> {
    let (embedded, lexical) = futures_util::future::join(
        provider.embed(request.embedding_model, vec![request.question.to_owned()]),
        run_arms(
            storage,
            request.account_id,
            request.question,
            vec![Arm::Lexical(RetrievalFilters::default())],
        ),
    )
    .await;
    let vectors = embedded.map_err(|error| error.to_string())?;
    let Some(vector) = vectors.into_iter().next() else {
        return Err("Provider returned an incomplete embedding batch".to_owned());
    };
    let mut outputs = run_arms(
        storage,
        request.account_id,
        request.question,
        vec![Arm::Vector(vector.clone(), RetrievalFilters::default())],
    )
    .await;
    outputs.extend(lexical);
    Ok((vector, outputs))
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
    let (base, plan) = futures_util::future::join(
        unfiltered_pass(provider, storage, request),
        planner::plan(provider, request, &folders),
    )
    .await;
    let (vector, outcomes) = base?;
    if cancelled(cancel) {
        return Ok(Retrieval::Cancelled);
    }
    let query = plan.query.as_deref().unwrap_or(request.question);
    let contextual = plan.query.is_some();
    let planned_vector = if contextual {
        provider
            .embed(request.embedding_model, vec![query.to_owned()])
            .await
            .ok()
            .and_then(|vectors| vectors.into_iter().next())
    } else {
        Some(vector)
    };
    if cancelled(cancel) {
        return Ok(Retrieval::Cancelled);
    }
    let constrained = !plan.filters.is_empty();
    let mut extra: Vec<Arm> = Vec::new();
    if constrained || contextual {
        if let Some(vector) = planned_vector {
            extra.push(Arm::Vector(vector, plan.filters.clone()));
        }
        extra.push(Arm::Lexical(plan.filters.clone()));
    }
    if constrained {
        extra.push(Arm::Recency(plan.filters.clone(), plan.ascending));
    }
    if plan.ascending {
        extra.push(Arm::Chronological(plan.filters.clone()));
    }
    let mut narrowed: Vec<Result<ArmOutput, String>> = Vec::new();
    if !extra.is_empty() {
        narrowed = run_arms(storage, request.account_id, query, extra).await;
        if cancelled(cancel) {
            return Ok(Retrieval::Cancelled);
        }
    }
    let (unfiltered, unfiltered_failure) = split(outcomes);
    let (filtered, filtered_failure) = split(narrowed);
    let outputs = if (constrained || contextual)
        && filtered.iter().any(|output| !sequences(output).is_empty())
    {
        filtered
    } else {
        unfiltered.into_iter().chain(filtered).collect()
    };
    if let (true, Some(error)) = (outputs.is_empty(), unfiltered_failure.or(filtered_failure)) {
        return Err(error);
    }
    let arms: Vec<Vec<i64>> = outputs.iter().map(sequences).collect();
    let order = fusion::fuse(&arms);
    let selected = fusion::select(&order, &scored(&outputs), PASSAGE_LIMIT);
    let wanted: Vec<i64> = selected.iter().map(|entry| entry.message_seq).collect();
    let account = request.account_id.to_owned();
    let sources = storage
        .run(move |connection| RetrievalRepository::sources(connection, &account, &wanted))
        .await
        .map_err(storage_error)?;
    let passages = assemble(&selected, &sources);
    if cancelled(cancel) {
        return Ok(Retrieval::Cancelled);
    }
    if passages.is_empty() {
        return Ok(Retrieval::Empty);
    }
    Ok(Retrieval::Found(Box::new(Retrieved {
        sources: cited_sources(&passages, &sources),
        context: prompts::passage_block(&passages),
        passages,
    })))
}
