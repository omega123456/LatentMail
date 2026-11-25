use std::collections::HashSet;

use crate::sync::materialize;
use crate::{attachments::MessageTarget, gmail::GmailMessage, storage::ThreadRepository};

#[derive(Clone, Copy)]
pub(super) struct WriteTarget<'a> {
    pub(super) account_id: &'a str,
    pub(super) cache: Option<&'a crate::attachments::AttachmentCache>,
}

pub(super) fn write_messages_and_recompute(
    connection: &rusqlite::Connection,
    target: WriteTarget<'_>,
    messages: &[GmailMessage],
) -> rusqlite::Result<HashSet<String>> {
    let mut touched = HashSet::new();
    for message in messages {
        touched.insert(message.thread_id.clone());
        write_message(connection, target, message)?;
    }
    ThreadRepository::recompute_many(connection, target.account_id, &touched)?;
    Ok(touched)
}

pub(super) fn write_message(
    connection: &rusqlite::Connection,
    target: WriteTarget<'_>,
    message: &GmailMessage,
) -> rusqlite::Result<()> {
    materialize::persist(connection, target.account_id, message)?;
    if let Some(cache) = target.cache {
        crate::attachments::seed_cache(
            cache,
            MessageTarget {
                account_id: target.account_id,
                message_id: &message.id,
            },
            &message.attachment_parts,
        );
    }
    Ok(())
}
