import { BrowserWindow } from 'electron';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';

const log = LoggerService.getInstance();
import { MailQueueService } from './mail-queue-service';
import { IPC_EVENTS } from '../ipc/ipc-channels';

// ---- Types ----

interface FilterCondition {
  field: 'from' | 'to' | 'subject' | 'body' | 'has-attachment';
  operator: 'contains' | 'equals' | 'starts-with' | 'ends-with' | 'matches';
  value: string;
}

interface FilterAction {
  type: 'archive' | 'delete' | 'star' | 'mark-read' | 'move';
  value?: string;
}

interface ParsedFilter {
  id: number;
  name: string;
  conditions: FilterCondition[];
  actions: FilterAction[];
  sortOrder: number;
}

interface EmailData {
  id: number;
  xGmMsgId: string;
  xGmThrid: string;
  fromAddress: string;
  fromName: string;
  toAddresses: string;
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  hasAttachments: boolean;
}

export interface FilterApplyResult {
  emailsProcessed: number;
  emailsMatched: number;
  actionsDispatched: number;
  errors: number;
}

// ---- FilterService ----

export class FilterService {
  private static instance: FilterService;
  /** Per-account guard to prevent concurrent filter processing */
  private processingAccounts = new Set<number>();

  private constructor() {}

  static getInstance(): FilterService {
    if (!FilterService.instance) {
      FilterService.instance = new FilterService();
    }
    return FilterService.instance;
  }

  /**
   * Process all unfiltered INBOX emails for a given account.
   * Called by SyncService after INBOX sync/IDLE, and by manual "Run Filters Now".
   * Returns result stats for the manual trigger UI.
   */
  async processNewEmails(accountId: number): Promise<FilterApplyResult> {
    const result: FilterApplyResult = {
      emailsProcessed: 0,
      emailsMatched: 0,
      actionsDispatched: 0,
      errors: 0,
    };

    // Per-account concurrency guard: skip if already processing
    if (this.processingAccounts.has(accountId)) {
      log.info(`[FilterService] Already processing filters for account ${accountId}, skipping`);
      return result;
    }
    this.processingAccounts.add(accountId);

    log.info(`[FilterService] Starting filter processing for account ${accountId}`);

    try {
      const db = DatabaseService.getInstance();

      // Load enabled filters for this account
      const rawFilters = db.getEnabledFiltersOrdered(accountId);
      log.debug(`[FilterService] Loaded ${rawFilters.length} enabled filter(s) for account ${accountId}`);
      
      if (rawFilters.length === 0) {
        // No filters — still mark emails as filtered so we don't re-check
        const emails = db.getUnfilteredInboxEmails(accountId);
        if (emails.length > 0) {
          log.debug(`[FilterService] No filters enabled, marking ${emails.length} email(s) as filtered`);
          db.markEmailsAsFiltered(emails.map(e => e.id));
          result.emailsProcessed = emails.length;
        } else {
          log.debug(`[FilterService] No filters enabled and no unfiltered emails`);
        }
        return result;
      }

      // Parse filter conditions and actions from JSON strings
      const filters = this.parseFilters(rawFilters);
      log.debug(`[FilterService] Successfully parsed ${filters.length} filter(s) for account ${accountId}`);

      // Get unfiltered INBOX emails
      const emails = db.getUnfilteredInboxEmails(accountId);
      if (emails.length === 0) {
        log.debug(`[FilterService] No unfiltered emails to process for account ${accountId}`);
        return result;
      }

      log.info(`[FilterService] Processing ${emails.length} unfiltered email(s) against ${filters.length} filter(s) for account ${accountId}`);
      result.emailsProcessed = emails.length;

      // Evaluate each email against all filters
      const matchedActions: Array<{
        email: EmailData;
        filter: ParsedFilter;
        actions: FilterAction[];
      }> = [];

      // Track unique matched emails for accurate count
      const matchedEmailIds = new Set<number>();

      for (const email of emails) {
        for (const filter of filters) {
          try {
            if (this.evaluateConditions(email, filter.conditions)) {
              const actionsToRun = [...filter.actions];

              if (actionsToRun.length > 0) {
                matchedActions.push({ email, filter, actions: actionsToRun });
                matchedEmailIds.add(email.id);
              }
            }
          } catch (err) {
            log.warn(`[FilterService] Error evaluating filter "${filter.name}" (id=${filter.id}) against email ${email.id} (subject: "${email.subject}"):`, err);
            result.errors++;
            // Continue with other filters
          }
        }
      }
      result.emailsMatched = matchedEmailIds.size;
      log.debug(`[FilterService] Evaluation complete: ${matchedEmailIds.size} unique email(s) matched, ${matchedActions.length} action(s) to dispatch`);

      // Dispatch actions for all matches
      const affectedFolders = new Set<string>(['INBOX']);
      for (const match of matchedActions) {
        for (const action of match.actions) {
          try {
            log.debug(`[FilterService] Dispatching action ${action.type}${action.value ? ` (${action.value})` : ''} from filter "${match.filter.name}" for email ${match.email.id} (subject: "${match.email.subject}")`);
            const targetFolder = await this.dispatchAction(accountId, match.email, action, match.filter.name);
            if (targetFolder) {
              affectedFolders.add(targetFolder);
              log.debug(`[FilterService] Action ${action.type} dispatched successfully, affected folder: ${targetFolder}`);
            } else {
              log.debug(`[FilterService] Action ${action.type} dispatched successfully (no folder change)`);
            }
            result.actionsDispatched++;
          } catch (err) {
            log.warn(
              `[FilterService] Error dispatching action ${action.type}${action.value ? ` (${action.value})` : ''} from filter "${match.filter.name}" for email ${match.email.id} (subject: "${match.email.subject}"):`,
              err
            );
            result.errors++;
          }
        }
      }

      // Mark all processed emails as filtered (regardless of match)
      db.markEmailsAsFiltered(emails.map(e => e.id));
      log.debug(`[FilterService] Marked ${emails.length} email(s) as filtered for account ${accountId}`);

      // Emit folder-updated event if any actions were dispatched
      if (result.actionsDispatched > 0) {
        log.debug(`[FilterService] Emitting folder-updated event for folders: ${Array.from(affectedFolders).join(', ')}`);
        this.emitFolderUpdated(accountId, Array.from(affectedFolders));
      }

      log.info(
        `[FilterService] Filter processing complete for account ${accountId}: ` +
        `processed ${result.emailsProcessed} email(s), ${result.emailsMatched} matched, ` +
        `${result.actionsDispatched} action(s) dispatched, ${result.errors} error(s)`
      );
    } catch (err) {
      log.error(`[FilterService] Fatal error processing emails for account ${accountId}:`, err);
      result.errors++;
    } finally {
      this.processingAccounts.delete(accountId);
    }

    return result;
  }

  // ---- Condition Matching ----

  private parseFilters(rawFilters: Array<{
    id: number;
    name: string;
    conditions: string;
    actions: string;
    sortOrder: number;
  }>): ParsedFilter[] {
    const parsed: ParsedFilter[] = [];
    for (const raw of rawFilters) {
      try {
        const conditions = JSON.parse(raw.conditions) as FilterCondition[];
        const actions = JSON.parse(raw.actions) as FilterAction[];
        if (conditions.length > 0 && actions.length > 0) {
          parsed.push({
            id: raw.id,
            name: raw.name,
            conditions,
            actions,
            sortOrder: raw.sortOrder,
          });
          log.debug(`[FilterService] Parsed filter "${raw.name}" (id=${raw.id}, order=${raw.sortOrder}): ${conditions.length} condition(s), ${actions.length} action(s)`);
        } else {
          log.warn(`[FilterService] Filter "${raw.name}" (id=${raw.id}) has no conditions or actions — skipping`);
        }
      } catch (err) {
        log.warn(`[FilterService] Failed to parse filter "${raw.name}" (id=${raw.id}):`, err);
      }
    }
    return parsed;
  }

  /**
   * Evaluate all conditions against an email. All conditions must match (AND logic).
   */
  private evaluateConditions(email: EmailData, conditions: FilterCondition[]): boolean {
    for (const condition of conditions) {
      if (!this.evaluateCondition(email, condition)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Evaluate a single condition against an email.
   */
  private evaluateCondition(email: EmailData, condition: FilterCondition): boolean {
    // Special case: has-attachment — presence of the condition means "has attachment is true"
    if (condition.field === 'has-attachment') {
      return email.hasAttachments;
    }

    // Get the field value to match against
    const fieldValue = this.getFieldValue(email, condition.field);
    if (fieldValue === null || fieldValue === undefined) {
      return false;
    }

    return this.matchOperator(fieldValue, condition.operator, condition.value);
  }

  /**
   * Get the email field value for a given condition field.
   */
  private getFieldValue(email: EmailData, field: FilterCondition['field']): string | null {
    switch (field) {
      case 'from':
        // Combine from_address and from_name for matching
        return `${email.fromName} <${email.fromAddress}>`;
      case 'to':
        return email.toAddresses;
      case 'subject':
        return email.subject;
      case 'body': {
        // Prefer text_body; fall back to html_body with tags stripped
        if (email.textBody) {
          return email.textBody;
        }
        if (email.htmlBody) {
          return this.stripHtmlTags(email.htmlBody);
        }
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * Match a value against an operator and pattern.
   */
  private matchOperator(value: string, operator: FilterCondition['operator'], pattern: string): boolean {
    const lowerValue = value.toLowerCase();
    const lowerPattern = pattern.toLowerCase();

    switch (operator) {
      case 'contains':
        return lowerValue.includes(lowerPattern);
      case 'equals':
        return lowerValue === lowerPattern;
      case 'starts-with':
        return lowerValue.startsWith(lowerPattern);
      case 'ends-with':
        return lowerValue.endsWith(lowerPattern);
      case 'matches':
        try {
          const regex = new RegExp(pattern, 'i');
          return regex.test(value);
        } catch (err) {
          log.warn(`[FilterService] Invalid regex pattern "${pattern}":`, err);
          return false;
        }
      default:
        return false;
    }
  }

  /**
   * Strip HTML tags from a string (simple regex approach for filter matching).
   */
  private stripHtmlTags(html: string): string {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ---- Action Dispatch ----

  /**
   * Dispatch a single filter action for an email.
   * Returns the target folder name for IMAP operations (for data-changed notification).
   */
  private async dispatchAction(
    accountId: number,
    email: EmailData,
    action: FilterAction,
    filterName: string
  ): Promise<string | null> {
    const db = DatabaseService.getInstance();
    const descriptionPrefix = `[Filter: ${filterName}]`;

    switch (action.type) {
      case 'mark-read': {
        // Optimistic DB update
        db.updateEmailFlags(accountId, email.xGmMsgId, { isRead: true });
        this.updateThreadReadStatus(accountId, email.xGmThrid);

        const queueService = MailQueueService.getInstance();
        queueService.enqueue(
          accountId,
          'flag',
          {
            xGmMsgIds: [email.xGmMsgId],
            flag: 'read',
            value: true,
            folder: 'INBOX',
          },
          `${descriptionPrefix} Mark as read`,
        );
        log.info(`[FilterService] Enqueued mark-read action for email ${email.id} via filter "${filterName}"`);
        return null;
      }

      case 'star': {
        // Optimistic DB update
        db.updateEmailFlags(accountId, email.xGmMsgId, { isStarred: true });

        const queueService = MailQueueService.getInstance();
        queueService.enqueue(
          accountId,
          'flag',
          {
            xGmMsgIds: [email.xGmMsgId],
            flag: 'starred',
            value: true,
            folder: 'INBOX',
          },
          `${descriptionPrefix} Star`,
        );
        log.info(`[FilterService] Enqueued star action for email ${email.id} via filter "${filterName}"`);
        return '[Gmail]/Starred';
      }

      case 'archive': {
        const targetFolder = '[Gmail]/All Mail';
        log.info(`[FilterService] Archiving email ${email.id} (subject: "${email.subject}") via filter "${filterName}"`);
        return this.enqueueMove(accountId, email, 'INBOX', targetFolder, descriptionPrefix, `Archive`);
      }

      case 'move': {
        if (!action.value) {
          log.warn(`[FilterService] Move action in filter "${filterName}" has no target folder — skipping for email ${email.id}`);
          return null;
        }
        log.info(`[FilterService] Moving email ${email.id} (subject: "${email.subject}") to "${action.value}" via filter "${filterName}"`);
        return this.enqueueMove(accountId, email, 'INBOX', action.value, descriptionPrefix, `Move to ${action.value}`);
      }

      case 'delete': {
        const trashFolder = '[Gmail]/Trash';
        log.info(`[FilterService] Deleting email ${email.id} (subject: "${email.subject}") via filter "${filterName}"`);
        return this.enqueueMove(accountId, email, 'INBOX', trashFolder, descriptionPrefix, `Delete`);
      }

      default:
        log.warn(`[FilterService] Unknown action type: ${(action as FilterAction).type}`);
        return null;
    }
  }

  /**
   * Enqueue a move operation (used for archive, move, delete).
   */
  private enqueueMove(
    accountId: number,
    email: EmailData,
    sourceFolder: string,
    targetFolder: string,
    descriptionPrefix: string,
    descriptionSuffix: string
  ): string | null {
    const db = DatabaseService.getInstance();
    log.debug(`[FilterService] Enqueuing move operation: email ${email.id} from ${sourceFolder} to ${targetFolder}`);

    // Optimistic DB update: move email and thread folder associations
    db.moveEmailFolder(accountId, email.xGmMsgId, sourceFolder, targetFolder, null);
    if (email.xGmThrid) {
      if (!db.threadHasEmailsInFolder(accountId, email.xGmThrid, sourceFolder)) {
        db.moveThreadFolder(accountId, email.xGmThrid, sourceFolder, targetFolder);
      } else {
        db.upsertThreadFolder(accountId, email.xGmThrid, targetFolder);
      }
    }

    // Enqueue the IMAP operation
    const queueService = MailQueueService.getInstance();
    queueService.enqueue(
      accountId,
      'move',
      {
        xGmMsgIds: [email.xGmMsgId],
        sourceFolder,
        targetFolder,
        emailMeta: [{ xGmMsgId: email.xGmMsgId, xGmThrid: email.xGmThrid }],
      },
      `${descriptionPrefix} ${descriptionSuffix}`,
    );

    log.debug(`[FilterService] Move operation enqueued successfully for email ${email.id}`);
    return targetFolder;
  }

  /**
   * Update thread read status based on all emails in the thread.
   */
  private updateThreadReadStatus(accountId: number, xGmThrid: string): void {
    const db = DatabaseService.getInstance();
    const emails = db.getEmailsByThreadId(accountId, xGmThrid);
    const allRead = emails.every(e => !!(e['isRead']));
    const internalId = db.getThreadInternalId(accountId, xGmThrid);
    if (internalId != null) {
      const rawDb = db.getDatabase();
      rawDb.run(
        'UPDATE threads SET is_read = :isRead, updated_at = datetime(\'now\') WHERE id = :id',
        { ':isRead': allRead ? 1 : 0, ':id': internalId }
      );
    }
  }

  // ---- Folder Updated Notification ----

  private emitFolderUpdated(accountId: number, folders: string[]): void {
    const payload = {
      accountId,
      folders,
      reason: 'filter',
      changeType: 'mixed',
    };
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_EVENTS.MAIL_FOLDER_UPDATED, payload);
        }
      }
    } catch {
      // Window may not exist yet during startup
    }
  }
}
