//! The shared whole-mailbox traversal mechanism (D1/D3/D4): enumerates
//! every label with no date bound, newest-first, including Spam and Trash,
//! at an explicit page size, and persists metadata, memberships and a
//! truncated plain-text body for every message it finds — never full HTML
//! or inline attachment parts (Phase 6 fetches those lazily on open).
//!
//! [`run_backfill_step`] is this phase's own consumer: whole-mailbox
//! backfill, checkpointed per page so it resumes without re-fetching a
//! persisted message after an interruption or restart — driven one discrete
//! page at a time by `SyncEngine::enqueue_backfill`/`enqueue_backfill_step`
//! (`sync::mod`), which is the queue's own genuinely discrete unit of work.
//! [`fetch_and_persist`] is the narrower, reusable fetch-path primitive —
//! Phase 5's `sync::reconcile` calls it too, for identifiers its own
//! universe/membership diff decides are new, so both traversals write
//! through the exact same persistence logic. Both share the entity key in
//! [`traversal_entity_key`], which is what makes backfill and
//! reconciliation mutually exclusive per account (D3) — they are strictly
//! serialized by the queue's per-entity lock.

use std::collections::HashSet;

use serde::Serialize;

use crate::{
    gmail::{GmailClient, GmailMessage, ListOptions, MAX_PAGE_SIZE},
    storage::{
        HtmlPresence, LabelRepository, Message, MessageRepository, Storage, ThreadRepository,
        TraversalCursor, TraversalCursorRepository, TraversalKind,
    },
};

use super::{EventSink, SyncError};

/// The entity key backfill (this phase) and reconciliation (Phase 5) must
/// both enqueue their traversal-lane operations under, so the queue's
/// per-account entity lock strictly serializes them (D3). **Phase 5 must
/// call this same function** rather than deriving its own string — any
/// divergent key would silently defeat the mutual-exclusion guarantee.
pub fn traversal_entity_key(account_id: &str) -> String {
    format!("traversal:{account_id}")
}

/// Traversal progress, emitted once per completed batch (D11: a running
/// **count**, never a percentage or time estimate — a resumed run reports
/// the position it resumed from, not zero). One event per batch is already
/// a natural throttle: batches are sized to Gmail's page maximum, so this
/// never fires more often than once per few hundred messages.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraversalProgressEvent {
    pub account_id: String,
    pub kind: &'static str,
    pub discovered_count: i64,
    pub persisted_count: i64,
    pub completed: bool,
}

/// Named emitter for `sync://traversal`.
pub fn emit_traversal_progress(sink: &EventSink, event: TraversalProgressEvent) {
    sink(
        "sync://traversal",
        serde_json::to_value(event).expect("TraversalProgressEvent always serializes"),
    );
}

/// One discrete unit of backfill work: fetches and persists exactly one
/// page (or detects an already-complete cursor and does nothing), advancing
/// the cursor atomically with that page's writes. Returns whether backfill
/// is now fully complete.
///
/// This is the genuinely discrete unit the plan's queue architecture
/// requires ("every unit of work is a discrete operation on the traversal
/// lane") — `SyncEngine::enqueue_backfill`/`enqueue_backfill_step`
/// (`sync::mod`, plan-adherence audit item 5) re-enqueue a fresh
/// traversal-lane queue operation per call to this function instead of
/// holding one operation's lane permit and entity lock for an entire
/// multi-hour backfill — the queue's own per-operation
/// `wait_until_resumed`/`wait_for_interactive` checks then apply at every
/// page boundary "for free", not just once before the whole backfill
/// starts. `client` must already be traversal-scoped
/// ([`crate::gmail::GmailClient::traversal_scoped`]) so its requests draw
/// from the capped traversal quota class (D4) and can never starve
/// interactive/background work.
///
/// `resumed` is *not* re-derived from the cursor's `position` column here —
/// it's supplied by the caller, which snapshots it once per logical run
/// (`SyncEngine::enqueue_backfill`, before that run's first page ever
/// commits) as "did this account's backfill cursor already have a saved
/// position when this run began". Every subsequent page of the same run
/// (the recursive `enqueue_backfill_step` chain) passes the same value back
/// in, so the persisted `resumed` flag — and therefore the status bar's
/// "Resuming backfill" wording — can't flip mid-run just because a page
/// this run itself committed happens to have written a non-null `position`.
///
/// Detects an already-complete cursor up front and returns without making
/// any Gmail request. A cursor left by a previous, interrupted run resumes
/// from its recorded page position — no page whose batch already committed
/// is re-fetched. The cursor (position, counts, completion flag) only ever
/// advances as part of the same transaction as the batch's message writes,
/// so an interruption anywhere before that commit — mid-fetch, mid-write,
/// mid-transaction — always leaves the last *completed* batch as the point
/// resumption continues from.
pub async fn run_backfill_step(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
    events: &EventSink,
    resumed: bool,
) -> Result<bool, SyncError> {
    // Backfill owns its own `(account_id, Backfill)` row (D3 fix, migration
    // `V4__traversal_cursor_composite_key`) — a concurrent or prior
    // reconciliation pass has its own independent row and can never be read
    // or clobbered here. Mutual exclusion between the two traversals is the
    // queue's per-account entity lock (`traversal_entity_key`), not this
    // table, so this function no longer needs to defer to a foreign-kind
    // cursor — there isn't one to see.
    let existing = storage
        .run({
            let account = account_id.to_owned();
            move |connection| {
                TraversalCursorRepository::get(connection, &account, TraversalKind::Backfill)
            }
        })
        .await?;

    if let Some(cursor) = &existing {
        if cursor.completed {
            // Already finished in a previous run — do not restart.
            return Ok(true);
        }
    }

    let needs_mailbox_total = existing
        .as_ref()
        .is_none_or(|cursor| cursor.discovered_count <= cursor.persisted_count);
    let (token, discovered, persisted) = match existing {
        Some(cursor) => (
            cursor.position,
            cursor.discovered_count,
            cursor.persisted_count,
        ),
        None => (None, 0, 0),
    };
    // Gmail's list result only exposes an estimate. The profile exposes the
    // real mailbox total the UI promises as the denominator. Refresh old
    // cursors whose former running count equals their persisted count once,
    // then retain that total across later page operations.
    let discovered = if needs_mailbox_total {
        client.profile().await?.messages_total
    } else {
        discovered
    };

    let options = ListOptions {
        include_spam_and_trash: true,
        page_size: MAX_PAGE_SIZE,
    };

    // No label filter (`&[]`) is what makes this whole-mailbox rather
    // than Inbox-scoped, and no `query_filter` is what removes the
    // 30-day bound initial sync applies.
    let page = client
        .list_messages_page_matching(&[], None, token.as_deref(), options)
        .await?;
    let is_last_page = page.next_page_token.is_none();
    let next_token = page.next_page_token.clone();
    let ids: Vec<String> = page.items.iter().map(|item| item.id.clone()).collect();

    let mut messages = Vec::with_capacity(ids.len());
    for id in &ids {
        messages.extend(client.message_if_present(id).await?);
    }

    let persisted = persisted + messages.len() as i64;
    let account_owned = account_id.to_owned();
    let position = next_token;
    let now = chrono::Utc::now().timestamp();
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let mut touched = HashSet::new();
            for message in &messages {
                touched.insert(message.thread_id.clone());
                write_traversal_message(&transaction, &account_owned, message)?;
            }
            for thread_id in &touched {
                ThreadRepository::recompute(&transaction, &account_owned, thread_id)?;
            }
            // Cursor advance lives in the *same* transaction as the
            // batch's message/thread writes — the "one transaction per
            // batch" requirement is what makes checkpoint advancement
            // and persistence atomic with each other.
            TraversalCursorRepository::upsert(
                &transaction,
                &TraversalCursor {
                    account_id: account_owned.clone(),
                    kind: TraversalKind::Backfill,
                    position,
                    discovered_count: discovered,
                    persisted_count: persisted,
                    completed: is_last_page,
                    last_advanced_at: now,
                    resumed,
                },
            )?;
            transaction.commit()
        })
        .await?;

    emit_traversal_progress(
        events,
        TraversalProgressEvent {
            account_id: account_id.to_owned(),
            kind: "backfill",
            discovered_count: discovered,
            persisted_count: persisted,
            completed: is_last_page,
        },
    );

    Ok(is_last_page)
}

/// Fetches full messages for `ids` from Gmail and persists their metadata,
/// memberships and truncated body — never full HTML or inline parts — in
/// one storage transaction. `client` should be traversal-scoped. This is
/// the shared fetch path: [`run_backfill_step`]'s own per-page batching
/// above composes the same per-message write ([`write_traversal_message`]) with
/// its cursor advance in one transaction, while this standalone entry
/// point is what Phase 5's reconciliation calls for identifiers its
/// universe/membership diff decides are new — reconciliation has its own
/// checkpoint bookkeeping and does not need this function to touch the
/// cursor. Returns the distinct thread ids touched, so a caller with
/// further per-thread bookkeeping of its own doesn't have to re-derive it.
pub async fn fetch_and_persist(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
    ids: &[String],
) -> Result<Vec<String>, SyncError> {
    let mut messages = Vec::with_capacity(ids.len());
    for id in ids {
        messages.extend(client.message_if_present(id).await?);
    }
    let account_owned = account_id.to_owned();
    let thread_ids = storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let mut touched = HashSet::new();
            for message in &messages {
                touched.insert(message.thread_id.clone());
                write_traversal_message(&transaction, &account_owned, message)?;
            }
            for thread_id in &touched {
                ThreadRepository::recompute(&transaction, &account_owned, thread_id)?;
            }
            transaction.commit()?;
            Ok(touched.into_iter().collect::<Vec<_>>())
        })
        .await?;
    Ok(thread_ids)
}

/// Writes one already-fetched Gmail message's metadata, truncated body and
/// label memberships into `connection`, via
/// [`MessageRepository::write_traversal_state`] — which never downgrades a
/// message whose full body is already known locally (see that method's
/// documentation). Memberships are only (re)written when the row actually
/// changed, matching the convention `sync::write_message` already
/// establishes for initial/incremental sync, so a gate-blocked (stale)
/// write can't clobber memberships with data from a fetch Gmail itself
/// considers superseded.
fn write_traversal_message(
    connection: &rusqlite::Connection,
    account_id: &str,
    message: &GmailMessage,
) -> rusqlite::Result<()> {
    let truncated_body =
        crate::storage::truncate_body(message.plain_body.as_deref(), message.html_body.as_deref());
    let record = Message {
        account_id: account_id.to_owned(),
        id: message.id.clone(),
        thread_id: message.thread_id.clone(),
        rfc_message_id: message.rfc_message_id.clone(),
        sender: message.sender.clone(),
        recipients: message.recipients.clone(),
        subject: message.subject.clone(),
        sent_at: message.sent_at,
        snippet: message.snippet.clone(),
        // Traversal never persists full HTML or plain bodies (D1) — only
        // the truncated text below. `write_traversal_state` never lets
        // these two `None`s clobber an already-resolved full body on an
        // existing row; they only take effect on a brand-new row.
        html_body: None,
        plain_body: None,
        has_attachments: message.has_attachments,
        is_unread: message.label_ids.iter().any(|id| id == "UNREAD"),
        is_starred: message.label_ids.iter().any(|id| id == "STARRED"),
        history_id: message.history_id,
        truncated_body,
        html_presence: HtmlPresence::NeverFetched,
    };
    let changed = MessageRepository::write_traversal_state(connection, &record)?;
    if changed {
        MessageRepository::set_recipient_roles(
            connection,
            account_id,
            &message.id,
            &message.to_recipients,
            &message.cc_recipients,
            &message.bcc_recipients,
            message.rfc_references.as_deref(),
        )?;
        for label_id in &message.label_ids {
            LabelRepository::ensure_placeholder(connection, account_id, label_id)?;
            MessageRepository::set_label_membership(
                connection,
                account_id,
                &message.id,
                label_id,
                true,
            )?;
        }
    }
    Ok(())
}
