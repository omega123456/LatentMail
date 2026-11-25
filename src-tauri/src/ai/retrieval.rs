use std::sync::atomic::{AtomicBool, Ordering};

use crate::{
    ai::{
        chunker::{self, ChunkMessage},
        fusion::{self, Selected},
        planner, prompts,
        provider::Provider,
    },
    storage::{
        CandidateQuery, LexicalQuery, PassageSource, RecencyQuery, RetrievalFilters,
        RetrievalRepository, Storage, StorageError,
    },
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

pub struct RetrieveContext<'a> {
    pub provider: &'a Provider,
    pub storage: &'a Storage,
    pub cancel: &'a AtomicBool,
}

struct ArmTarget<'a> {
    storage: &'a Storage,
    account_id: &'a str,
    question: &'a str,
}

struct OwnedArmTarget {
    storage: Storage,
    account_id: String,
    question: String,
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

struct SplitArms {
    outputs: Vec<ArmOutput>,
    failure: Option<String>,
}

struct UnfilteredPass {
    vector: Vec<f32>,
    outcomes: Vec<Result<ArmOutput, String>>,
}

struct PlannedVectorInput<'a> {
    embedding_model: &'a str,
    query: &'a str,
    contextual: bool,
    fallback: Vec<f32>,
}

fn storage_error(error: StorageError) -> String {
    error.to_string()
}

fn cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::SeqCst)
}

struct ArmQuery<'a> {
    account_id: &'a str,
    question: &'a str,
}

struct VectorArmInput<'a> {
    account_id: &'a str,
    vector: &'a [f32],
    filters: &'a RetrievalFilters,
}

fn run_vector_arm(
    connection: &rusqlite::Connection,
    input: VectorArmInput<'_>,
) -> Result<ArmOutput, rusqlite::Error> {
    let passages = RetrievalRepository::candidates(
        connection,
        &CandidateQuery {
            account_id: input.account_id,
            vector: input.vector,
            limit: CANDIDATE_BUDGET,
            filters: input.filters,
        },
    )?
    .into_iter()
    .map(|candidate| Selected {
        message_seq: candidate.message_seq,
        chunk_index: candidate.chunk_index,
        similarity: 1.0 - candidate.distance,
    })
    .filter(|entry| entry.similarity >= SIMILARITY_FLOOR)
    .collect();
    Ok(ArmOutput::Passages(passages))
}

fn execute_arm(
    connection: &rusqlite::Connection,
    target: &ArmQuery<'_>,
    arm: Arm,
) -> Result<ArmOutput, rusqlite::Error> {
    match arm {
        Arm::Vector(vector, filters) => run_vector_arm(
            connection,
            VectorArmInput {
                account_id: target.account_id,
                vector: &vector,
                filters: &filters,
            },
        ),
        Arm::Lexical(filters) => Ok(ArmOutput::Sequences(
            RetrievalRepository::lexical_relevance(
                connection,
                &LexicalQuery {
                    account_id: target.account_id,
                    question: target.question,
                    limit: LEXICAL_LIMIT,
                    filters: &filters,
                },
            )?,
        )),
        Arm::Chronological(filters) => Ok(ArmOutput::Sequences(
            RetrievalRepository::lexical_chronological(
                connection,
                &LexicalQuery {
                    account_id: target.account_id,
                    question: target.question,
                    limit: CHRONOLOGICAL_LIMIT,
                    filters: &filters,
                },
            )?,
        )),
        Arm::Recency(filters, ascending) => Ok(ArmOutput::Sequences(RetrievalRepository::recency(
            connection,
            &RecencyQuery {
                account_id: target.account_id,
                limit: RECENCY_LIMIT,
                filters: &filters,
                ascending: ascending,
            },
        )?)),
    }
}

async fn run_arm(target: OwnedArmTarget, arm: Arm) -> Result<ArmOutput, String> {
    let OwnedArmTarget {
        storage,
        account_id,
        question,
    } = target;
    storage
        .run(move |connection| {
            execute_arm(
                connection,
                &ArmQuery {
                    account_id: &account_id,
                    question: &question,
                },
                arm,
            )
        })
        .await
        .map_err(storage_error)
}

async fn run_arms(target: ArmTarget<'_>, arms: Vec<Arm>) -> Vec<Result<ArmOutput, String>> {
    let mut set = tokio::task::JoinSet::new();
    for (index, arm) in arms.into_iter().enumerate() {
        let owned = OwnedArmTarget {
            storage: target.storage.clone(),
            account_id: target.account_id.to_owned(),
            question: target.question.to_owned(),
        };
        set.spawn(async move { (index, run_arm(owned, arm).await) });
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

fn unique_passage_sequences(entries: &[Selected]) -> Vec<i64> {
    let mut ordered: Vec<i64> = Vec::new();
    for entry in entries {
        if !ordered.contains(&entry.message_seq) {
            ordered.push(entry.message_seq);
        }
    }
    ordered
}

fn sequences(output: &ArmOutput) -> Vec<i64> {
    match output {
        ArmOutput::Sequences(entries) => entries.clone(),
        ArmOutput::Passages(entries) => unique_passage_sequences(entries),
    }
}

fn split(outcomes: Vec<Result<ArmOutput, String>>) -> SplitArms {
    let mut outputs = Vec::new();
    let mut failure = None;
    for outcome in outcomes {
        match outcome {
            Ok(output) => outputs.push(output),
            Err(error) => failure = failure.or(Some(error)),
        }
    }
    SplitArms {
        outputs: outputs,
        failure: failure,
    }
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

fn passage_body(chunk_index: usize, raw: &str) -> &str {
    if chunk_index == 0 {
        return raw.split_once("\n\n").map_or(raw, |(_, rest)| rest);
    }
    raw
}

fn assemble(selected: &[Selected], sources: &[PassageSource]) -> Vec<Passage> {
    let chunked: Vec<(i64, Vec<String>)> = sources
        .iter()
        .map(|source| {
            (
                source.message_seq,
                chunker::chunks(&ChunkMessage {
                    sender: &source.sender,
                    recipients: &source.recipients,
                    subject: &source.subject,
                    truncated_body: source.truncated_body.as_deref(),
                    plain_body: source.plain_body.as_deref(),
                    html_body: source.html_body.as_deref(),
                }),
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
            let body = passage_body(index, raw);
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
) -> Result<UnfilteredPass, String> {
    let target = ArmTarget {
        storage: storage,
        account_id: request.account_id,
        question: request.question,
    };
    let (embedded, lexical) = futures_util::future::join(
        provider.embed(request.embedding_model, vec![request.question.to_owned()]),
        run_arms(
            ArmTarget {
                storage: target.storage,
                account_id: target.account_id,
                question: target.question,
            },
            vec![Arm::Lexical(RetrievalFilters::default())],
        ),
    )
    .await;
    let vectors = embedded.map_err(|error| error.to_string())?;
    let Some(vector) = vectors.into_iter().next() else {
        return Err("Provider returned an incomplete embedding batch".to_owned());
    };
    let mut outputs = run_arms(
        target,
        vec![Arm::Vector(vector.clone(), RetrievalFilters::default())],
    )
    .await;
    outputs.extend(lexical);
    Ok(UnfilteredPass {
        vector: vector,
        outcomes: outputs,
    })
}

async fn resolve_planned_vector(
    provider: &Provider,
    input: PlannedVectorInput<'_>,
) -> Option<Vec<f32>> {
    if !input.contextual {
        return Some(input.fallback);
    }
    provider
        .embed(input.embedding_model, vec![input.query.to_owned()])
        .await
        .ok()
        .and_then(|vectors| vectors.into_iter().next())
}

fn select_outputs(
    unfiltered: Vec<ArmOutput>,
    filtered: Vec<ArmOutput>,
    prefer_filtered: bool,
) -> Vec<ArmOutput> {
    let has_filtered_hits = filtered.iter().any(|output| !sequences(output).is_empty());
    if prefer_filtered && has_filtered_hits {
        return filtered;
    }
    unfiltered.into_iter().chain(filtered).collect()
}

struct PlannedArmsInput<'a> {
    filters: &'a RetrievalFilters,
    ascending: bool,
    planned_vector: Option<Vec<f32>>,
    prefer_filtered: bool,
}

fn build_planned_arms(input: PlannedArmsInput<'_>) -> Vec<Arm> {
    let mut extra: Vec<Arm> = Vec::new();
    if input.prefer_filtered {
        if let Some(vector) = input.planned_vector {
            extra.push(Arm::Vector(vector, input.filters.clone()));
        }
        extra.push(Arm::Lexical(input.filters.clone()));
    }
    if !input.filters.is_empty() {
        extra.push(Arm::Recency(input.filters.clone(), input.ascending));
    }
    if input.ascending {
        extra.push(Arm::Chronological(input.filters.clone()));
    }
    extra
}

async fn finalize_retrieval(
    context: RetrieveContext<'_>,
    account_id: &str,
    outputs: Vec<ArmOutput>,
) -> Result<Retrieval, String> {
    let arms: Vec<Vec<i64>> = outputs.iter().map(sequences).collect();
    let order = fusion::fuse(&arms);
    let selected = fusion::select(&order, &scored(&outputs), PASSAGE_LIMIT);
    let wanted: Vec<i64> = selected.iter().map(|entry| entry.message_seq).collect();
    let account = account_id.to_owned();
    let sources = context
        .storage
        .run(move |connection| RetrievalRepository::sources(connection, &account, &wanted))
        .await
        .map_err(storage_error)?;
    let passages = assemble(&selected, &sources);
    if cancelled(context.cancel) {
        return Ok(Retrieval::Cancelled);
    }
    if passages.is_empty() {
        return Ok(Retrieval::Empty);
    }
    Ok(Retrieval::Found(Box::new(Retrieved {
        sources: cited_sources(&passages, &sources),
        context: prompts::passage_block(&passages),
        passages: passages,
    })))
}

async fn load_folder_names(storage: &Storage, account_id: &str) -> Result<Vec<String>, String> {
    let account = account_id.to_owned();
    storage
        .run(move |connection| RetrievalRepository::folder_names(connection, &account))
        .await
        .map_err(storage_error)
}

fn merge_arm_outcomes(
    base_outcomes: Vec<Result<ArmOutput, String>>,
    narrowed_outcomes: Vec<Result<ArmOutput, String>>,
    prefer_filtered: bool,
) -> Result<Vec<ArmOutput>, String> {
    let unfiltered = split(base_outcomes);
    let filtered = split(narrowed_outcomes);
    let outputs = select_outputs(unfiltered.outputs, filtered.outputs, prefer_filtered);
    if let (true, Some(error)) = (outputs.is_empty(), unfiltered.failure.or(filtered.failure)) {
        return Err(error);
    }
    Ok(outputs)
}

pub async fn retrieve(
    context: RetrieveContext<'_>,
    request: &RetrievalRequest<'_>,
) -> Result<Retrieval, String> {
    let folders = load_folder_names(context.storage, request.account_id).await?;
    if cancelled(context.cancel) {
        return Ok(Retrieval::Cancelled);
    }
    let (base, plan) = futures_util::future::join(
        unfiltered_pass(context.provider, context.storage, request),
        planner::plan(context.provider, request, &folders),
    )
    .await;
    let base = base?;
    if cancelled(context.cancel) {
        return Ok(Retrieval::Cancelled);
    }
    let query = plan.query.as_deref().unwrap_or(request.question);
    let contextual = plan.query.is_some();
    let planned_vector = resolve_planned_vector(
        context.provider,
        PlannedVectorInput {
            embedding_model: request.embedding_model,
            query: query,
            contextual: contextual,
            fallback: base.vector,
        },
    )
    .await;
    if cancelled(context.cancel) {
        return Ok(Retrieval::Cancelled);
    }
    let prefer_filtered = !plan.filters.is_empty() || contextual;
    let extra = build_planned_arms(PlannedArmsInput {
        filters: &plan.filters,
        ascending: plan.ascending,
        planned_vector: planned_vector,
        prefer_filtered: prefer_filtered,
    });
    let mut narrowed: Vec<Result<ArmOutput, String>> = Vec::new();
    if !extra.is_empty() {
        narrowed = run_arms(
            ArmTarget {
                storage: context.storage,
                account_id: request.account_id,
                question: query,
            },
            extra,
        )
        .await;
        if cancelled(context.cancel) {
            return Ok(Retrieval::Cancelled);
        }
    }
    let outputs = merge_arm_outcomes(base.outcomes, narrowed, prefer_filtered)?;
    finalize_retrieval(context, request.account_id, outputs).await
}
