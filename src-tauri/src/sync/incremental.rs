use std::collections::HashSet;

use super::events::MailArrival;
use super::full_sync::{
    compute_arrivals, fetch_unknown, probe_inbox, ArrivalWindow, SyncContext, UnknownFetch,
};
use super::labels::{sync_labels, LabelSyncTarget};
use super::persist::{write_message, WriteTarget};
use crate::sync::{concurrency, SyncError};
use crate::{
    gmail::{GmailClient, GmailError, GmailLabel, GmailMessage, HistoryPage, HistoryRecord},
    storage::{
        LabelMembershipChange, LabelRepository, MessageKey, MessageRepository, ThreadRepository,
    },
};

pub(super) enum IncrementalOutcome {
    Updated {
        history_id: i64,
        added_count: u32,
        thread_ids: Vec<String>,
        changed: bool,
        arrivals: Vec<MailArrival>,
    },
    Expired,
}

struct IncrementalCommit {
    account_id: String,
    cache: Option<crate::attachments::AttachmentCache>,
    now: chrono::DateTime<chrono::Utc>,
    added_messages: Vec<GmailMessage>,
    records: Vec<HistoryRecord>,
    gmail_labels: Vec<GmailLabel>,
}

struct HistoryApplyTarget<'a> {
    account_id: &'a str,
    touched: &'a mut HashSet<String>,
}

async fn fetch_history_page(
    client: &GmailClient,
    start_history_id: i64,
    page_token: Option<&str>,
) -> Result<Option<HistoryPage>, SyncError> {
    match client.history_page(start_history_id, page_token).await {
        Ok(page) => Ok(Some(page)),
        Err(GmailError::HistoryExpired) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn append_history_page(records: &mut Vec<HistoryRecord>, page: HistoryPage) -> Option<String> {
    records.extend(page.records);
    page.next_page_token
}

async fn fetch_history_records(
    client: &GmailClient,
    start_history_id: i64,
) -> Result<Option<Vec<HistoryRecord>>, SyncError> {
    let Some(first) = fetch_history_page(client, start_history_id, None).await? else {
        return Ok(None);
    };
    let mut records = first.records;
    let mut next_token = first.next_page_token;
    while let Some(token) = next_token {
        next_token = match fetch_history_page(client, start_history_id, Some(&token)).await? {
            Some(page) => append_history_page(&mut records, page),
            None => return Ok(None),
        };
    }
    Ok(Some(records))
}

async fn collect_added_messages(
    context: &SyncContext<'_>,
    start_history_id: i64,
    records: &[HistoryRecord],
) -> Result<Vec<GmailMessage>, SyncError> {
    let final_history_id = records
        .iter()
        .map(|record| record.id)
        .max()
        .unwrap_or(start_history_id);
    let mut added_messages = concurrency::fetch_messages(
        context.client,
        records
            .iter()
            .flat_map(|record| {
                record
                    .messages_added
                    .iter()
                    .map(|reference| reference.id.clone())
            })
            .collect(),
    )
    .await?;
    tracing::info!(
        target: "sync",
        "{}: history {start_history_id} -> {final_history_id}: {} record(s), {} added, {} label change(s), {} deleted",
        context.account_id,
        records.len(),
        added_messages.len(),
        records.iter().map(|record| record.labels_added.len() + record.labels_removed.len()).sum::<usize>(),
        records.iter().map(|record| record.messages_deleted.len()).sum::<usize>(),
    );

    let untyped = fetch_unknown(
        context,
        UnknownFetch {
            candidates: records
                .iter()
                .flat_map(|record| record.messages.iter().map(|item| item.id.clone()))
                .collect(),
            already: &added_messages,
            source: "history record",
        },
    )
    .await?;
    added_messages.extend(untyped);

    match probe_inbox(context, &added_messages).await {
        Ok(probed) => added_messages.extend(probed),
        Err(error) => {
            tracing::warn!(target: "sync", "{}: inbox probe failed, relying on history alone: {error}", context.account_id);
        }
    }
    Ok(added_messages)
}

fn apply_labels_added(
    transaction: &rusqlite::Connection,
    target: &mut HistoryApplyTarget<'_>,
    changes: &[crate::gmail::LabelChange],
) -> rusqlite::Result<()> {
    for change in changes {
        apply_added_change(transaction, target.account_id, change)?;
        target.touched.insert(change.message.thread_id.clone());
    }
    Ok(())
}

fn apply_added_change(
    transaction: &rusqlite::Connection,
    account_id: &str,
    change: &crate::gmail::LabelChange,
) -> rusqlite::Result<()> {
    for label_id in &change.label_ids {
        LabelRepository::ensure_placeholder(transaction, account_id, label_id)?;
        MessageRepository::set_label_membership(
            transaction,
            MessageKey {
                account_id: account_id,
                message_id: &change.message.id,
            },
            LabelMembershipChange {
                label_id: label_id,
                present: true,
            },
        )?;
    }
    Ok(())
}

fn apply_labels_removed(
    transaction: &rusqlite::Connection,
    target: &mut HistoryApplyTarget<'_>,
    changes: &[crate::gmail::LabelChange],
) -> rusqlite::Result<()> {
    for change in changes {
        apply_removed_change(transaction, target.account_id, change)?;
        target.touched.insert(change.message.thread_id.clone());
    }
    Ok(())
}

fn apply_removed_change(
    transaction: &rusqlite::Connection,
    account_id: &str,
    change: &crate::gmail::LabelChange,
) -> rusqlite::Result<()> {
    for label_id in &change.label_ids {
        MessageRepository::set_label_membership(
            transaction,
            MessageKey {
                account_id: account_id,
                message_id: &change.message.id,
            },
            LabelMembershipChange {
                label_id: label_id,
                present: false,
            },
        )?;
    }
    Ok(())
}

fn apply_messages_deleted(
    transaction: &rusqlite::Connection,
    target: &mut HistoryApplyTarget<'_>,
    deleted_messages: &[crate::gmail::MessageRef],
) -> rusqlite::Result<()> {
    for deleted in deleted_messages {
        let thread_id = MessageRepository::delete(transaction, target.account_id, &deleted.id)?
            .unwrap_or_else(|| deleted.thread_id.clone());
        target.touched.insert(thread_id);
    }
    Ok(())
}

fn persist_incremental(
    connection: &rusqlite::Connection,
    commit: &IncrementalCommit,
) -> rusqlite::Result<(bool, Vec<MailArrival>)> {
    let transaction = connection.unchecked_transaction()?;
    let arrivals = compute_arrivals(
        &transaction,
        ArrivalWindow {
            account_id: &commit.account_id,
            now: commit.now,
        },
        &commit.added_messages,
    )?;
    let mut touched = HashSet::new();
    let target = WriteTarget {
        account_id: &commit.account_id,
        cache: commit.cache.as_ref(),
    };
    for message in &commit.added_messages {
        touched.insert(message.thread_id.clone());
        write_message(&transaction, target, message)?;
    }
    let mut history_target = HistoryApplyTarget {
        account_id: &commit.account_id,
        touched: &mut touched,
    };
    for record in &commit.records {
        apply_labels_added(&transaction, &mut history_target, &record.labels_added)?;
        apply_labels_removed(&transaction, &mut history_target, &record.labels_removed)?;
        apply_messages_deleted(&transaction, &mut history_target, &record.messages_deleted)?;
    }
    let labels_changed = sync_labels(
        &transaction,
        LabelSyncTarget {
            account_id: &commit.account_id,
            gmail_labels: &commit.gmail_labels,
        },
        &mut touched,
    )?;
    ThreadRepository::recompute_many(&transaction, &commit.account_id, &touched)?;
    transaction.commit()?;
    Ok((labels_changed, arrivals))
}

pub(super) async fn incremental_body(
    context: SyncContext<'_>,
    start_history_id: i64,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<IncrementalOutcome, SyncError> {
    let gmail_labels = context.client.labels().await?;
    let Some(records) = fetch_history_records(context.client, start_history_id).await? else {
        return Ok(IncrementalOutcome::Expired);
    };
    let final_history_id = records
        .iter()
        .map(|record| record.id)
        .max()
        .unwrap_or(start_history_id);
    let added_messages = collect_added_messages(&context, start_history_id, &records).await?;
    let added_count = added_messages.len() as u32;
    let history_changed = !records.is_empty() || added_count > 0;
    let added_thread_ids: HashSet<String> = added_messages
        .iter()
        .map(|message| message.thread_id.clone())
        .collect();

    let commit = IncrementalCommit {
        account_id: context.account_id.to_owned(),
        cache: context.cache,
        now: now,
        added_messages: added_messages,
        records: records,
        gmail_labels: gmail_labels,
    };
    let (labels_changed, arrivals) = context
        .storage
        .run(move |connection| persist_incremental(connection, &commit))
        .await?;
    let changed = history_changed || labels_changed;

    Ok(IncrementalOutcome::Updated {
        history_id: final_history_id,
        added_count: added_count,
        thread_ids: added_thread_ids.into_iter().collect(),
        changed: changed,
        arrivals: arrivals,
    })
}
