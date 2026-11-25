use crate::{
    attachments::AttachmentCache,
    contacts,
    gmail::{GmailClient, GmailLabel, ListOptions, MessageListQuery, MAX_PAGE_SIZE},
    queue::QueueEngine,
    storage::{
        addresses::split_addresses, reconcile_staging::ReconcileStagingRepository, MessageKey,
        MessageRepository, StagedIds, StagedLabelIds, Storage, ThreadRepository, TraversalCursor,
        TraversalCursorRepository, TraversalKind,
    },
};

use super::{
    to_millis,
    traversal::{self, FetchPersistRequest},
    EventSink, FullSyncOutcome, LabelSyncTarget, SyncError, TraversalState,
};

enum Phase {
    Universe(Option<String>),
    Label(String, Option<String>),
    Fetch(Option<String>),
}

struct ParsedPhase {
    candidate: i64,
    phase: Phase,
}

impl Phase {
    fn parse(position: Option<&str>) -> Option<ParsedPhase> {
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
        Some(ParsedPhase {
            candidate: candidate,
            phase: phase,
        })
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

pub struct ReconciliationContext<'a> {
    pub storage: &'a Storage,
    pub client: &'a GmailClient,
    pub account_id: &'a str,
    pub events: &'a EventSink,
    pub queue: Option<&'a QueueEngine>,
    pub cache: Option<AttachmentCache>,
}

pub struct ReconciliationRun<'a> {
    context: ReconciliationContext<'a>,
    candidate: i64,
    phase: Phase,
    state: TraversalCursor,
    resumed: bool,
    labels: Vec<GmailLabel>,
    options: ListOptions,
}

impl<'a> ReconciliationRun<'a> {
    async fn start(context: ReconciliationContext<'a>) -> Result<Self, SyncError> {
        let saved = context
            .storage
            .run({
                let account_id = context.account_id.to_owned();
                move |connection| {
                    ReconcileStagingRepository::reconciliation_cursor(connection, &account_id)
                }
            })
            .await?;
        let parsed = saved.as_ref().and_then(|cursor| {
            (!cursor.completed)
                .then(|| Phase::parse(cursor.position.as_deref()))
                .flatten()
        });
        let (candidate, phase, mut state, resumed) = match parsed {
            Some(parsed) => (
                parsed.candidate,
                parsed.phase,
                saved.clone().expect("saved cursor"),
                true,
            ),
            None => {
                let candidate = context.client.profile().await?.history_id;
                let cursor = initial_cursor(context.account_id, candidate);
                let persisted = cursor.clone();
                context
                    .storage
                    .run(move |connection| {
                        ReconcileStagingRepository::begin(connection, &persisted)
                    })
                    .await?;
                (candidate, Phase::Universe(None), cursor, false)
            }
        };
        let labels = context.client.labels().await?;
        state.resumed = resumed;
        Ok(Self {
            context: context,
            candidate: candidate,
            phase: phase,
            state: state,
            resumed: resumed,
            labels: labels,
            options: ListOptions {
                include_spam_and_trash: true,
                page_size: MAX_PAGE_SIZE,
            },
        })
    }

    async fn execute(mut self) -> Result<FullSyncOutcome, SyncError> {
        loop {
            if let Some(queue) = self.context.queue {
                queue.wait_until_resumed().await;
            }
            let phase = std::mem::replace(&mut self.phase, Phase::Fetch(None));
            let next_phase = match phase {
                Phase::Universe(token) => Some(self.step_universe(token).await?),
                Phase::Label(label_id, token) => Some(self.step_label(label_id, token).await?),
                Phase::Fetch(after) => self.step_fetch(after).await?,
            };
            let Some(next_phase) = next_phase else {
                break;
            };
            self.phase = next_phase;
        }
        self.finalize().await
    }

    async fn step_universe(&mut self, token: Option<String>) -> Result<Phase, SyncError> {
        let page = self
            .context
            .client
            .list_messages_page_matching(MessageListQuery {
                label_ids: &[],
                query_filter: None,
                page_token: token.as_deref(),
                options: self.options,
            })
            .await?;
        self.state.discovered_count += page.items.len() as i64;
        let next_phase = match page.next_page_token {
            Some(token) => Phase::Universe(Some(token)),
            None => first_label(&self.labels).unwrap_or(Phase::Fetch(None)),
        };
        self.advance_position(&next_phase);
        let ids = page.items.into_iter().map(|item| item.id).collect();
        self.stage_universe(ids).await?;
        self.emit(false);
        Ok(next_phase)
    }

    async fn step_label(
        &mut self,
        label_id: String,
        token: Option<String>,
    ) -> Result<Phase, SyncError> {
        let page = self
            .context
            .client
            .list_messages_page_matching(MessageListQuery {
                label_ids: std::slice::from_ref(&label_id),
                query_filter: None,
                page_token: token.as_deref(),
                options: self.options,
            })
            .await?;
        let next_phase = match page.next_page_token {
            Some(token) => Phase::Label(label_id.clone(), Some(token)),
            None => label_after(&self.labels, &label_id).unwrap_or(Phase::Fetch(None)),
        };
        self.advance_position(&next_phase);
        let ids = page.items.into_iter().map(|item| item.id).collect();
        self.stage_label(label_id, ids).await?;
        self.emit(false);
        Ok(next_phase)
    }

    async fn step_fetch(&mut self, after: Option<String>) -> Result<Option<Phase>, SyncError> {
        let ids = self
            .context
            .storage
            .run({
                let account_id = self.context.account_id.to_owned();
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
            return Ok(None);
        }
        traversal::fetch_and_persist(FetchPersistRequest {
            storage: self.context.storage,
            client: self.context.client,
            account_id: self.context.account_id,
            ids: &ids,
            cache: self.context.cache.clone(),
        })
        .await?;
        self.state.persisted_count += ids.len() as i64;
        let next_phase = Phase::Fetch(ids.last().cloned());
        self.advance_position(&next_phase);
        checkpoint(self.context.storage, self.state.clone()).await?;
        self.emit(false);
        Ok(Some(next_phase))
    }

    async fn finalize(mut self) -> Result<FullSyncOutcome, SyncError> {
        apply_labels(self.context.storage, self.context.account_id, &self.labels).await?;
        apply_absent(self.context.storage, self.context.account_id).await?;
        apply_memberships(self.context.storage, self.context.account_id).await?;
        observe_contacts(self.context.storage, self.context.account_id).await?;
        let completed_at = chrono::Utc::now().timestamp();
        let added_count = self.state.persisted_count.max(0) as u32;
        self.context
            .storage
            .run({
                let account_id = self.context.account_id.to_owned();
                let state = self.state.clone();
                let resumed = self.resumed;
                move |connection| {
                    let transaction = connection.unchecked_transaction()?;
                    ReconcileStagingRepository::clear(&transaction, &account_id)?;
                    TraversalCursorRepository::upsert(
                        &transaction,
                        &TraversalCursor {
                            account_id: account_id,
                            kind: TraversalKind::Reconciliation,
                            position: None,
                            discovered_count: state.discovered_count,
                            persisted_count: state.persisted_count,
                            completed: true,
                            last_advanced_at: completed_at,
                            resumed: resumed,
                        },
                    )?;
                    transaction.commit()
                }
            })
            .await?;
        self.state.completed = true;
        self.state.last_advanced_at = completed_at;
        self.emit(true);
        Ok(FullSyncOutcome {
            history_id: self.candidate,
            added_count: added_count,
            thread_ids: Vec::new(),
            changed: true,
            arrivals: Vec::new(),
        })
    }

    fn advance_position(&mut self, next_phase: &Phase) {
        self.state.position = Some(next_phase.position(self.candidate));
        self.state.last_advanced_at = chrono::Utc::now().timestamp();
    }

    async fn stage_universe(&self, ids: Vec<String>) -> Result<(), SyncError> {
        let account_id = self.context.account_id.to_owned();
        let state = self.state.clone();
        self.context
            .storage
            .run(move |connection| {
                ReconcileStagingRepository::stage_universe_page(
                    connection,
                    StagedIds {
                        account_id: &account_id,
                        ids: &ids,
                    },
                    &state,
                )
            })
            .await?;
        Ok(())
    }

    async fn stage_label(&self, label_id: String, ids: Vec<String>) -> Result<(), SyncError> {
        let account_id = self.context.account_id.to_owned();
        let state = self.state.clone();
        self.context
            .storage
            .run(move |connection| {
                ReconcileStagingRepository::stage_label_page(
                    connection,
                    StagedLabelIds {
                        account_id: &account_id,
                        label_id: &label_id,
                        ids: &ids,
                    },
                    &state,
                )
            })
            .await?;
        Ok(())
    }

    fn emit(&self, completed: bool) {
        traversal::emit_traversal_progress(
            self.context.events,
            traversal::TraversalProgressEvent {
                account_id: self.context.account_id.to_owned(),
                kind: "reconciliation",
                discovered_count: self.state.discovered_count,
                persisted_count: self.state.persisted_count,
                completed: completed,
                state: reconciliation_state(completed),
                last_advanced_at: to_millis(self.state.last_advanced_at),
                is_resumed: self.state.resumed,
            },
        );
    }
}

pub async fn run(context: ReconciliationContext<'_>) -> Result<FullSyncOutcome, SyncError> {
    ReconciliationRun::start(context).await?.execute().await
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

fn initial_cursor(account_id: &str, candidate: i64) -> TraversalCursor {
    TraversalCursor {
        account_id: account_id.to_owned(),
        kind: TraversalKind::Reconciliation,
        position: Some(Phase::Universe(None).position(candidate)),
        discovered_count: 0,
        persisted_count: 0,
        completed: false,
        last_advanced_at: chrono::Utc::now().timestamp(),
        resumed: false,
    }
}

async fn checkpoint(storage: &Storage, state: TraversalCursor) -> Result<(), SyncError> {
    storage
        .run(move |connection| TraversalCursorRepository::upsert(connection, &state))
        .await?;
    Ok(())
}

fn reconciliation_state(completed: bool) -> TraversalState {
    if completed {
        return TraversalState::Complete;
    }
    TraversalState::Reconciling
}

async fn apply_labels(
    storage: &Storage,
    account_id: &str,
    labels: &[GmailLabel],
) -> Result<(), SyncError> {
    let labels = labels.to_vec();
    let account_id = account_id.to_owned();
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let mut touched = std::collections::HashSet::new();
            super::sync_labels(
                &transaction,
                LabelSyncTarget {
                    account_id: &account_id,
                    gmail_labels: &labels,
                },
                &mut touched,
            )?;
            ThreadRepository::recompute_many(&transaction, &account_id, &touched)?;
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
                for id in ids {
                    if let Some(thread_id) =
                        MessageRepository::delete(&transaction, &account_id, &id)?
                    {
                        threads.insert(thread_id);
                    }
                }
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
                for id in ids {
                    let Some(message) =
                        MessageRepository::reconciliation_message(&transaction, &account_id, &id)?
                    else {
                        continue;
                    };
                    let labels = ReconcileStagingRepository::labels_for_message(
                        &transaction,
                        &account_id,
                        &id,
                    )?;
                    MessageRepository::overwrite_membership(
                        &transaction,
                        MessageKey {
                            account_id: &account_id,
                            message_id: &id,
                        },
                        &labels,
                    )?;
                    threads.insert(message.thread_id);
                }
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
                for id in ids {
                    let Some(message) =
                        MessageRepository::reconciliation_message(&transaction, &account_id, &id)?
                    else {
                        continue;
                    };
                    observations.push((message.sender, message.sent_at));
                    if message.label_ids.iter().any(|label| label == "SENT") {
                        for address in split_addresses(&message.to_recipients)
                            .into_iter()
                            .chain(split_addresses(&message.cc_recipients))
                        {
                            observations.push((address, message.sent_at));
                        }
                    }
                }
                contacts::observe_many(&transaction, &account_id, &observations)?;
                transaction.commit()
            })
            .await?;
    }
}
