use crate::{
    attachments::AttachmentCache,
    contacts,
    gmail::{GmailClient, GmailLabel, ListOptions, MAX_PAGE_SIZE},
    queue::QueueEngine,
    storage::{
        reconcile_staging::ReconcileStagingRepository, Label, LabelRepository, MessageRepository,
        Storage, ThreadRepository, TraversalCursor, TraversalCursorRepository, TraversalKind,
    },
};

use super::{
    to_label, to_millis, traversal, EventSink, FullSyncOutcome, SyncError, TraversalState,
};

enum Phase {
    Universe(Option<String>),
    Label(String, Option<String>),
    Fetch(Option<String>),
}

impl Phase {
    fn parse(position: Option<&str>) -> Option<(i64, Self)> {
        let mut fields = position?.splitn(4, '|');
        let candidate = fields.next()?.parse().ok()?;
        let phase = match fields.next()? {
            "universe" => Self::Universe(
                fields
                    .next()
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned),
            ),
            "label" => Self::Label(
                fields.next()?.to_owned(),
                fields
                    .next()
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned),
            ),
            "fetch" => Self::Fetch(
                fields
                    .next()
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned),
            ),
            _ => return None,
        };
        Some((candidate, phase))
    }
    fn position(&self, candidate: i64) -> String {
        match self {
            Self::Universe(token) => format!(
                "{candidate}|universe|{}",
                token.as_deref().unwrap_or_default()
            ),
            Self::Label(label, token) => format!(
                "{candidate}|label|{label}|{}",
                token.as_deref().unwrap_or_default()
            ),
            Self::Fetch(cursor) => format!(
                "{candidate}|fetch|{}",
                cursor.as_deref().unwrap_or_default()
            ),
        }
    }
}

pub async fn run(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
    events: &EventSink,
    queue: Option<&QueueEngine>,
    cache: Option<AttachmentCache>,
) -> Result<FullSyncOutcome, SyncError> {
    let saved = storage
        .run({
            let account_id = account_id.to_owned();
            move |connection| {
                ReconcileStagingRepository::reconciliation_cursor(connection, &account_id)
            }
        })
        .await?;
    let (candidate, mut phase, mut state, resumed) = match saved.as_ref().and_then(|cursor| {
        (!cursor.completed)
            .then(|| Phase::parse(cursor.position.as_deref()))
            .flatten()
    }) {
        Some((candidate, phase)) => (candidate, phase, saved.clone().expect("saved cursor"), true),
        None => {
            let candidate = client.profile().await?.history_id;
            let cursor = cursor(
                account_id,
                Phase::Universe(None),
                candidate,
                0,
                0,
                false,
                false,
            );
            let persisted = cursor.clone();
            storage
                .run(move |connection| ReconcileStagingRepository::begin(connection, &persisted))
                .await?;
            (candidate, Phase::Universe(None), cursor, false)
        }
    };
    let labels = client.labels().await?;
    let options = ListOptions {
        include_spam_and_trash: true,
        page_size: MAX_PAGE_SIZE,
    };
    state.resumed = resumed;
    loop {
        if let Some(queue) = queue {
            queue.wait_until_resumed().await;
        }
        match &mut phase {
            Phase::Universe(token) => {
                let page = client
                    .list_messages_page_matching(&[], None, token.as_deref(), options)
                    .await?;
                state.discovered_count += page.items.len() as i64;
                let next = page.next_page_token.clone();
                let next_phase = if next.is_some() {
                    Phase::Universe(next)
                } else {
                    first_label(&labels).unwrap_or(Phase::Fetch(None))
                };
                state.position = Some(next_phase.position(candidate));
                state.last_advanced_at = chrono::Utc::now().timestamp();
                let ids = page.items.into_iter().map(|item| item.id).collect();
                stage_universe(storage, account_id, ids, state.clone()).await?;
                emit(events, account_id, &state, false);
                phase = next_phase;
            }
            Phase::Label(label_id, token) => {
                let page = client
                    .list_messages_page_matching(
                        std::slice::from_ref(label_id),
                        None,
                        token.as_deref(),
                        options,
                    )
                    .await?;
                let next = page.next_page_token.clone();
                let next_phase = if next.is_some() {
                    Phase::Label(label_id.clone(), next)
                } else {
                    label_after(&labels, label_id).unwrap_or(Phase::Fetch(None))
                };
                state.position = Some(next_phase.position(candidate));
                state.last_advanced_at = chrono::Utc::now().timestamp();
                let ids = page.items.into_iter().map(|item| item.id).collect();
                stage_label(storage, account_id, label_id.clone(), ids, state.clone()).await?;
                emit(events, account_id, &state, false);
                phase = next_phase;
            }
            Phase::Fetch(after) => {
                let ids = storage
                    .run({
                        let account_id = account_id.to_owned();
                        let after = after.clone();
                        move |connection| {
                            ReconcileStagingRepository::new_message_ids(
                                connection,
                                &account_id,
                                after.as_deref(),
                            )
                        }
                    })
                    .await?;
                if ids.is_empty() {
                    break;
                }
                traversal::fetch_and_persist(storage, client, account_id, &ids, cache.clone())
                    .await?;
                state.persisted_count += ids.len() as i64;
                let next_phase = Phase::Fetch(ids.last().cloned());
                state.position = Some(next_phase.position(candidate));
                state.last_advanced_at = chrono::Utc::now().timestamp();
                checkpoint(storage, state.clone()).await?;
                emit(events, account_id, &state, false);
                phase = next_phase;
            }
        }
    }
    apply_labels(storage, account_id, &labels).await?;
    apply_absent(storage, account_id).await?;
    apply_memberships(storage, account_id).await?;
    observe_contacts(storage, account_id).await?;
    let completed_at = chrono::Utc::now().timestamp();
    let added_count = state.persisted_count.max(0) as u32;
    storage
        .run({
            let account_id = account_id.to_owned();
            let state = state.clone();
            move |connection| {
                let transaction = connection.unchecked_transaction()?;
                ReconcileStagingRepository::clear(&transaction, &account_id)?;
                TraversalCursorRepository::upsert(
                    &transaction,
                    &TraversalCursor {
                        account_id,
                        kind: TraversalKind::Reconciliation,
                        position: None,
                        discovered_count: state.discovered_count,
                        persisted_count: state.persisted_count,
                        completed: true,
                        last_advanced_at: completed_at,
                        resumed,
                    },
                )?;
                transaction.commit()
            }
        })
        .await?;
    state.completed = true;
    state.last_advanced_at = completed_at;
    emit(events, account_id, &state, true);
    Ok(FullSyncOutcome {
        history_id: candidate,
        added_count,
        thread_ids: Vec::new(),
        changed: true,
        arrivals: Vec::new(),
    })
}

fn first_label(labels: &[GmailLabel]) -> Option<Phase> {
    labels
        .first()
        .map(|label| Phase::Label(label.id.clone(), None))
}
fn label_after(labels: &[GmailLabel], id: &str) -> Option<Phase> {
    labels
        .iter()
        .position(|label| label.id == id)
        .and_then(|index| labels.get(index + 1))
        .map(|label| Phase::Label(label.id.clone(), None))
}
fn cursor(
    account_id: &str,
    phase: Phase,
    candidate: i64,
    discovered_count: i64,
    persisted_count: i64,
    completed: bool,
    resumed: bool,
) -> TraversalCursor {
    TraversalCursor {
        account_id: account_id.to_owned(),
        kind: TraversalKind::Reconciliation,
        position: Some(phase.position(candidate)),
        discovered_count,
        persisted_count,
        completed,
        last_advanced_at: chrono::Utc::now().timestamp(),
        resumed,
    }
}
async fn stage_universe(
    storage: &Storage,
    account_id: &str,
    ids: Vec<String>,
    state: TraversalCursor,
) -> Result<(), SyncError> {
    let account_id = account_id.to_owned();
    storage
        .run(move |connection| {
            ReconcileStagingRepository::stage_universe_page(connection, &account_id, &ids, &state)
        })
        .await?;
    Ok(())
}
async fn stage_label(
    storage: &Storage,
    account_id: &str,
    label_id: String,
    ids: Vec<String>,
    state: TraversalCursor,
) -> Result<(), SyncError> {
    let account_id = account_id.to_owned();
    storage
        .run(move |connection| {
            ReconcileStagingRepository::stage_label_page(
                connection,
                &account_id,
                &label_id,
                &ids,
                &state,
            )
        })
        .await?;
    Ok(())
}
async fn checkpoint(storage: &Storage, state: TraversalCursor) -> Result<(), SyncError> {
    storage
        .run(move |connection| TraversalCursorRepository::upsert(connection, &state))
        .await?;
    Ok(())
}
fn emit(events: &EventSink, account_id: &str, state: &TraversalCursor, completed: bool) {
    traversal::emit_traversal_progress(
        events,
        traversal::TraversalProgressEvent {
            account_id: account_id.to_owned(),
            kind: "reconciliation",
            discovered_count: state.discovered_count,
            persisted_count: state.persisted_count,
            completed,
            state: if completed {
                TraversalState::Complete
            } else {
                TraversalState::Reconciling
            },
            last_advanced_at: to_millis(state.last_advanced_at),
            is_resumed: state.resumed,
        },
    );
}

async fn apply_labels(
    storage: &Storage,
    account_id: &str,
    labels: &[GmailLabel],
) -> Result<(), SyncError> {
    let labels = labels
        .iter()
        .map(|label| to_label(account_id, label))
        .collect::<Vec<Label>>();
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            for label in &labels {
                LabelRepository::upsert(&transaction, label)?;
            }
            transaction.commit()
        })
        .await?;
    Ok(())
}

async fn apply_absent(storage: &Storage, account_id: &str) -> Result<(), SyncError> {
    let mut after = None;
    loop {
        let ids = storage
            .run({
                let account_id = account_id.to_owned();
                let after = after.clone();
                move |connection| {
                    ReconcileStagingRepository::absent_message_ids(
                        connection,
                        &account_id,
                        after.as_deref(),
                    )
                }
            })
            .await?;
        if ids.is_empty() {
            return Ok(());
        }
        after = ids.last().cloned();
        let account_id = account_id.to_owned();
        storage
            .run(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                let mut threads = std::collections::HashSet::new();
                let mut delete_statement = transaction.prepare_cached(
                    "DELETE FROM messages WHERE account_id=?1 AND id=?2 RETURNING thread_id",
                )?;
                for id in ids {
                    if let Some(thread_id) =
                        MessageRepository::delete_with(&mut delete_statement, &account_id, &id)?
                    {
                        threads.insert(thread_id);
                    }
                }
                drop(delete_statement);
                ThreadRepository::recompute_many(&transaction, &account_id, &threads)?;
                transaction.commit()
            })
            .await?;
    }
}

async fn apply_memberships(storage: &Storage, account_id: &str) -> Result<(), SyncError> {
    let mut after = None;
    loop {
        let ids = storage
            .run({
                let account_id = account_id.to_owned();
                let after = after.clone();
                move |connection| {
                    ReconcileStagingRepository::membership_message_ids(
                        connection,
                        &account_id,
                        after.as_deref(),
                    )
                }
            })
            .await?;
        if ids.is_empty() {
            return Ok(());
        }
        after = ids.last().cloned();
        let account_id = account_id.to_owned();
        storage
            .run(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                let mut threads = std::collections::HashSet::new();
                let mut message_statement = transaction.prepare_cached(
                    "SELECT thread_id,sender,sent_at,to_recipients,cc_recipients FROM messages WHERE account_id=?1 AND id=?2",
                )?;
                let mut message_labels_statement = transaction.prepare_cached(
                    "SELECT label_id FROM message_labels WHERE account_id=?1 AND message_id=?2 ORDER BY label_id",
                )?;
                let mut staged_labels_statement = transaction.prepare_cached(
                    "SELECT label_id FROM reconcile_remote_labels WHERE account_id=?1 AND message_id=?2 ORDER BY label_id",
                )?;
                let mut delete_membership_statement = transaction.prepare_cached(
                    "DELETE FROM message_labels WHERE account_id=?1 AND message_id=?2",
                )?;
                let mut insert_membership_statement = transaction.prepare_cached(
                    "INSERT OR IGNORE INTO message_labels (account_id,message_id,label_id) VALUES (?1,?2,?3)",
                )?;
                let mut flags_statement = transaction.prepare_cached(
                    "UPDATE messages SET is_unread=?1,is_starred=?2 WHERE account_id=?3 AND id=?4",
                )?;
                for id in ids {
                    if let Some(message) = MessageRepository::reconciliation_message_with(
                        &mut message_statement,
                        &mut message_labels_statement,
                        &account_id,
                        &id,
                    )?
                    {
                        let labels = ReconcileStagingRepository::labels_for_message_with(
                            &mut staged_labels_statement,
                            &account_id,
                            &id,
                        )?;
                        MessageRepository::overwrite_membership_with(
                            &mut delete_membership_statement,
                            &mut insert_membership_statement,
                            &mut flags_statement,
                            &account_id,
                            &id,
                            &labels,
                        )?;
                        threads.insert(message.thread_id);
                    }
                }
                drop(flags_statement);
                drop(insert_membership_statement);
                drop(delete_membership_statement);
                drop(staged_labels_statement);
                drop(message_labels_statement);
                drop(message_statement);
                ThreadRepository::recompute_many(&transaction, &account_id, &threads)?;
                transaction.commit()
            })
            .await?;
    }
}

async fn observe_contacts(storage: &Storage, account_id: &str) -> Result<(), SyncError> {
    let mut after = None;
    loop {
        let ids = storage
            .run({
                let account_id = account_id.to_owned();
                let after = after.clone();
                move |connection| {
                    ReconcileStagingRepository::remote_message_ids(
                        connection,
                        &account_id,
                        after.as_deref(),
                    )
                }
            })
            .await?;
        if ids.is_empty() {
            return Ok(());
        }
        after = ids.last().cloned();
        let account_id = account_id.to_owned();
        storage
            .run(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                let mut observations = Vec::new();
                let mut message_statement = transaction.prepare_cached(
                    "SELECT thread_id,sender,sent_at,to_recipients,cc_recipients FROM messages WHERE account_id=?1 AND id=?2",
                )?;
                let mut labels_statement = transaction.prepare_cached(
                    "SELECT label_id FROM message_labels WHERE account_id=?1 AND message_id=?2 ORDER BY label_id",
                )?;
                for id in ids {
                    if let Some(message) = MessageRepository::reconciliation_message_with(
                        &mut message_statement,
                        &mut labels_statement,
                        &account_id,
                        &id,
                    )?
                    {
                        observations.push((message.sender, message.sent_at));
                        if message.label_ids.iter().any(|label| label == "SENT") {
                            for address in message
                                .to_recipients
                                .split(',')
                                .chain(message.cc_recipients.split(','))
                                .map(str::trim)
                                .filter(|address| !address.is_empty())
                            {
                                observations.push((address.to_owned(), message.sent_at));
                            }
                        }
                    }
                }
                drop(labels_statement);
                drop(message_statement);
                contacts::observe_many(&transaction, &account_id, &observations)?;
                transaction.commit()
            })
            .await?;
    }
}
