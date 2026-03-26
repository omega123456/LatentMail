import { app, BrowserWindow, Notification, nativeImage } from 'electron';
import * as path from 'path';
import { DateTime } from 'luxon';
import { LoggerService } from './logger-service';
import { ImapService } from './imap-service';
import { TrayService } from './tray-service';

const log = LoggerService.getInstance();
import { DatabaseService } from './database-service';
import { FolderLockManager } from './folder-lock-manager';
import { OAuthService } from './oauth-service';
import { FilterService } from './filter-service';
import { PendingOpService } from './pending-op-service';
import { IPC_EVENTS } from '../ipc/ipc-channels';
import { formatParticipant, formatParticipantList } from '../utils/format-participant';

/** Gmail special-use folder mappings (All Mail excluded — not shown or synced) */
const GMAIL_FOLDER_MAP: Record<string, { name: string; icon: string }> = {
  '\\Inbox': { name: 'Inbox', icon: 'inbox' },
  '\\Drafts': { name: 'Drafts', icon: 'edit_note' },
  '\\Sent': { name: 'Sent', icon: 'send' },
  '\\Trash': { name: 'Trash', icon: 'delete' },
  '\\Junk': { name: 'Spam', icon: 'report' },
  '\\Flagged': { name: 'Starred', icon: 'star' },
  '\\Important': { name: 'Important', icon: 'label_important' },
};

export const ALL_MAIL_PATH = '[Gmail]/All Mail';

/** IMAP parent mailbox for Gmail system folders; not a real folder — exclude from sidebar. */
export const GMAIL_PARENT_PATH = '[Gmail]';

/**
 * Gmail Important label path — a system attribute rather than a real user-manageable label.
 * ImapFlow may not classify it as specialUse; excluding it prevents it from appearing in the sidebar.
 */
export const IMPORTANT_PATH = '[Gmail]/Important';

/** Folder paths excluded from sidebar and from label sync (not real selectable folders). */
export const EXCLUDED_FOLDER_PATHS: readonly string[] = [ALL_MAIL_PATH, GMAIL_PARENT_PATH, IMPORTANT_PATH];

/**
 * Gmail X-GM-LABELS system label → IMAP folder path mapping.
 * Used by syncAllMail() to convert raw labels from ImapFlow's msg.labels Set
 * into folder paths for the email_folders junction table.
 */
const GMAIL_LABEL_TO_FOLDER: Record<string, string> = {
  '\\Inbox': 'INBOX',
  '\\Sent': '[Gmail]/Sent Mail',
  '\\Draft': '[Gmail]/Drafts',
  '\\Junk': '[Gmail]/Spam',
  '\\Starred': '[Gmail]/Starred',
  '\\Important': '[Gmail]/Important',
};

/**
 * Convert raw X-GM-LABELS Set (from ImapFlow msg.labels) into validated IMAP folder paths.
 *
 * - System labels are mapped via GMAIL_LABEL_TO_FOLDER.
 * - User labels are validated against the known mailbox path set.
 * - [Gmail]/All Mail is always excluded (never stored as a folder association).
 *
 * @param rawLabels  Raw Set<string> from msg.labels (before CSV join).
 * @param knownMailboxPaths  Set of known IMAP folder paths for the account (from getMailboxesForSync).
 * @returns Array of validated IMAP folder paths.
 */
function mapLabelsToFolderPaths(rawLabels: string[], knownMailboxPaths: Set<string>, accountId: number): string[] {
  const folderPaths: string[] = [];

  for (const label of rawLabels) {
    // Resolve the \Trash label dynamically per-account (locale-specific: [Gmail]/Trash vs [Gmail]/Bin)
    if (label === '\\Trash') {
      const trashPath = DatabaseService.getInstance().getTrashFolder(accountId);
      if (knownMailboxPaths.has(trashPath)) {
        folderPaths.push(trashPath);
      }
      continue;
    }

    // System label mapping
    const systemPath = GMAIL_LABEL_TO_FOLDER[label];
    if (systemPath) {
      // INBOX is guaranteed to exist; other system folders are validated against
      // known mailbox paths (user may have hidden them in Gmail IMAP settings).
      if (systemPath === 'INBOX' || knownMailboxPaths.has(systemPath)) {
        folderPaths.push(systemPath);
      }
      continue;
    }

    // Skip excluded folders (All Mail, Gmail parent) — never stored as folder associations
    if (EXCLUDED_FOLDER_PATHS.includes(label)) {
      continue;
    }

    // User label: validate against known mailbox paths
    if (knownMailboxPaths.has(label)) {
      folderPaths.push(label);
    } else {
      log.debug(`[SyncService] mapLabelsToFolderPaths: skipping unknown label "${label}"`);
    }
  }

  return folderPaths;
}

/** Result returned by syncFolder() for the queue worker to act on. */
export interface SyncFolderResult {
  uidValidityChanged: boolean;
  folderChanged: boolean;
  changeType: 'new_messages' | 'flag_changes' | 'deletions' | 'mixed';
  changeCount: number;
}

/** Maximum age (ms) for an email to be counted in desktop notifications. */
const NOTIFICATION_RECENCY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

interface NewEmailInfo {
  xGmMsgId: string;
  xGmThrid: string;
  sender: string;
  subject: string;
  snippet: string;
  date: string;
}

interface NotificationBatch {
  timer: ReturnType<typeof setTimeout>;
  emails: NewEmailInfo[];
}

interface MailFolderUpdatedPayload {
  accountId: number;
  folders: string[];
  reason: 'sync' | 'move' | 'delete' | 'flag' | 'send' | 'draft-create' | 'draft-update' | 'filter';
  changeType?: 'new_messages' | 'flag_changes' | 'deletions' | 'mixed';
  count?: number;
}

/**
 * Token passed into startIdle / startIdleAllMail to enable post-connect lifecycle validation.
 *
 * Because the IMAP connection attempt is async (may take several seconds), a pause/sleep-stop/
 * reset can change the lifecycle state while the connect is in flight. The token captures the
 * lifecycle generation at call time; startIdle re-checks it after the await and tears down the
 * newly-opened connection if the token is stale or global suppression has been activated.
 */
export interface IdleLifecycleToken {
  /**
   * Returns true if the lifecycle is still in the same state as when the token was created
   * (generation unchanged AND global suppression not active). Returns false if the connection
   * should be torn down.
   */
  isValid: () => boolean;
}

export class SyncService {
  private static instance: SyncService;
  private idleAccounts: Set<string> = new Set();
  /** Per-account notification batching accumulators */
  private notificationBatches: Map<string, NotificationBatch> = new Map();
  /** IDLE reconnection backoff timers (per account) */
  private idleReconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Current reconnection backoff delay per account (ms) */
  private idleReconnectDelay: Map<string, number> = new Map();
  /** Accounts where IDLE stop/reconnect was intentional — suppress auto-reconnect */
  private idleSuppressReconnect: Set<string> = new Set();
  /**
   * Per-account onNewMail callbacks registered by SyncQueueBridge when startIdle() is called.
   * Stored here so scheduleIdleReconnect() can pass the same callback on reconnect.
   */
  private idleNewMailCallbacks: Map<string, () => void> = new Map();

  // ---- All Mail IDLE tracking state (fully independent from INBOX IDLE) ----

  /** Accounts that have an active All Mail IDLE connection. */
  private idleAllMailAccounts = new Set<string>();
  /** Per-account expunge callbacks for All Mail IDLE. Stored for reconnect reuse. */
  private idleAllMailCallbacks = new Map<string, (accountId: string) => void>();
  /** Current reconnection backoff delay per account (ms) for All Mail IDLE. */
  private idleAllMailReconnectDelay = new Map<string, number>();
  /** Reconnection backoff timers per account for All Mail IDLE. */
  private idleAllMailReconnectTimers = new Map<string, NodeJS.Timeout>();
  /** Accounts where All Mail IDLE stop was intentional — suppress auto-reconnect. */
  private idleAllMailSuppressReconnect = new Set<string>();

  /**
   * Global flag that suppresses ALL IDLE reconnect scheduling regardless of per-account state.
   * Set by SyncQueueBridge.pause() / resume() via setGlobalIdleSuppression().
   * Independent of the per-account idleSuppressReconnect Set.
   */
  private globalIdleSuppression = false;

  /**
   * When true, showDesktopNotification() is a no-op.
   * Set by disableNotificationsForTesting() in the test infrastructure so that
   * IDLE-triggered syncs during tests do not emit real OS notifications.
   */
  private notificationsDisabled = false;

  /**
   * Monotonically-increasing lifecycle generation counter for reconnect tokens.
   *
   * Incremented every time the IDLE state is intentionally reset (pause, stop, or test reset).
   * Reconnect lifecycle tokens capture the generation at token-creation time; the token's
   * isValid() returns false if the current generation no longer matches the captured value.
   * This ensures that a still-in-flight IMAP connect from a previous lifecycle epoch cannot
   * silently establish itself after suppression is lifted — even if the boolean suppression
   * flags have been cleared by the time the async connect resolves.
   */
  private idleLifecycleGeneration = 0;

  private constructor() {}

  static getInstance(): SyncService {
    if (!SyncService.instance) {
      SyncService.instance = new SyncService();
    }
    return SyncService.instance;
  }

  /**
   * Set or clear the global IDLE reconnect suppression flag.
   * When set to true, scheduleIdleReconnect() will skip scheduling new timers.
   * Called by SyncQueueBridge.pause() and SyncQueueBridge.resume().
   * Does NOT interact with the per-account idleSuppressReconnect Set.
   *
   * Incrementing the lifecycle generation when suppression is activated ensures that
   * any in-flight reconnect tokens created before this call will see isValid()=false
   * even after the suppression flag is lifted for the new lifecycle epoch.
   */
  setGlobalIdleSuppression(suppress: boolean): void {
    if (suppress) {
      this.idleLifecycleGeneration++;
    }
    this.globalIdleSuppression = suppress;
    log.info(`[SyncService] Global IDLE reconnect suppression: ${suppress}`);
  }

  // -----------------------------------------------------------------------
  // Mailbox helpers (used by SyncQueueBridge)
  // -----------------------------------------------------------------------

  /**
   * Fetch the mailbox list for an account and filter out non-syncable folders.
   * Returns mailboxes excluding All Mail.
   */
  async getMailboxesForSync(accountId: string): Promise<Awaited<ReturnType<typeof ImapService.prototype.getMailboxes>>> {
    const imapService = ImapService.getInstance();

    // Race against a 30s timeout so stale post-sleep connections fail fast
    // instead of hanging the sync indicator indefinitely.
    const timeoutMs = 30_000;
    let mailboxes: Awaited<ReturnType<typeof imapService.getMailboxes>>;
    try {
      mailboxes = await Promise.race([
        imapService.getMailboxes(accountId),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`getMailboxesForSync timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        }),
      ]);
    } catch (err) {
      // Force-close the stale connection so the next attempt creates a fresh one.
      await imapService.disconnect(accountId).catch(() => {});
      throw err;
    }

    return mailboxes.filter((mb) => !EXCLUDED_FOLDER_PATHS.includes(mb.path));
  }

  /**
   * Upsert labels from a mailbox list into the local DB.
   * Called by SyncQueueBridge before enqueueing per-folder sync items.
   */
  upsertLabelsFromMailboxes(
    accountId: number,
    mailboxes: Awaited<ReturnType<typeof ImapService.prototype.getMailboxes>>,
  ): void {
    const db = DatabaseService.getInstance();
    for (const mb of mailboxes) {
      if (EXCLUDED_FOLDER_PATHS.includes(mb.path)) {
        continue;
      }
      const specialUseInfo = GMAIL_FOLDER_MAP[mb.specialUse];
      db.upsertLabel({
        accountId,
        gmailLabelId: mb.path,
        name: specialUseInfo?.name || mb.name,
        type: mb.specialUse ? 'system' : 'user',
        unreadCount: mb.unseen,
        totalCount: mb.messages,
        specialUse: mb.specialUse || undefined,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Per-folder sync (called by MailQueueService.processSyncFolder)
  // -----------------------------------------------------------------------

  /**
   * Sync a single folder for an account.
   * Retained **only** for the IDLE-triggered INBOX sync path. All other folder
   * discovery goes through syncAllMail(). No reconciliation logic — the 5-min
   * All Mail sync handles folder reconciliation.
   *
   * @param accountId        Account ID as string.
   * @param folder           Folder path (e.g. 'INBOX').
   * @param isInitial        True for the first-ever sync (affects fetch limit).
   * @param sinceDate        For incremental fetches, only emails since this date.
   * @param showNotifications True when triggered by IDLE (shows desktop notification).
   * @param limit            Optional fetch limit override. Pass `null` to fetch all messages (no limit).
   *                         Defaults to current behavior (100 for initial, 200 for incremental).
   * @returns SyncFolderResult for the queue worker to act on.
   */
  async syncFolder(
    accountId: string,
    folder: string,
    isInitial: boolean,
    sinceDate: Date,
    showNotifications: boolean,
    limit?: number | null,
  ): Promise<SyncFolderResult> {
    const lockManager = FolderLockManager.getInstance();

    // Acquire folder lock — held through reconciliation (Pattern A).
    const release = await lockManager.acquire(folder, accountId);
    try {
      return await this.syncFolderInner(accountId, folder, isInitial, sinceDate, showNotifications, limit);
    } finally {
      release();
    }
  }

  /**
   * Sync a folder and then perform UID reconciliation against the server, holding the
   * FolderLockManager lock across the entire sequence to prevent race conditions.
   *
   * Intended for on-demand Trash/Spam syncs triggered when the user selects those folders.
   * Emits MAIL_FOLDER_UPDATED when complete so the renderer reloads the thread list.
   *
   * @param accountId Account ID as string.
   * @param folder    Folder path to sync (e.g. '[Gmail]/Trash').
   */
  async syncFolderWithReconciliation(accountId: string, folder: string): Promise<void> {
    const lockManager = FolderLockManager.getInstance();
    const imapService = ImapService.getInstance();
    const numAccountId = Number(accountId);
    const sinceDate = DateTime.utc().minus({ days: 30 }).toJSDate();

    log.info(`[SyncService] syncFolderWithReconciliation: starting for folder ${folder} account ${accountId}`);

    // Acquire the folder lock and hold it across the full sync + reconciliation sequence.
    // syncFolderInner() is called directly (no lock) to avoid double-locking.
    const release = await lockManager.acquire(folder, accountId);
    try {
      // Full folder sync (no message limit — fetch everything for Trash/Spam browsing)
      await this.syncFolderInner(accountId, folder, false, sinceDate, false, null);

      // UID diff: detect messages removed from the folder since last sync
      const serverUids = await imapService.fetchFolderUids(accountId, folder);
      const { staleCount } = await this.reconcileFolderWithServerUids(accountId, folder, serverUids);
      log.info(`[SyncService] syncFolderWithReconciliation: UID diff — ${staleCount} stale entr${staleCount === 1 ? 'y' : 'ies'} removed from ${folder} (account ${accountId})`);
    } finally {
      release();
    }

    // Notify renderer that the folder has been updated (outside the lock is fine — DB work is done)
    this.emitFolderUpdated(numAccountId, [folder], 'sync', 'mixed');
    log.info(`[SyncService] syncFolderWithReconciliation: complete for folder ${folder} account ${accountId}`);
  }

  /**
   * Lock-free inner implementation of folder sync. Performs mailbox status check,
   * email fetch, upsert, thread update, filter evaluation, and folder state persistence.
   * Does NOT acquire the FolderLockManager lock — callers are responsible for locking.
   *
   * @param accountId         Account ID as string.
   * @param folder            Folder path (e.g. 'INBOX').
   * @param isInitial         True for the first-ever sync (affects default fetch limit).
   * @param sinceDate         For incremental fetches, only emails since this date.
   * @param showNotifications True when triggered by IDLE (shows desktop notification).
   * @param limit             Optional fetch limit override. Pass `null` to fetch all messages.
   *                          When `undefined`, defaults to 100 (initial) or 200 (incremental).
   * @returns SyncFolderResult for the queue worker to act on.
   */
  private async syncFolderInner(
    accountId: string,
    folder: string,
    isInitial: boolean,
    sinceDate: Date,
    showNotifications: boolean,
    limit?: number | null,
  ): Promise<SyncFolderResult> {
    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();
    const numAccountId = Number(accountId);

    let uidValidityChanged = false;
    let folderChanged = false;
    let folderChangeType: 'new_messages' | 'flag_changes' | 'deletions' | 'mixed' = 'mixed';
    let folderChangeCount = 0;

    const existingFolderState = db.getFolderState(numAccountId, folder);

    // --- Mailbox status ---
    const mailboxStatus = await imapService.getMailboxStatus(accountId, folder);
    const folderUidValidity = mailboxStatus.uidValidity;
    const folderCondstoreSupported = mailboxStatus.condstoreSupported;
    let folderHighestModseq: string | null = folderCondstoreSupported ? mailboxStatus.highestModseq : null;

    // UIDVALIDITY reset: wipe cached folder data.
    // The queue worker will call failOperationsForFolder() based on the returned flag.
    if (existingFolderState && existingFolderState.uidValidity !== mailboxStatus.uidValidity) {
      log.warn(`[SyncService] UIDVALIDITY changed for ${folder} (account ${accountId}): ${existingFolderState.uidValidity} -> ${mailboxStatus.uidValidity}. Resetting folder cache.`);
      db.wipeFolderData(numAccountId, folder);
      uidValidityChanged = true;
    }

    // --- Fetch emails ---
    // When limit is explicitly null, fetch all (no cap). When undefined, use default limits.
    const defaultFetchLimit = isInitial ? 100 : 200;
    const fetchLimit = limit === null ? undefined : (limit !== undefined ? limit : defaultFetchLimit);
    let emails: Awaited<ReturnType<typeof imapService.fetchEmails>> = [];

    const canUseCondstore =
      !uidValidityChanged &&
      folderCondstoreSupported &&
      !!existingFolderState &&
      existingFolderState.uidValidity === mailboxStatus.uidValidity &&
      existingFolderState.condstoreSupported;

    if (canUseCondstore) {
      const changedSince = existingFolderState!.highestModseq ?? '0';
      const changed = await imapService.fetchChangedSince(accountId, folder, changedSince);

      const sorted = [...changed.emails].sort((a, b) => {
        const ma = BigInt(a.modseq ?? '0');
        const mb = BigInt(b.modseq ?? '0');
        if (ma < mb) {
          return -1;
        }
        if (ma > mb) {
          return 1;
        }
        return a.uid - b.uid;
      });
      emails = fetchLimit !== undefined ? sorted.slice(0, fetchLimit) : sorted;

      if (emails.length > 0) {
        let maxProcessed = BigInt(changedSince || '0');
        for (const email of emails) {
          const modseq = BigInt(email.modseq ?? '0');
          if (modseq > maxProcessed) {
            maxProcessed = modseq;
          }
        }
        folderHighestModseq = String(maxProcessed);
      } else {
        folderHighestModseq = changed.highestModseq;
      }
    } else {
      // Non-condstore path: date-based fetch.
      // When limit is null (full fetch), skip the date window and count cap entirely.
      // When limit is undefined (default), apply sinceDate and the default fetch limit.
      if (limit === null) {
        // Full fetch: no date restriction, no count cap — fetch every message in the folder.
        // Pass limit: undefined explicitly so fetchEmails treats it as "no cap" (not the default 50).
        emails = await imapService.fetchEmails(accountId, folder, { limit: undefined });
      } else {
        // If we had a usable folder state but condstore isn't supported, use sinceDate.
        // After a UIDVALIDITY reset, fall back to 30 days to get a reasonable initial set.
        const hasUsableFolderState =
          !uidValidityChanged &&
          !!existingFolderState &&
          existingFolderState.uidValidity === mailboxStatus.uidValidity;
        const folderSinceDate = hasUsableFolderState
          ? sinceDate
          : DateTime.utc().minus({ days: 30 }).toJSDate();
        emails = await imapService.fetchEmails(accountId, folder, { limit: fetchLimit, since: folderSinceDate });
      }
    }

    // --- Group emails by thread, skip pending ops ---
    const pendingOpService = PendingOpService.getInstance();
    const threadMap = new Map<string, typeof emails>();
    let newCount = 0;
    let flagChangeCount = 0;
    const newEmailsForNotification: NewEmailInfo[] = [];

    for (const email of emails) {
      const threadId = email.xGmThrid || email.xGmMsgId;
      const pendingForThread = pendingOpService.getPendingForThread(numAccountId, threadId);
      if (pendingForThread.has(email.xGmMsgId)) {
        log.debug(`[SyncService] syncFolder: skipping pending message ${email.xGmMsgId} in ${folder}`);
        continue;
      }

      const alreadyExists = db.getEmailByXGmMsgId(numAccountId, email.xGmMsgId) != null;
      if (alreadyExists) {
        flagChangeCount++;
      } else {
        newCount++;
      if (showNotifications && folder === 'INBOX') {
          const dt = DateTime.fromISO(email.date);
          const emailTimestamp = dt.isValid ? dt.toMillis() : NaN;
          const now = Date.now();
          const isRecent = !isNaN(emailTimestamp) && emailTimestamp <= now && (now - emailTimestamp) <= NOTIFICATION_RECENCY_WINDOW_MS;
          if (isRecent) {
            newEmailsForNotification.push({
              xGmMsgId: email.xGmMsgId,
              xGmThrid: email.xGmThrid,
              sender: email.fromName || email.fromAddress,
              subject: email.subject,
              snippet: email.snippet,
              date: email.date,
            });
          }
        }
      }

      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, []);
      }
      threadMap.get(threadId)!.push(email);
    }

    // --- Upsert emails ---
    for (const email of [...threadMap.values()].flat()) {
      db.upsertEmail({
        accountId: numAccountId,
        xGmMsgId: email.xGmMsgId,
        xGmThrid: email.xGmThrid,
        folder,
        folderUid: email.uid,
        fromAddress: email.fromAddress,
        fromName: email.fromName,
        toAddresses: email.toAddresses,
        ccAddresses: email.ccAddresses,
        bccAddresses: email.bccAddresses,
        subject: email.subject,
        textBody: email.textBody,
        htmlBody: email.htmlBody,
        date: email.date,
        isRead: email.isRead,
        isStarred: email.isStarred,
        isImportant: email.isImportant,
        isDraft: email.isDraft,
        snippet: email.snippet,
        size: email.size,
        hasAttachments: email.hasAttachments,
        labels: email.labels,
        messageId: email.messageId,
      });

      if (email.fromAddress) {
        db.upsertContact(email.fromAddress, email.fromName);
      }
    }

    // --- Resolve All Mail UIDs for newly synced emails ---
    // Best-effort: emails synced from a non-All Mail folder won't have an email_folders row
    // for [Gmail]/All Mail yet. Resolve and write those UIDs now so that All Mail
    // UID-diff reconciliation can track them correctly. Skip when syncing All Mail
    // itself (it already writes its own UIDs natively).
    if (folder !== ALL_MAIL_PATH && threadMap.size > 0) {
      try {
        const xGmMsgIds = [...threadMap.values()]
          .flat()
          .map((email) => email.xGmMsgId)
          .filter((id): id is string => id != null);
        if (xGmMsgIds.length > 0) {
          const uidMap = await imapService.resolveUidsByXGmMsgIdBatch(accountId, ALL_MAIL_PATH, xGmMsgIds);
          db.writeAllMailFolderUids(numAccountId, uidMap);
        }
      } catch (error) {
        log.warn(`[syncFolderInner] Failed to resolve All Mail UIDs for folder ${folder}:`, error);
      }
    }

    // --- Upsert threads ---
    const affectedThreadIds = new Set<string>();
    for (const [threadId, threadEmails] of threadMap) {
      const uniqueEmails = [...new Map(threadEmails.map((e) => [e.xGmMsgId, e])).values()];
      const latest = uniqueEmails.reduce((a, b) =>
        DateTime.fromISO(a.date).toMillis() > DateTime.fromISO(b.date).toMillis() ? a : b
      );
      const participants = formatParticipantList(uniqueEmails);
      const allRead = uniqueEmails.every((e) => e.isRead);
      const anyStarred = uniqueEmails.some((e) => e.isStarred);

      db.upsertThread({
        accountId: numAccountId,
        xGmThrid: threadId,
        subject: latest.subject,
        lastMessageDate: latest.date,
        participants,
        messageCount: uniqueEmails.length,
        snippet: latest.snippet,
        isRead: allRead,
        isStarred: anyStarred,
      });

      db.upsertThreadFolder(numAccountId, threadId, folder);
      affectedThreadIds.add(threadId);
    }

    for (const xGmThrid of affectedThreadIds) {
      try {
        db.recomputeThreadMetadata(numAccountId, xGmThrid);
      } catch (recomputeErr) {
        log.warn(`[SyncService] syncFolder: recomputeThreadMetadata failed for thread ${xGmThrid}:`, recomputeErr);
      }
    }

    // --- Filter evaluation for INBOX (within lock, after upserts) ---
    if (folder === 'INBOX') {
      try {
        log.debug(`[SyncService] syncFolder: triggering filter processing for account ${accountId}`);
        const filterService = FilterService.getInstance();
        const filterResult = await filterService.processNewEmails(numAccountId);
        log.debug(`[SyncService] syncFolder: filter done for account ${accountId}: ${filterResult.emailsMatched} matched, ${filterResult.actionsDispatched} dispatched`);
      } catch (filterErr) {
        log.warn(`[SyncService] syncFolder: filter processing failed for INBOX account ${accountId} (continuing):`, filterErr);
      }
    }

    // Fold email upsert changes into the result
    folderChangeCount += newCount + flagChangeCount;
    if (newCount > 0 || flagChangeCount > 0) {
      folderChanged = true;
      if (newCount > 0 && flagChangeCount > 0) {
        folderChangeType = 'mixed';
      } else if (newCount > 0) {
        folderChangeType = 'new_messages';
      } else if (flagChangeCount > 0) {
        folderChangeType = 'flag_changes';
      }
    }

    // --- Persist folder state ---
    db.upsertFolderState({
      accountId: numAccountId,
      folder,
      uidValidity: folderUidValidity,
      highestModseq: folderCondstoreSupported ? folderHighestModseq : null,
      condstoreSupported: folderCondstoreSupported,
    });

    // --- Desktop notifications for new INBOX emails ---
    if (newEmailsForNotification.length > 0) {
      this.accumulateNotification(accountId, folder, newEmailsForNotification);
    }

    log.info(`[SyncService] syncFolder: ${emails.length} fetched / ${newCount} new / ${flagChangeCount} changed from ${folder} for account ${accountId}`);

    return { uidValidityChanged, folderChanged, changeType: folderChangeType, changeCount: folderChangeCount };
  }

  // -----------------------------------------------------------------------
  // All Mail sync (called by MailQueueService.processSyncAllMail)
  // -----------------------------------------------------------------------

  /**
   * Central sync method: fetches from [Gmail]/All Mail and distributes emails
   * to their correct folders via X-GM-LABELS → folder path mapping.
   *
   * - Initial sync: date-based fetch (30-day window, limit 100)
   * - Incremental sync: CONDSTORE fetchChangedSince on All Mail
   * - For each email: upsert row, map labels → folders, reconcile email_folders
   * - Cleans orphans, recomputes thread metadata, runs INBOX filters
   * - Returns the set of affected folders for the queue worker to emit events
   *
   * @param accountId          Account ID as string.
   * @param isInitial          True for first-ever sync (no folder_state for All Mail).
   * @param sinceDate          For date-based fallback fetch.
   * @param knownMailboxPaths  Set of known IMAP folder paths (for label validation).
   * @returns Set of affected folder paths.
   */
  async syncAllMail(
    accountId: string,
    isInitial: boolean,
    sinceDate: Date,
    knownMailboxPaths: Set<string>,
  ): Promise<Set<string>> {
    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();
    const lockManager = FolderLockManager.getInstance();
    const numAccountId = Number(accountId);

    const affectedFolders = new Set<string>();
    const affectedThreadIds = new Set<string>();

    const existingFolderState = db.getFolderState(numAccountId, ALL_MAIL_PATH);

    // Acquire folder lock on All Mail for the IMAP fetch.
    const release = await lockManager.acquire(ALL_MAIL_PATH, accountId);
    try {
      // --- Mailbox status ---
      const mailboxStatus = await imapService.getMailboxStatus(accountId, ALL_MAIL_PATH);
      const allMailUidValidity = mailboxStatus.uidValidity;
      const allMailCondstoreSupported = mailboxStatus.condstoreSupported;
      let allMailHighestModseq: string | null = allMailCondstoreSupported ? mailboxStatus.highestModseq : null;

      // UIDVALIDITY reset: delete All Mail folder_state only (no email_folders entries to wipe).
      let uidValidityChanged = false;
      if (existingFolderState && existingFolderState.uidValidity !== mailboxStatus.uidValidity) {
        log.warn(`[SyncService] syncAllMail: UIDVALIDITY changed for All Mail (account ${accountId}): ${existingFolderState.uidValidity} -> ${mailboxStatus.uidValidity}. Deleting folder_state.`);
        db.deleteFolderState(numAccountId, ALL_MAIL_PATH);
        uidValidityChanged = true;
      }

      // --- Fetch emails ---
      const fetchLimit = isInitial ? 100 : 200;
      let emails: Awaited<ReturnType<typeof imapService.fetchEmails>> = [];

      const canUseCondstore =
        !uidValidityChanged &&
        allMailCondstoreSupported &&
        !!existingFolderState &&
        existingFolderState.uidValidity === mailboxStatus.uidValidity &&
        existingFolderState.condstoreSupported;

      if (canUseCondstore) {
        const changedSince = existingFolderState!.highestModseq ?? '0';
        const changed = await imapService.fetchChangedSince(accountId, ALL_MAIL_PATH, changedSince);

        const sorted = [...changed.emails].sort((a, b) => {
          const ma = BigInt(a.modseq ?? '0');
          const mb = BigInt(b.modseq ?? '0');
          if (ma < mb) {
            return -1;
          }
          if (ma > mb) {
            return 1;
          }
          return a.uid - b.uid;
        });
        emails = sorted.slice(0, fetchLimit);

        if (emails.length > 0) {
          let maxProcessed = BigInt(changedSince || '0');
          for (const email of emails) {
            const modseq = BigInt(email.modseq ?? '0');
            if (modseq > maxProcessed) {
              maxProcessed = modseq;
            }
          }
          allMailHighestModseq = String(maxProcessed);
        } else {
          allMailHighestModseq = changed.highestModseq;
        }
      } else {
        // Date-based fetch (initial sync or CONDSTORE not available / UIDVALIDITY reset)
        const fetchSinceDate = (uidValidityChanged || !existingFolderState)
          ? DateTime.utc().minus({ days: 30 }).toJSDate()
          : sinceDate;
        emails = await imapService.fetchEmails(accountId, ALL_MAIL_PATH, { limit: fetchLimit, since: fetchSinceDate });
      }

      // --- Process fetched emails (within a batch transaction for performance) ---
      const pendingOpService = PendingOpService.getInstance();
      let newInboxEmails = false;
      const rawDb = db.getDatabase();

      rawDb.transaction(() => {
      for (const email of emails) {
        const threadId = email.xGmThrid || email.xGmMsgId;

        // Skip emails with pending queue operations
        const pendingForThread = pendingOpService.getPendingForThread(numAccountId, threadId);
        if (pendingForThread.has(email.xGmMsgId)) {
          log.debug(`[SyncService] syncAllMail: skipping pending message ${email.xGmMsgId}`);
          continue;
        }

        // Upsert the email row (folder=ALL_MAIL_PATH → writes email_folders row with UID)
        db.upsertEmail({
          accountId: numAccountId,
          xGmMsgId: email.xGmMsgId,
          xGmThrid: email.xGmThrid,
          folder: ALL_MAIL_PATH,
          folderUid: email.uid,
          fromAddress: email.fromAddress,
          fromName: email.fromName,
          toAddresses: email.toAddresses,
          ccAddresses: email.ccAddresses,
          bccAddresses: email.bccAddresses,
          subject: email.subject,
          textBody: email.textBody,
          htmlBody: email.htmlBody,
          date: email.date,
          isRead: email.isRead,
          isStarred: email.isStarred,
          isImportant: email.isImportant,
          isDraft: email.isDraft,
          snippet: email.snippet,
          size: email.size,
          hasAttachments: email.hasAttachments,
          labels: email.labels,
          messageId: email.messageId,
        });

        // Upsert contact
        if (email.fromAddress) {
          db.upsertContact(email.fromAddress, email.fromName);
        }

        // Map raw labels → folder paths and reconcile email_folders.
        // If no labels map to known folders (archived email), use All Mail as a
        // fallback folder so the email retains at least one email_folders association
        // and doesn't get orphan-cleaned.
        const mappedPaths = mapLabelsToFolderPaths(email.rawLabels, knownMailboxPaths, numAccountId);
        const folderPaths = mappedPaths.length > 0 ? mappedPaths : [ALL_MAIL_PATH];
        const reconciled = db.reconcileEmailFolders(numAccountId, email.xGmMsgId, email.xGmThrid, folderPaths);
        for (const folder of reconciled) {
          affectedFolders.add(folder);
        }
        // Also add all current folder paths as affected (for new emails)
        for (const folder of folderPaths) {
          affectedFolders.add(folder);
        }

        // Track if any emails belong to INBOX (for filter processing)
        if (folderPaths.includes('INBOX')) {
          newInboxEmails = true;
        }

        // Upsert thread
        db.upsertThread({
          accountId: numAccountId,
          xGmThrid: threadId,
          subject: email.subject,
          lastMessageDate: email.date,
          participants: formatParticipant(email.fromAddress, email.fromName),
          messageCount: 1,
          snippet: email.snippet,
          isRead: email.isRead,
          isStarred: email.isStarred,
        });

        // Upsert thread_folders for each folder path
        for (const folder of folderPaths) {
          db.upsertThreadFolder(numAccountId, threadId, folder);
        }

        affectedThreadIds.add(threadId);
      }
      })();

      // --- UID diff: detect emails removed from All Mail since last sync ---
      // CONDSTORE only reports changes to existing messages; it does not surface server-side
      // deletions (EXPUNGE). Fetching all server UIDs and diffing against the local DB catches
      // emails that were trashed, spammed, or permanently deleted via another client.
      try {
        const uidDiffStart = Date.now();
        const serverUids = await imapService.fetchFolderUids(accountId, ALL_MAIL_PATH);
        const { staleCount, affectedFolders: reconcileAffected } = await this.reconcileFolderWithServerUids(accountId, ALL_MAIL_PATH, serverUids);
        const uidDiffMs = Date.now() - uidDiffStart;
        log.info(`[SyncService] syncAllMail: UID diff complete — ${staleCount} stale entr${staleCount === 1 ? 'y' : 'ies'} removed in ${uidDiffMs}ms (account ${accountId})`);
        for (const reconcileFolder of reconcileAffected) {
          affectedFolders.add(reconcileFolder);
        }
      } catch (uidDiffErr) {
        log.warn(`[SyncService] syncAllMail: UID diff failed (continuing):`, uidDiffErr);
      }

      // --- Orphan cleanup (safety net) ---
      // reconcileFolderWithServerUids() above already runs orphan cleanup internally,
      // so these calls will typically be no-ops. They are retained as a harmless safety net.
      try {
        const orphanEmails = db.removeOrphanedEmails(numAccountId);
        for (const orphan of orphanEmails) {
          if (orphan.xGmThrid) {
            affectedThreadIds.add(orphan.xGmThrid);
          }
        }
      } catch (orphanErr) {
        log.warn(`[SyncService] syncAllMail: removeOrphanedEmails failed (continuing):`, orphanErr);
      }

      try {
        db.removeOrphanedThreads(numAccountId);
      } catch (orphanErr) {
        log.warn(`[SyncService] syncAllMail: removeOrphanedThreads failed (continuing):`, orphanErr);
      }

      // --- Recompute thread metadata ---
      for (const xGmThrid of affectedThreadIds) {
        try {
          db.recomputeThreadMetadata(numAccountId, xGmThrid);
        } catch (recomputeErr) {
          log.warn(`[SyncService] syncAllMail: recomputeThreadMetadata failed for thread ${xGmThrid}:`, recomputeErr);
        }
      }

      // --- Filter processing for new INBOX emails ---
      if (newInboxEmails) {
        try {
          log.debug(`[SyncService] syncAllMail: triggering filter processing for account ${accountId}`);
          const filterService = FilterService.getInstance();
          const filterResult = await filterService.processNewEmails(numAccountId);
          log.debug(`[SyncService] syncAllMail: filter done for account ${accountId}: ${filterResult.emailsMatched} matched, ${filterResult.actionsDispatched} dispatched`);
        } catch (filterErr) {
          log.warn(`[SyncService] syncAllMail: filter processing failed for account ${accountId} (continuing):`, filterErr);
        }
      }

      // --- Persist folder state for All Mail ---
      db.upsertFolderState({
        accountId: numAccountId,
        folder: ALL_MAIL_PATH,
        uidValidity: allMailUidValidity,
        highestModseq: allMailCondstoreSupported ? allMailHighestModseq : null,
        condstoreSupported: allMailCondstoreSupported,
      });

      // --- One-time stale folder_state cleanup ---
      if (emails.length > 0) {
        try {
          const cleaned = db.cleanupStaleFolderStates(numAccountId, ['INBOX', ALL_MAIL_PATH]);
          if (cleaned > 0) {
            log.info(`[SyncService] syncAllMail: cleaned up ${cleaned} stale folder_state row(s) for account ${accountId}`);
          }
        } catch (cleanupErr) {
          log.warn(`[SyncService] syncAllMail: stale folder_state cleanup failed (continuing):`, cleanupErr);
        }
      }

      log.info(`[SyncService] syncAllMail: ${emails.length} emails processed, ${affectedFolders.size} folders affected for account ${accountId}`);
    } finally {
      release();
    }

    return affectedFolders;
  }

  // -----------------------------------------------------------------------
  // Per-thread sync (called by MailQueueService.processSyncThread)
  // -----------------------------------------------------------------------

  /**
   * Fetch thread bodies from IMAP and reconcile stale messages.
   * Fetches from [Gmail]/All Mail via ImapService.fetchThread(), upserts bodies to DB,
   * removes local messages no longer present on the server, and recomputes thread metadata.
   * Does not emit any events — the queue worker handles that.
   *
   * @param accountId Account ID as string.
   * @param xGmThrid  Gmail thread ID to fetch.
   */
  async syncThread(accountId: string, xGmThrid: string): Promise<void> {
    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();
    const numAccountId = Number(accountId);

    // Capture local message IDs before fetch (for stale-message detection).
    const localXGmMsgIds = new Set(
      db.getEmailsByThreadId(numAccountId, xGmThrid)
        .map((m) => String(m['xGmMsgId'] ?? ''))
        .filter(Boolean)
    );

    // Fetch thread from IMAP via [Gmail]/All Mail.
    const fetchedMessages = await imapService.fetchThread(accountId, xGmThrid);
    log.info(`[SyncService] syncThread: IMAP returned ${fetchedMessages.length} messages for thread ${xGmThrid} (account ${accountId})`);

    const serverXGmMsgIds = new Set(fetchedMessages.map((m) => m.xGmMsgId));
    const staleXGmMsgIds = [...localXGmMsgIds].filter((id) => !serverXGmMsgIds.has(id));

    // Upsert bodies for fetched messages.
    for (const fetched of fetchedMessages) {
      if (fetched.htmlBody || fetched.textBody) {
        db.upsertEmail({
          accountId: numAccountId,
          xGmMsgId: fetched.xGmMsgId,
          xGmThrid: fetched.xGmThrid,
          folder: fetched.folder,
          folderUid: fetched.uid,
          fromAddress: fetched.fromAddress,
          fromName: fetched.fromName,
          toAddresses: fetched.toAddresses,
          ccAddresses: fetched.ccAddresses,
          bccAddresses: fetched.bccAddresses,
          subject: fetched.subject,
          textBody: fetched.textBody,
          htmlBody: fetched.htmlBody,
          date: fetched.date,
          isRead: fetched.isRead,
          isStarred: fetched.isStarred,
          isImportant: fetched.isImportant,
          isDraft: fetched.isDraft,
          snippet: fetched.snippet,
          size: fetched.size,
          hasAttachments: fetched.hasAttachments,
          labels: fetched.labels,
          messageId: fetched.messageId,
        });

        // Persist attachment metadata if extracted during body parse
        if (fetched.attachments && fetched.attachments.length > 0) {
          try {
            db.upsertAttachmentsForEmail(numAccountId, fetched.xGmMsgId, fetched.attachments);
          } catch (attErr) {
            log.warn(`[SyncService] syncThread: failed to persist attachments for ${fetched.xGmMsgId}:`, attErr);
          }
        }
      }
    }

    // Resolve All Mail UIDs for all fetched messages (messages fetched from a non-All Mail
    // folder will not have an All Mail email_folders row yet).
    try {
      const xGmMsgIdsToResolve = fetchedMessages
        .filter((message) => message.folder !== ALL_MAIL_PATH)
        .map((message) => message.xGmMsgId)
        .filter(Boolean);
      if (xGmMsgIdsToResolve.length > 0) {
        const uidMap = await imapService.resolveUidsByXGmMsgIdBatch(accountId, ALL_MAIL_PATH, xGmMsgIdsToResolve);
        db.writeAllMailFolderUids(numAccountId, uidMap);
      }
    } catch (allMailUidErr) {
      log.warn(`[SyncService] syncThread: failed to resolve All Mail UIDs for thread ${xGmThrid} (continuing):`, allMailUidErr);
    }

    // Reconcile stale messages (local-only messages no longer on server).
    if (staleXGmMsgIds.length > 0) {
      for (const xGmMsgId of staleXGmMsgIds) {
        db.removeEmailAndAssociations(numAccountId, xGmMsgId);
      }
      log.info(`[SyncService] syncThread: removed ${staleXGmMsgIds.length} stale message(s) from thread ${xGmThrid} (account ${accountId})`);
    }

    db.recomputeThreadMetadata(numAccountId, xGmThrid);
  }

  // -----------------------------------------------------------------------
  // Folder reconciliation (DB-only, no lock needed — callers manage locks)
  // -----------------------------------------------------------------------

  /**
   * DB-only reconciliation given a pre-fetched set of server UIDs.
   * Does NOT acquire the folder lock — caller must have already fetched UIDs
   * (and may still hold the lock or have released it; the DB work is lock-free).
   *
   * Called by syncFolder() after it has already fetched emails and UIDs with the folder lock.
   * Also called by MailQueueService.reconcileFolder() for post-op Starred reconciliation.
   *
   * When called for ALL_MAIL_PATH: performs a cascade purge via removeAllEmailFolderAssociations(),
   * stripping stale emails from every folder except Trash and Spam.
   * When called for any other folder: removes only the specific folder's stale associations.
   *
   * @returns staleCount     - Number of stale All Mail entries detected (same meaning as before).
   * @returns affectedFolders - Folder paths that had associations removed (for UI refresh).
   */
  async reconcileFolderWithServerUids(
    accountId: string,
    folder: string,
    serverUids: number[],
  ): Promise<{ staleCount: number; affectedFolders: Set<string> }> {
    const db = DatabaseService.getInstance();
    const numAccountId = Number(accountId);

    const serverUidSet = new Set(serverUids);

    // Query local DB for all (emailId, uid) pairs associated with this folder
    const localFolderUids = db.getEmailFolderUids(numAccountId, folder);

    // Find stale local entries: present locally but not on server
    const staleEntries = localFolderUids.filter((entry) => !serverUidSet.has(entry.uid));

    if (staleEntries.length === 0) {
      return { staleCount: 0, affectedFolders: new Set() };
    }

    log.info(`[SyncService] reconcileFolder: removing ${staleEntries.length} stale email-folder associations from ${folder} for account ${accountId}`);

    // Collect affected thread IDs before modifying associations
    const affectedGmailThreadIds = new Set<string>();
    for (const stale of staleEntries) {
      const email = db.getEmailByXGmMsgId(numAccountId, stale.xGmMsgId);
      if (email) {
        const threadId = String(email['xGmThrid'] || '');
        if (threadId) {
          affectedGmailThreadIds.add(threadId);
        }
      }
    }

    const staleXGmMsgIds = staleEntries.map((entry) => entry.xGmMsgId);
    let affectedFolders: Set<string>;

    if (folder === ALL_MAIL_PATH) {
      // Cascade purge: strip stale emails from every folder except Trash and Spam.
      // This handles the case where an email was permanently deleted from All Mail —
      // we remove its folder associations everywhere except soft-delete locations.
      const trashFolder = db.getTrashFolder(numAccountId);
      const purgeResult = db.removeAllEmailFolderAssociations(numAccountId, staleXGmMsgIds, trashFolder, '[Gmail]/Spam');

      // Merge thread IDs affected by the cascade purge into our set for metadata recompute
      for (const xGmThrid of purgeResult.affectedThreadIds) {
        affectedGmailThreadIds.add(xGmThrid);
      }

      // The affected folders are everything the cascade purge touched, plus All Mail itself
      affectedFolders = new Set(purgeResult.affectedFolderPaths);
      affectedFolders.add(ALL_MAIL_PATH);
    } else {
      // Non-All Mail: remove only the stale associations for this specific folder
      db.removeStaleEmailFolderAssociations(numAccountId, folder, staleXGmMsgIds);
      affectedFolders = new Set([folder]);
    }

    // Remove orphan emails (emails with zero email_folders associations)
    try {
      const orphanEmails = db.removeOrphanedEmails(numAccountId);
      if (orphanEmails.length > 0) {
        log.info(`[SyncService] reconcileFolder: removed ${orphanEmails.length} orphan email(s) for account ${accountId}`);
        for (const orphan of orphanEmails) {
          if (orphan.xGmThrid) {
            affectedGmailThreadIds.add(orphan.xGmThrid);
          }
        }
      }
    } catch (orphanErr) {
      log.warn(`[SyncService] reconcileFolder: removeOrphanedEmails failed (continuing):`, orphanErr);
    }

    // Recompute thread metadata for all affected threads
    for (const xGmThrid of affectedGmailThreadIds) {
      try {
        db.recomputeThreadMetadata(numAccountId, xGmThrid);
      } catch (recomputeErr) {
        log.warn(`[SyncService] reconcileFolder: recomputeThreadMetadata failed for thread ${xGmThrid}:`, recomputeErr);
      }
    }

    // Remove orphaned threads
    try {
      const orphansRemoved = db.removeOrphanedThreads(numAccountId);
      if (orphansRemoved > 0) {
        log.info(`[SyncService] reconcileFolder: removed ${orphansRemoved} orphaned thread(s) for account ${accountId}`);
      }
    } catch (orphanThreadErr) {
      log.warn(`[SyncService] reconcileFolder: removeOrphanedThreads failed (continuing):`, orphanThreadErr);
    }

    return { staleCount: staleEntries.length, affectedFolders };
  }

  // -----------------------------------------------------------------------
  // IDLE management
  // -----------------------------------------------------------------------

  /**
   * Start IDLE on the INBOX for real-time updates.
   * Uses a dedicated IMAP connection. On new mail, calls the provided onNewMail callback
   * (typically SyncQueueBridge.enqueueInboxSync). Reconnects with exponential backoff on disconnect.
   *
   * The optional lifecycleToken provides post-connect lifecycle validation: after the IMAP
   * connect await returns (which may take several seconds), startIdle re-checks whether the
   * token is still current and whether global suppression is active. If the lifecycle state
   * changed while the connection was in flight (e.g. pause/sleep-stop/reset fired), the
   * newly-opened IDLE connection is torn down immediately and the method returns without
   * leaving a stale IDLE connection alive.
   *
   * @param accountId      Account ID as string.
   * @param onNewMail      Callback invoked when the server signals new mail has arrived.
   * @param lifecycleToken Optional token for post-connect lifecycle validation.
   */
  async startIdle(
    accountId: string,
    onNewMail: () => void,
    lifecycleToken?: IdleLifecycleToken,
  ): Promise<void> {
    if (this.idleAccounts.has(accountId)) {
      return;
    }

    // Store callback so scheduleIdleReconnect() can pass it again on reconnect.
    this.idleNewMailCallbacks.set(accountId, onNewMail);

    try {
      const imapService = ImapService.getInstance();
      this.idleAccounts.add(accountId);
      this.idleReconnectDelay.set(accountId, 2000); // Reset backoff

      // Suppress reconnect during the connection phase (connectIdle tears down
      // any existing IDLE connection, which fires onClose — we don't want that
      // to trigger a reconnect).
      this.idleSuppressReconnect.add(accountId);

      await imapService.startIdle(
        accountId,
        'INBOX',
        // onNewMail callback — enqueues via SyncQueueBridge (passed in by caller)
        onNewMail,
        // onExpunge callback — not needed for INBOX IDLE (All Mail handles expunge detection)
        undefined,
        // onClose callback — reconnect with backoff (unless intentionally stopped)
        () => {
          this.idleAccounts.delete(accountId);
          if (!this.idleSuppressReconnect.has(accountId)) {
            this.scheduleIdleReconnect(accountId);
          }
        },
        // onError callback
        (err: Error) => {
          log.error(`[IDLE] Connection error for account ${accountId}:`, err);
          this.idleAccounts.delete(accountId);
          if (!this.idleSuppressReconnect.has(accountId)) {
            this.scheduleIdleReconnect(accountId);
          }
        },
      );

      // Post-connect lifecycle check: the IMAP connection attempt above is async and may
      // take several seconds. If pause(), stopForSleep(), or resetForTesting() ran while
      // it was in flight, the lifecycle token will have changed (or global suppression will
      // be active). In that case, tear down the connection we just opened and return without
      // leaving a stale IDLE connection alive.
      if (lifecycleToken && !lifecycleToken.isValid()) {
        log.warn(
          `[IDLE] startIdle: lifecycle state changed while INBOX IDLE connect was in flight ` +
          `for account ${accountId} — tearing down stale connection`,
        );
        // Suppress reconnect so the teardown disconnect does not reschedule.
        this.idleSuppressReconnect.add(accountId);
        this.idleAccounts.delete(accountId);
        this.idleNewMailCallbacks.delete(accountId);
        await imapService.disconnectIdle(accountId, 'INBOX').catch((disconnectErr) => {
          log.warn(`[IDLE] startIdle: failed to disconnect stale INBOX IDLE for account ${accountId}:`, disconnectErr);
        });
        return;
      }

      // Connection established and lifecycle is still valid — clear suppress flag so
      // future disconnects trigger reconnect.
      this.idleSuppressReconnect.delete(accountId);

      log.info(`[IDLE] Started on INBOX for account ${accountId}`);
    } catch (err) {
      this.idleSuppressReconnect.delete(accountId);
      this.idleAccounts.delete(accountId);
      log.warn(`Failed to start IDLE for account ${accountId}:`, err);
      this.scheduleIdleReconnect(accountId);
    }
  }

  /**
   * Schedule an IDLE reconnection with exponential backoff.
   */
  private scheduleIdleReconnect(accountId: string): void {
    // If global pause is active, do not schedule any reconnect timers.
    if (this.globalIdleSuppression) {
      log.info(`[IDLE] scheduleIdleReconnect: skipped for account ${accountId} — global reconnect suppression is active`);
      return;
    }

    // Clear any existing reconnect timer
    const existingTimer = this.idleReconnectTimers.get(accountId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const delay = this.idleReconnectDelay.get(accountId) || 2000;
    log.info(`[IDLE] Scheduling reconnect for account ${accountId} in ${delay}ms`);

    const timer = setTimeout(async () => {
      this.idleReconnectTimers.delete(accountId);

      // Re-check suppression immediately — pause/sleep-stop/reset may have fired
      // after the timer was scheduled but before it fired.
      if (this.globalIdleSuppression || this.idleSuppressReconnect.has(accountId)) {
        log.info(`[IDLE] scheduleIdleReconnect: suppression active at fire time for account ${accountId} — skipping reconnect`);
        return;
      }

      try {
        // Get a fresh access token (handles refresh automatically)
        const oauthService = OAuthService.getInstance();
        await oauthService.getAccessToken(accountId);
      } catch (err) {
        log.warn(`[IDLE] Token refresh failed for account ${accountId} — stopping IDLE:`, err);
        return; // Don't retry — account likely needs reauth
      }

      // Re-check suppression again after the async token refresh — a pause/sleep-stop/reset
      // may have arrived while getAccessToken was awaiting.
      if (this.globalIdleSuppression || this.idleSuppressReconnect.has(accountId)) {
        log.info(`[IDLE] scheduleIdleReconnect: suppression became active during token refresh for account ${accountId} — skipping reconnect`);
        return;
      }

      // Build a lifecycle token so startIdle can tear down the connection if lifecycle
      // changes again while the IMAP connect is in flight.
      // Capture the current generation: if stopIdle/setGlobalIdleSuppression increments
      // the generation before the async connect resolves, isValid() will return false,
      // ensuring the new connection is immediately torn down.
      const capturedGeneration = this.idleLifecycleGeneration;
      const lifecycleToken: IdleLifecycleToken = {
        isValid: () =>
          this.idleLifecycleGeneration === capturedGeneration &&
          !this.globalIdleSuppression &&
          !this.idleSuppressReconnect.has(accountId),
      };

      // Re-use the stored callback for the new IDLE connection.
      const storedCallback = this.idleNewMailCallbacks.get(accountId) ?? (() => {});
      await this.startIdle(accountId, storedCallback, lifecycleToken);
    }, delay);

    this.idleReconnectTimers.set(accountId, timer);

    // Increase backoff: 2s → 4s → 8s → 16s → 32s → 60s cap
    const nextDelay = Math.min(delay * 2, 60_000);
    this.idleReconnectDelay.set(accountId, nextDelay);
  }

  /**
   * Stop IDLE for a specific account.
   */
  async stopIdle(accountId: string): Promise<void> {
    this.idleAccounts.delete(accountId);
    this.idleNewMailCallbacks.delete(accountId);

    // Suppress reconnect — this is an intentional stop.
    // Increment the lifecycle generation so any in-flight reconnect tokens from
    // a previous epoch see isValid()=false even after suppression flags are lifted.
    this.idleLifecycleGeneration++;
    this.idleSuppressReconnect.add(accountId);

    // Clear reconnect timer
    const timer = this.idleReconnectTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.idleReconnectTimers.delete(accountId);
    }

    // Clear notification batch
    const batch = this.notificationBatches.get(accountId);
    if (batch) {
      clearTimeout(batch.timer);
      this.notificationBatches.delete(accountId);
    }

    try {
      const imapService = ImapService.getInstance();
      await imapService.disconnectIdle(accountId, 'INBOX');
      log.info(`[IDLE] Stopped for account ${accountId}`);
    } catch (err) {
      log.warn(`Failed to stop IDLE for account ${accountId}:`, err);
    }
  }

  /**
   * Stop all IDLE connections and cleanup.
   */
  async stopAllIdle(): Promise<void> {
    const accountIds = Array.from(this.idleAccounts);
    const promises = accountIds.map((id) => this.stopIdle(id));

    // Also clear any reconnect timers for accounts not in idleAccounts
    for (const [accountId, timer] of this.idleReconnectTimers) {
      clearTimeout(timer);
      this.idleReconnectTimers.delete(accountId);
    }

    // Stop All Mail IDLE connections for all accounts that have one
    const allMailAccountIds = Array.from(this.idleAllMailAccounts);
    const allMailPromises = allMailAccountIds.map((id) => this.stopIdleAllMail(id));

    await Promise.allSettled([...promises, ...allMailPromises]);
    log.info('[IDLE] All IDLE connections stopped');
  }

  /**
   * Reset ALL IDLE state for test isolation.
   *
   * Intended to be called by quiesceAndRestore() BEFORE the IMAP disconnect so that
   * the onClose callbacks fired by disconnectAllAndClearPending() cannot schedule new
   * reconnect timers for the next suite.
   *
   * Steps performed (synchronous — no IMAP I/O):
   *   1. Set globalIdleSuppression=true so scheduleIdleReconnect() and
   *      scheduleIdleAllMailReconnect() are no-ops even if they are called
   *      concurrently from a firing onClose callback.
   *   2. Cancel every pending INBOX reconnect timer.
   *   3. Cancel every pending All Mail reconnect timer.
   *   4. Clear all stored onNewMail / onExpunge callbacks (stale closures from
   *      the previous suite should never be called by the next suite's reconnects).
   *   5. Clear the idleAccounts / idleAllMailAccounts tracking sets so any in-flight
   *      onClose callback that inspects them finds nothing.
   *   6. Clear all reconnect delay state (resets backoff for the next suite).
   *   7. Clear all suppress-reconnect sets (no lingering per-account suppression).
   *
   * NOTE: globalIdleSuppression remains true after this call.
   * seedTestAccount() calls SyncService.setGlobalIdleSuppression(false) via
   * SyncQueueBridge.resumeForTesting() — which calls bridge.start() which in turn
   * starts IDLE fresh for the new suite.  Tests that start IDLE manually
   * (e.g. mail-sync-idle.test.ts) explicitly call setGlobalIdleSuppression(false)
   * or rely on the fact that startIdle() / startIdleAllMail() are called after
   * the new suite's quiesce+seed cycle is complete.
   *
   * NOT intended for production use.
   */
  resetIdleStateForTesting(): void {
    // Step 1: suppress all future reconnect scheduling until the new suite is ready.
    // Also increment the lifecycle generation to invalidate any in-flight reconnect
    // tokens — ensuring stale IDLE connects from a previous epoch cannot establish
    // themselves after suppression is lifted for the new suite.
    this.globalIdleSuppression = true;
    this.idleLifecycleGeneration++;

    // Step 2 & 3: cancel all pending reconnect timers (INBOX and All Mail).
    for (const [accountId, timer] of this.idleReconnectTimers) {
      clearTimeout(timer);
      this.idleReconnectTimers.delete(accountId);
    }
    for (const [accountId, timer] of this.idleAllMailReconnectTimers) {
      clearTimeout(timer);
      this.idleAllMailReconnectTimers.delete(accountId);
    }

    // Step 4: clear stored callbacks so stale closures cannot reach the next suite.
    this.idleNewMailCallbacks.clear();
    this.idleAllMailCallbacks.clear();

    // Step 5: clear account tracking sets.
    this.idleAccounts.clear();
    this.idleAllMailAccounts.clear();

    // Step 6: reset reconnect backoff delay maps.
    this.idleReconnectDelay.clear();
    this.idleAllMailReconnectDelay.clear();

    // Step 7: clear per-account suppress-reconnect sets.
    this.idleSuppressReconnect.clear();
    this.idleAllMailSuppressReconnect.clear();

    // Clear notification batches so timers from the previous suite don't fire.
    for (const [accountId, batch] of this.notificationBatches) {
      clearTimeout(batch.timer);
      this.notificationBatches.delete(accountId);
    }

    // Suppress all future desktop notifications for the remainder of this test process.
    // This is a one-way latch — once set, notifications stay disabled until the process exits.
    // It is safe to call this every time quiesceAndRestore() runs because the flag is idempotent.
    this.notificationsDisabled = true;

    log.debug('[SyncService] resetIdleStateForTesting: IDLE state cleared (globalIdleSuppression=true)');
  }

  /**
   * Disable OS-level desktop notifications for the lifetime of the test process.
   *
   * Calling resetIdleStateForTesting() already sets this flag, so callers that use
   * the full reset do not need to call this separately. Kept as a standalone method
   * for cases where only notification suppression is needed without a full IDLE reset.
   *
   * NOT intended for production use.
   */
  disableNotificationsForTesting(): void {
    this.notificationsDisabled = true;
  }

  // -----------------------------------------------------------------------
  // All Mail IDLE management
  // -----------------------------------------------------------------------

  /**
   * Start IDLE on [Gmail]/All Mail for real-time expunge (deletion) detection.
   * Uses a dedicated IMAP connection independent from the INBOX IDLE connection.
   * On expunge, calls the provided onExpunge callback (typically SyncQueueBridge.enqueueAllMailSync).
   * Reconnects with exponential backoff on disconnect.
   *
   * The optional lifecycleToken provides post-connect lifecycle validation: after the IMAP
   * connect await returns, startIdleAllMail re-checks whether the token is still current and
   * whether global suppression is active. If the lifecycle state changed while the connection
   * was in flight (e.g. pause/sleep-stop/reset fired), the newly-opened IDLE connection is
   * torn down immediately and the method returns without leaving a stale IDLE connection alive.
   *
   * @param accountId      Account ID as string.
   * @param onExpunge      Callback invoked when the server signals a message was expunged.
   * @param lifecycleToken Optional token for post-connect lifecycle validation.
   */
  async startIdleAllMail(
    accountId: string,
    onExpunge: (accountId: string) => void,
    lifecycleToken?: IdleLifecycleToken,
  ): Promise<void> {
    if (this.idleAllMailAccounts.has(accountId)) {
      return;
    }

    // Store callback so scheduleIdleAllMailReconnect() can pass it again on reconnect.
    this.idleAllMailCallbacks.set(accountId, onExpunge);

    try {
      const imapService = ImapService.getInstance();
      this.idleAllMailAccounts.add(accountId);
      this.idleAllMailReconnectDelay.set(accountId, 2000); // Reset backoff

      // Suppress reconnect during the connection phase (connectIdle tears down
      // any existing IDLE connection, which fires onClose — we don't want that
      // to trigger a reconnect).
      this.idleAllMailSuppressReconnect.add(accountId);

      await imapService.startIdle(
        accountId,
        ALL_MAIL_PATH,
        // onNewMail — no-op; INBOX IDLE handles new mail with lower latency
        () => {},
        // onExpunge — the reason this IDLE connection exists
        () => {
          log.info(`[IDLE] EXPUNGE detected on All Mail for account ${accountId} — scheduling reconcile sync`);
          onExpunge(accountId);
        },
        // onClose callback — reconnect with backoff (unless intentionally stopped)
        () => {
          this.idleAllMailAccounts.delete(accountId);
          if (!this.idleAllMailSuppressReconnect.has(accountId)) {
            this.scheduleIdleAllMailReconnect(accountId);
          }
        },
        // onError callback
        (err: Error) => {
          log.error(`[IDLE] All Mail connection error for account ${accountId}:`, err);
          this.idleAllMailAccounts.delete(accountId);
          if (!this.idleAllMailSuppressReconnect.has(accountId)) {
            this.scheduleIdleAllMailReconnect(accountId);
          }
        },
      );

      // Post-connect lifecycle check: the IMAP connection attempt above is async and may
      // take several seconds. If pause(), stopForSleep(), or resetForTesting() ran while
      // it was in flight, the lifecycle token will have changed (or global suppression will
      // be active). In that case, tear down the connection we just opened and return without
      // leaving a stale IDLE connection alive.
      if (lifecycleToken && !lifecycleToken.isValid()) {
        log.warn(
          `[IDLE] startIdleAllMail: lifecycle state changed while All Mail IDLE connect was in flight ` +
          `for account ${accountId} — tearing down stale connection`,
        );
        // Suppress reconnect so the teardown disconnect does not reschedule.
        this.idleAllMailSuppressReconnect.add(accountId);
        this.idleAllMailAccounts.delete(accountId);
        this.idleAllMailCallbacks.delete(accountId);
        await imapService.disconnectIdle(accountId, ALL_MAIL_PATH).catch((disconnectErr) => {
          log.warn(`[IDLE] startIdleAllMail: failed to disconnect stale All Mail IDLE for account ${accountId}:`, disconnectErr);
        });
        return;
      }

      // Connection established and lifecycle is still valid — clear suppress flag so
      // future disconnects trigger reconnect.
      this.idleAllMailSuppressReconnect.delete(accountId);

      log.info(`[IDLE] Started on All Mail for account ${accountId}`);
    } catch (err) {
      this.idleAllMailSuppressReconnect.delete(accountId);
      this.idleAllMailAccounts.delete(accountId);
      log.warn(`Failed to start All Mail IDLE for account ${accountId}:`, err);
      this.scheduleIdleAllMailReconnect(accountId);
    }
  }

  /**
   * Schedule an All Mail IDLE reconnection with exponential backoff.
   * Uses the same globalIdleSuppression flag as the INBOX IDLE reconnect scheduler.
   */
  private scheduleIdleAllMailReconnect(accountId: string): void {
    // If global pause is active, do not schedule any reconnect timers.
    if (this.globalIdleSuppression) {
      log.info(`[IDLE] scheduleIdleAllMailReconnect: skipped for account ${accountId} — global reconnect suppression is active`);
      return;
    }

    // Clear any existing reconnect timer
    const existingTimer = this.idleAllMailReconnectTimers.get(accountId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const delay = this.idleAllMailReconnectDelay.get(accountId) || 2000;
    log.info(`[IDLE] Scheduling All Mail reconnect for account ${accountId} in ${delay}ms`);

    const timer = setTimeout(async () => {
      this.idleAllMailReconnectTimers.delete(accountId);

      // Re-check suppression immediately — pause/sleep-stop/reset may have fired
      // after the timer was scheduled but before it fired.
      if (this.globalIdleSuppression || this.idleAllMailSuppressReconnect.has(accountId)) {
        log.info(`[IDLE] scheduleIdleAllMailReconnect: suppression active at fire time for account ${accountId} — skipping reconnect`);
        return;
      }

      try {
        // Get a fresh access token (handles refresh automatically)
        const oauthService = OAuthService.getInstance();
        await oauthService.getAccessToken(accountId);
      } catch (err) {
        log.warn(`[IDLE] Token refresh failed for account ${accountId} (All Mail) — stopping IDLE:`, err);
        return; // Don't retry — account likely needs reauth
      }

      // Re-check suppression again after the async token refresh — a pause/sleep-stop/reset
      // may have arrived while getAccessToken was awaiting.
      if (this.globalIdleSuppression || this.idleAllMailSuppressReconnect.has(accountId)) {
        log.info(`[IDLE] scheduleIdleAllMailReconnect: suppression became active during token refresh for account ${accountId} — skipping reconnect`);
        return;
      }

      // Build a lifecycle token so startIdleAllMail can tear down the connection if lifecycle
      // changes again while the IMAP connect is in flight.
      // Capture the current generation: if stopIdleAllMail/setGlobalIdleSuppression increments
      // the generation before the async connect resolves, isValid() will return false,
      // ensuring the new connection is immediately torn down.
      const capturedGeneration = this.idleLifecycleGeneration;
      const lifecycleToken: IdleLifecycleToken = {
        isValid: () =>
          this.idleLifecycleGeneration === capturedGeneration &&
          !this.globalIdleSuppression &&
          !this.idleAllMailSuppressReconnect.has(accountId),
      };

      // Re-use the stored callback for the new IDLE connection.
      const storedCallback = this.idleAllMailCallbacks.get(accountId) ?? ((_id: string) => {});
      await this.startIdleAllMail(accountId, storedCallback, lifecycleToken);
    }, delay);

    this.idleAllMailReconnectTimers.set(accountId, timer);

    // Increase backoff: 2s → 4s → 8s → 16s → 32s → 60s cap
    const nextDelay = Math.min(delay * 2, 60_000);
    this.idleAllMailReconnectDelay.set(accountId, nextDelay);
  }

  /**
   * Stop All Mail IDLE for a specific account.
   */
  async stopIdleAllMail(accountId: string): Promise<void> {
    this.idleAllMailAccounts.delete(accountId);
    this.idleAllMailCallbacks.delete(accountId);

    // Suppress reconnect — this is an intentional stop.
    // Increment the lifecycle generation so any in-flight reconnect tokens from
    // a previous epoch see isValid()=false even after suppression flags are lifted.
    this.idleLifecycleGeneration++;
    this.idleAllMailSuppressReconnect.add(accountId);

    // Clear reconnect timer
    const timer = this.idleAllMailReconnectTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.idleAllMailReconnectTimers.delete(accountId);
    }

    // Clear delay state
    this.idleAllMailReconnectDelay.delete(accountId);

    try {
      const imapService = ImapService.getInstance();
      await imapService.disconnectIdle(accountId, ALL_MAIL_PATH);
      log.info(`[IDLE] All Mail stopped for account ${accountId}`);
    } catch (err) {
      log.warn(`Failed to stop All Mail IDLE for account ${accountId}:`, err);
    }
  }

  // -----------------------------------------------------------------------
  // Notification batching
  // -----------------------------------------------------------------------

  /**
   * Accumulate new emails for notification batching.
   * On first new email, starts a 3-second timer.
   * When timer fires, emits mail:new-email event and shows desktop notification.
   */
  private accumulateNotification(accountId: string, folder: string, newEmails: NewEmailInfo[]): void {
    let batch = this.notificationBatches.get(accountId);

    if (!batch) {
      batch = {
        timer: setTimeout(() => {
          this.flushNotificationBatch(accountId, folder);
        }, 3000),
        emails: [],
      };
      this.notificationBatches.set(accountId, batch);
    }

    batch.emails.push(...newEmails);
  }

  /**
   * Flush the notification batch: emit event to renderer + show desktop notification.
   * Dedupes by xGmMsgId so racing IDLE triggers don't show the same email twice.
   */
  private flushNotificationBatch(accountId: string, folder: string): void {
    const batch = this.notificationBatches.get(accountId);
    this.notificationBatches.delete(accountId);

    if (!batch || batch.emails.length === 0) {
      return;
    }

    const seen = new Set<string>();
    const deduped = batch.emails.filter((e) => {
      if (seen.has(e.xGmMsgId)) {
        return false;
      }
      seen.add(e.xGmMsgId);
      return true;
    });
    if (deduped.length === 0) {
      return;
    }

    const numAccountId = Number(accountId);
    const payload = {
      accountId: numAccountId,
      folder,
      newEmails: deduped,
      totalNewCount: deduped.length,
    };

    // Emit to renderer
    this.emitToRenderer(IPC_EVENTS.MAIL_NEW_EMAIL, payload);

    // Refresh tray badge so the unread count stays current after new mail arrives
    try {
      TrayService.getInstance().refreshUnreadCount();
    } catch {
      // TrayService may not be initialized (e.g. during tests)
    }

    // Show desktop notification
    this.showDesktopNotification(numAccountId, folder, deduped);
  }

  /**
   * Show an OS-level desktop notification for new emails.
   */
  private showDesktopNotification(accountId: number, folder: string, emails: NewEmailInfo[]): void {
    try {
      if (this.notificationsDisabled) {
        return;
      }

      if (!Notification.isSupported()) {
        return;
      }

      let title: string;
      let body: string;
      let clickThreadId: string | null = null;

      if (emails.length === 1) {
        const email = emails[0];
        title = email.sender;
        body = email.subject || '(no subject)';
        clickThreadId = email.xGmThrid;
      } else {
        title = `${emails.length} new emails`;
        const senders = [...new Set(emails.map((e) => e.sender))];
        if (senders.length <= 2) {
          body = `From ${senders.join(' and ')}`;
        } else {
          body = `From ${senders[0]}, ${senders[1]}, and ${senders.length - 2} other${senders.length - 2 > 1 ? 's' : ''}`;
        }
      }

      let icon: ReturnType<typeof nativeImage.createFromPath> | undefined;
      try {
        const iconPath = path.join(app.getAppPath(), 'assets', 'icons', 'icon.png');
        icon = nativeImage.createFromPath(iconPath);
        if (icon.isEmpty()) {
          icon = undefined;
        }
      } catch {
        icon = undefined;
      }

      const notification = new Notification({ title, body, ...(icon ? { icon } : {}) });

      notification.on('click', () => {
        // Use TrayService so the main window is shown when app is in tray (window is hidden, not just minimized).
        TrayService.getInstance().openMailFromNotification({
          accountId,
          xGmThrid: clickThreadId || '',
          folder,
        });
      });

      notification.show();
    } catch (err) {
      log.warn('Failed to show desktop notification:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Event emission helpers
  // -----------------------------------------------------------------------

  private emitFolderUpdated(
    accountId: number,
    folders: string[],
    reason: MailFolderUpdatedPayload['reason'],
    changeType: MailFolderUpdatedPayload['changeType'] = 'mixed',
    count?: number,
  ): void {
    const payload: MailFolderUpdatedPayload = {
      accountId,
      folders,
      reason,
      changeType,
      count,
    };
    this.emitToRenderer(IPC_EVENTS.MAIL_FOLDER_UPDATED, payload);
  }

  /**
   * Emit any event to all renderer windows.
   */
  private emitToRenderer(channel: string, payload: unknown): void {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      }
    } catch {
      // Window may not exist yet during startup
    }
  }
}
