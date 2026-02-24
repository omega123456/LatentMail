import { Component, inject, output, OnInit, OnDestroy, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { EmailsStore } from '../../../store/emails.store';
import { FoldersStore } from '../../../store/folders.store';
import { AiStore } from '../../../store/ai.store';
import { ComposeStore } from '../../../store/compose.store';
import { AccountsStore } from '../../../store/accounts.store';
import { Email } from '../../../core/models/email.model';
import { AiStreamEvent } from '../../../core/models/ai.model';
import { ElectronService } from '../../../core/services/electron.service';
import { RelativeTimePipe } from '../../../shared/pipes/relative-time.pipe';
import { EmailBodyFrameComponent } from './email-body-frame.component';
import { MessageAttachmentsComponent } from './message-attachments.component';
import { EmailActionRibbonComponent } from '../../../shared/components/email-actions/email-action-ribbon.component';
import { EmailActionContext, EmailActionEvent } from '../../../shared/components/email-actions/email-action.model';
import { getOrderedFolderBadges } from '../../../shared/constants/folder-badges';
import { DEFAULT_LABEL_COLOR } from '../../../shared/constants/label-colors';
import { SettingsStore } from '../../../store/settings.store';
import { SenderAvatarComponent } from '../../../shared/components/sender-avatar/sender-avatar.component';

@Component({
  selector: 'app-reading-pane',
  standalone: true,
  imports: [
    CommonModule,
    RelativeTimePipe,
    EmailBodyFrameComponent,
    MessageAttachmentsComponent,
    EmailActionRibbonComponent,
    SenderAvatarComponent,
  ],
  templateUrl: './reading-pane.component.html',
  styleUrl: './reading-pane.component.scss',
})
export class ReadingPaneComponent implements OnInit, OnDestroy {
  readonly emailsStore = inject(EmailsStore);
  readonly foldersStore = inject(FoldersStore);
  readonly aiStore = inject(AiStore);
  readonly settingsStore = inject(SettingsStore);
  private readonly electronService = inject(ElectronService);
  private readonly composeStore = inject(ComposeStore);
  private readonly accountsStore = inject(AccountsStore);

  /** Emits EmailActionEvent to the parent (mail-shell). */
  readonly actionClicked = output<EmailActionEvent>();

  /** Shared open-menu key for all ribbon instances within this thread view. */
  readonly threadOpenMenuKey = signal<string | null>(null);

  readonly expandedMessages = new Set<string>();
  private aiStreamSub?: Subscription;

  constructor() {
    // Clear AI panels and reset open-menu state when switching to a different thread
    effect(() => {
      const currentId = this.emailsStore.selectedThreadId();
      const summaryForId = this.aiStore.summaryThreadId();
      const repliesForId = this.aiStore.replySuggestionsThreadId();
      const followUpForId = this.aiStore.followUpThreadId();
      if (summaryForId != null && summaryForId !== currentId) {
        this.aiStore.clearSummary();
      }
      if (repliesForId != null && repliesForId !== currentId) {
        this.aiStore.clearReplies();
      }
      if (followUpForId != null && followUpForId !== currentId) {
        this.aiStore.clearFollowUp();
      }
      // Reset any open ribbon menu state so a stale key from the previous thread
      // does not suppress close effects when the same menu position is opened on the new thread.
      this.threadOpenMenuKey.set(null);
    });
  }

  ngOnInit(): void {
    // Subscribe to AI streaming events
    this.aiStreamSub = this.electronService
      .onEvent<AiStreamEvent>('ai:stream')
      .subscribe(event => {
        this.aiStore.appendStreamToken(event);
      });
  }

  ngOnDestroy(): void {
    this.aiStreamSub?.unsubscribe();
  }

  /**
   * Returns ordered folder badges for a message (all folders the message appears in).
   * User labels include a color so the existing badge can be styled with the label colour.
   */
  getMessageFolderBadges(message: Email): Array<{ displayName: string; cssClass: string; icon: string; title: string; folderId?: string; color?: string }> {
    const folders = message.folders;
    const nameLookup = this.foldersStore.folders();
    const badges = getOrderedFolderBadges(folders ?? [], nameLookup);
    const allFolders = this.foldersStore.folders();
    return badges.map((badge) => {
      if (!badge.folderId) {
        return badge;
      }
      const folder = allFolders.find(
        (f) => f.type === 'user' && f.gmailLabelId.toLowerCase() === badge.folderId!.toLowerCase()
      );
      if (!folder) {
        return badge;
      }
      return { ...badge, color: folder.color ?? DEFAULT_LABEL_COLOR };
    });
  }

  getInitial(email: Email): string {
    const name = email.fromName || email.fromAddress;
    return name.charAt(0).toUpperCase();
  }

  getRecipients(email: Email): string {
    const to = email.toAddresses || '';
    const addresses = to.split(',').map(a => a.trim());
    if (addresses.length <= 2) {
      return addresses.join(', ');
    }
    return `${addresses[0]} and ${addresses.length - 1} others`;
  }

  /**
   * Tooltip for the "to" row when the display is truncated (e.g. "X and N others").
   * Returns the full comma-separated list so hover shows all addresses.
   */
  getRecipientsTooltip(message: Email): string | null {
    const to = message.toAddresses || '';
    const addresses = to.split(',').map(a => a.trim()).filter(a => a);
    if (addresses.length <= 2) {
      return null;
    }
    return to.trim() || null;
  }

  /**
   * Open compose with the given address(es) pre-filled in TO.
   */
  openComposeTo(address: string): void {
    const trimmed = address?.trim();
    if (!trimmed) {
      return;
    }
    const activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) {
      return;
    }
    this.composeStore.openCompose({
      mode: 'new',
      accountId: activeAccount.id,
      accountEmail: activeAccount.email,
      accountDisplayName: activeAccount.displayName,
      to: trimmed,
    });
  }

  getSnippet(email: Email): string {
    if (email.textBody) {
      return email.textBody.substring(0, 100);
    }
    return '';
  }

  toggleExpand(messageId: string): void {
    if (this.expandedMessages.has(messageId)) {
      this.expandedMessages.delete(messageId);
    } else {
      this.expandedMessages.add(messageId);
    }
  }

  /**
   * Build the EmailActionContext for the thread-level toolbar.
   * Message is null because this is thread-level (no specific message).
   */
  threadActionContext(): EmailActionContext {
    const thread = this.emailsStore.selectedThread();
    if (!thread) {
      // Should not happen since this is only rendered when thread exists,
      // but return a safe default
      return this.buildDefaultContext();
    }
    const messages = this.emailsStore.selectedMessages();
    const threadFolderIds =
      thread.folders && thread.folders.length > 0
        ? thread.folders
        : [...new Set(messages.flatMap((m) => m.folders ?? []))];
    return {
      message: null,
      thread,
      activeFolderId: this.foldersStore.activeFolderId(),
      aiConnected: this.aiStore.connected(),
      isStarred: thread.isStarred,
      isRead: thread.isRead,
      isDraft: !!thread.hasDraft,
      summaryLoading: this.aiStore.summaryLoading(),
      replyLoading: this.aiStore.replySuggestionsLoading(),
      followUpLoading: this.aiStore.followUpLoading(),
      currentFolderIds: threadFolderIds,
    };
  }

  /**
   * Build the EmailActionContext for a per-message ribbon.
   */
  messageActionContext(message: Email): EmailActionContext {
    const thread = this.emailsStore.selectedThread();
    if (!thread) {
      return this.buildDefaultContext();
    }
    return {
      message,
      thread,
      activeFolderId: this.foldersStore.activeFolderId(),
      aiConnected: this.aiStore.connected(),
      isStarred: thread.isStarred,
      isRead: thread.isRead,
      isDraft: message.isDraft,
      summaryLoading: this.aiStore.summaryLoading(),
      replyLoading: this.aiStore.replySuggestionsLoading(),
      followUpLoading: this.aiStore.followUpLoading(),
      currentFolderIds: message.folders ?? [],
    };
  }

  /**
   * Handle ribbon action events.
   * AI actions are handled locally; all others are forwarded to mail-shell.
   */
  onRibbonAction(event: EmailActionEvent): void {
    switch (event.action) {
      case 'summarize':
        this.summarize();
        break;
      case 'smart-reply':
        this.generateReplies();
        break;
      case 'follow-up':
        this.detectFollowUp();
        break;
      default:
        // Forward all other actions to the parent (mail-shell)
        this.actionClicked.emit(event);
        break;
    }
  }

  /**
   * Update the shared open-menu key when any ribbon in this thread opens or closes a menu.
   * Setting the same key again (same ribbon + same type) is a no-op; a different key correctly
   * triggers close effects in all other menu component instances.
   */
  onThreadOpenMenuChanged(key: string | null): void {
    this.threadOpenMenuKey.set(key);
  }

  /** Use a reply suggestion (emit it to the parent to open compose) */
  useReplySuggestion(suggestion: string): void {
    this.actionClicked.emit({ action: `reply-with:${suggestion}` });
  }

  /** Close the AI summary panel */
  closeSummary(): void {
    this.aiStore.clearSummary();
  }

  /** Close reply suggestions */
  closeReplies(): void {
    this.aiStore.clearReplies();
  }

  /** Close follow-up panel */
  closeFollowUp(): void {
    this.aiStore.clearFollowUp();
  }

  /** Whether the current folder is the Gmail Sent folder */
  isSentFolder(): boolean {
    const folder = this.foldersStore.activeFolderId();
    return folder === '[Gmail]/Sent Mail' || folder === 'Sent' || folder === '[Gmail]/Sent';
  }

  // ─── Private AI methods ───

  /** Build thread content string for AI operations */
  private getThreadContent(): string {
    const thread = this.emailsStore.selectedThread();
    const messages = this.emailsStore.selectedMessages();
    if (!thread || messages.length === 0) {
      return '';
    }

    return messages.map(m => {
      const from = m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress;
      const date = m.date ? new Date(m.date).toLocaleString() : '';
      const body = m.textBody || m.snippet || '';
      return `From: ${from}\nDate: ${date}\nSubject: ${m.subject || '(no subject)'}\n\n${body}`;
    }).join('\n\n---\n\n');
  }

  /** Summarize the current thread */
  private async summarize(): Promise<void> {
    const thread = this.emailsStore.selectedThread();
    if (!thread) {
      return;
    }
    const content = this.getThreadContent();
    if (!content) {
      return;
    }
    await this.aiStore.summarize(thread.xGmThrid, content);
  }

  /** Generate smart reply suggestions */
  private async generateReplies(): Promise<void> {
    const thread = this.emailsStore.selectedThread();
    const content = this.getThreadContent();
    if (!content) {
      return;
    }
    await this.aiStore.generateReplies(content, thread?.xGmThrid);
  }

  /** Detect if the current email needs follow-up */
  private async detectFollowUp(): Promise<void> {
    const thread = this.emailsStore.selectedThread();
    const content = this.getThreadContent();
    if (!content) {
      return;
    }
    await this.aiStore.detectFollowUp(content, thread?.xGmThrid);
  }

  /** Safe default context for when no thread is selected. */
  private buildDefaultContext(): EmailActionContext {
    return {
      message: null,
      thread: { id: 0, accountId: 0, xGmThrid: '', lastMessageDate: '', messageCount: 0, folder: '', isRead: false, isStarred: false },
      activeFolderId: null,
      aiConnected: false,
      isStarred: false,
      isRead: false,
      isDraft: false,
      summaryLoading: false,
      replyLoading: false,
      followUpLoading: false,
      currentFolderIds: [],
    };
  }
}
