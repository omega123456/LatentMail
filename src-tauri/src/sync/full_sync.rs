use std::collections::HashSet;

use super::events::{emit_new_mail, EventSink, MailArrival, NewMailEvent};
use super::labels::{sync_labels, LabelSyncTarget};
use super::persist::{write_messages_and_recompute, WriteTarget};
use crate::sync::{concurrency, SyncError};
use crate::{
    gmail::{GmailClient, GmailMessage, MessageListQuery},
    storage::{MessageRepository, Storage},
};

const FRESH_ARRIVAL_MINUTES: i64 = 10;

pub(super) struct SyncContext<'a> {
    pub(super) storage: &'a Storage,
    pub(super) client: &'a GmailClient,
    pub(super) account_id: &'a str,
    pub(super) cache: Option<crate::attachments::AttachmentCache>,
}

pub(crate) struct FullSyncOutcome {
    pub(super) history_id: i64,
    pub(super) added_count: u32,
    pub(super) thread_ids: Vec<String>,
    pub(super) changed: bool,
    pub(super) arrivals: Vec<MailArrival>,
}

struct FullSyncWrite {
    account_id: String,
    cache: Option<crate::attachments::AttachmentCache>,
    gmail_labels: Vec<crate::gmail::GmailLabel>,
    messages: Vec<GmailMessage>,
}

fn persist_full_sync(
    connection: &rusqlite::Connection,
    data: &FullSyncWrite,
) -> rusqlite::Result<()> {
    let transaction = connection.unchecked_transaction()?;
    transaction.execute(
        "DELETE FROM messages WHERE account_id=?1",
        [&data.account_id],
    )?;
    transaction.execute(
        "DELETE FROM threads WHERE account_id=?1",
        [&data.account_id],
    )?;
    sync_labels(
        &transaction,
        LabelSyncTarget {
            account_id: &data.account_id,
            gmail_labels: &data.gmail_labels,
        },
        &mut HashSet::new(),
    )?;
    write_messages_and_recompute(
        &transaction,
        WriteTarget {
            account_id: &data.account_id,
            cache: data.cache.as_ref(),
        },
        &data.messages,
    )?;
    transaction.commit()
}

pub(super) async fn full_sync_body(context: SyncContext<'_>) -> Result<FullSyncOutcome, SyncError> {
    let profile = context.client.profile().await?;
    let gmail_labels = context.client.labels().await?;
    let inbox_labels = ["INBOX".to_owned()];
    let refs = context
        .client
        .list_all_messages_matching(MessageListQuery {
            label_ids: &inbox_labels,
            query_filter: Some("newer_than:30d"),
            page_token: None,
            options: crate::gmail::ListOptions::default(),
        })
        .await?;
    let messages = concurrency::fetch_messages(
        context.client,
        refs.into_iter().map(|message_ref| message_ref.id).collect(),
    )
    .await?;
    let added_count = messages.len() as u32;
    let thread_ids: HashSet<String> = messages
        .iter()
        .map(|message| message.thread_id.clone())
        .collect();

    tracing::info!(
        target: "sync",
        "{}: full sync fetched {added_count} message(s) across {} thread(s), profile checkpoint {}",
        context.account_id,
        thread_ids.len(),
        profile.history_id,
    );
    let write = FullSyncWrite {
        account_id: context.account_id.to_owned(),
        cache: context.cache,
        gmail_labels: gmail_labels,
        messages: messages,
    };
    context
        .storage
        .run(move |connection| persist_full_sync(connection, &write))
        .await?;

    Ok(FullSyncOutcome {
        history_id: profile.history_id,
        added_count: added_count,
        thread_ids: thread_ids.into_iter().collect(),
        changed: true,
        arrivals: Vec::new(),
    })
}

const INBOX_PROBE_SIZE: u32 = 25;

pub(super) struct UnknownFetch<'a> {
    pub(super) candidates: Vec<String>,
    pub(super) already: &'a [GmailMessage],
    pub(super) source: &'a str,
}

pub(super) async fn probe_inbox(
    context: &SyncContext<'_>,
    already: &[GmailMessage],
) -> Result<Vec<GmailMessage>, SyncError> {
    let inbox_labels = ["INBOX".to_owned()];
    let page = context
        .client
        .list_messages_page_matching(MessageListQuery {
            label_ids: &inbox_labels,
            query_filter: None,
            page_token: None,
            options: crate::gmail::ListOptions {
                include_spam_and_trash: false,
                page_size: INBOX_PROBE_SIZE,
            },
        })
        .await?;
    let candidates = page
        .items
        .into_iter()
        .map(|reference| reference.id)
        .collect();
    fetch_unknown(
        context,
        UnknownFetch {
            candidates: candidates,
            already: already,
            source: "inbox probe",
        },
    )
    .await
}

pub(super) async fn fetch_unknown(
    context: &SyncContext<'_>,
    request: UnknownFetch<'_>,
) -> Result<Vec<GmailMessage>, SyncError> {
    let seen: HashSet<&str> = request
        .already
        .iter()
        .map(|message| message.id.as_str())
        .collect();
    let candidates: Vec<String> = request
        .candidates
        .into_iter()
        .filter(|id| !seen.contains(id.as_str()))
        .collect();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let account_owned = context.account_id.to_owned();
    let unknown = context
        .storage
        .run(move |connection| {
            MessageRepository::missing_ids(connection, &account_owned, candidates)
        })
        .await?;
    if unknown.is_empty() {
        return Ok(Vec::new());
    }

    tracing::info!(
        target: "sync",
        "{}: {} found {} message(s) no delta reported: {}",
        context.account_id,
        request.source,
        unknown.len(),
        unknown.join(", "),
    );
    concurrency::fetch_messages(context.client, unknown).await
}

pub(crate) struct MaterializedBatch {
    pub(super) thread_ids: Vec<String>,
    pub(super) arrivals: Vec<MailArrival>,
    pub(super) added_count: u32,
}

pub(super) struct ArrivalWindow<'a> {
    pub(super) account_id: &'a str,
    pub(super) now: chrono::DateTime<chrono::Utc>,
}

pub(super) fn compute_arrivals(
    connection: &rusqlite::Connection,
    window: ArrivalWindow<'_>,
    messages: &[GmailMessage],
) -> rusqlite::Result<Vec<MailArrival>> {
    let mut missing: HashSet<String> = MessageRepository::missing_ids(
        connection,
        window.account_id,
        messages.iter().map(|message| message.id.clone()).collect(),
    )?
    .into_iter()
    .collect();
    Ok(messages
        .iter()
        .filter(|message| {
            let has = |label: &str| message.label_ids.iter().any(|id| id == label);
            missing.remove(&message.id)
                && has("INBOX")
                && has("UNREAD")
                && chrono::DateTime::from_timestamp(message.sent_at, 0).is_some_and(|sent_at| {
                    window.now.signed_duration_since(sent_at)
                        <= chrono::Duration::minutes(FRESH_ARRIVAL_MINUTES)
                })
        })
        .map(|message| MailArrival {
            thread_id: message.thread_id.clone(),
            sender: message.sender.clone(),
            subject: message.subject.clone(),
            snippet: message.snippet.clone(),
        })
        .collect())
}

pub(super) struct NewMailNotice<'a> {
    pub(super) account_id: &'a str,
    pub(super) thread_ids: Vec<String>,
    pub(super) arrivals: Vec<MailArrival>,
    pub(super) added_count: u32,
}

pub(super) fn emit_new_mail_if_present(events: &EventSink, notice: NewMailNotice<'_>) {
    if notice.added_count > 0 {
        emit_new_mail(
            events,
            NewMailEvent {
                account_id: notice.account_id.to_owned(),
                thread_ids: notice.thread_ids,
                arrivals: notice.arrivals,
            },
        );
    }
}

pub(super) async fn probe_only_body(
    context: SyncContext<'_>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<MaterializedBatch, SyncError> {
    let messages = probe_inbox(&context, &[]).await?;
    let added_count = messages.len() as u32;
    if messages.is_empty() {
        return Ok(MaterializedBatch {
            thread_ids: Vec::new(),
            arrivals: Vec::new(),
            added_count: 0,
        });
    }
    let thread_ids: HashSet<String> = messages
        .iter()
        .map(|message| message.thread_id.clone())
        .collect();
    let account_owned = context.account_id.to_owned();
    let cache = context.cache;
    let arrivals = context
        .storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let arrivals = compute_arrivals(
                &transaction,
                ArrivalWindow {
                    account_id: &account_owned,
                    now: now,
                },
                &messages,
            )?;
            write_messages_and_recompute(
                &transaction,
                WriteTarget {
                    account_id: &account_owned,
                    cache: cache.as_ref(),
                },
                &messages,
            )?;
            transaction.commit()?;
            Ok(arrivals)
        })
        .await?;
    Ok(MaterializedBatch {
        thread_ids: thread_ids.into_iter().collect(),
        arrivals: arrivals,
        added_count: added_count,
    })
}
