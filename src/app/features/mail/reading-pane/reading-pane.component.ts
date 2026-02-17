import { Component, inject, output, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { EmailsStore } from '../../../store/emails.store';
import { FoldersStore } from '../../../store/folders.store';
import { AiStore } from '../../../store/ai.store';
import { Email } from '../../../core/models/email.model';
import { AiStreamEvent } from '../../../core/models/ai.model';
import { ElectronService } from '../../../core/services/electron.service';
import { RelativeTimePipe } from '../../../shared/pipes/relative-time.pipe';
import { EmailBodyFrameComponent } from './email-body-frame.component';

@Component({
  selector: 'app-reading-pane',
  standalone: true,
  imports: [CommonModule, RelativeTimePipe, EmailBodyFrameComponent],
  templateUrl: './reading-pane.component.html',
  styleUrl: './reading-pane.component.scss',
})
export class ReadingPaneComponent implements OnInit, OnDestroy {
  readonly emailsStore = inject(EmailsStore);
  private readonly foldersStore = inject(FoldersStore);
  readonly aiStore = inject(AiStore);
  private readonly electronService = inject(ElectronService);
  readonly actionClicked = output<string>();
  readonly expandedMessages = new Set<string>();
  private aiStreamSub?: Subscription;

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

  /** Whether the current folder is the Gmail Drafts folder. */
  isDraftsFolder(): boolean {
    const folder = this.foldersStore.activeFolderId();
    return folder === '[Gmail]/Drafts';
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

  toggleStar(): void {
    const thread = this.emailsStore.selectedThread();
    if (!thread) {
      return;
    }
    const messageIds = this.emailsStore.selectedMessages().map(m => m.gmailMessageId);
    this.emailsStore.flagEmails(
      thread.accountId,
      messageIds.length > 0 ? messageIds : [thread.gmailThreadId],
      'starred',
      !thread.isStarred,
      thread.gmailThreadId
    );
  }

  toggleRead(): void {
    const thread = this.emailsStore.selectedThread();
    if (!thread) {
      return;
    }
    const messageIds = this.emailsStore.selectedMessages().map(m => m.gmailMessageId);
    this.emailsStore.flagEmails(
      thread.accountId,
      messageIds.length > 0 ? messageIds : [thread.gmailThreadId],
      'read',
      !thread.isRead,
      thread.gmailThreadId
    );
  }

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
  async summarize(): Promise<void> {
    const thread = this.emailsStore.selectedThread();
    if (!thread) {
      return;
    }
    const content = this.getThreadContent();
    if (!content) {
      return;
    }
    await this.aiStore.summarize(thread.gmailThreadId, content);
  }

  /** Generate smart reply suggestions */
  async generateReplies(): Promise<void> {
    const content = this.getThreadContent();
    if (!content) {
      return;
    }
    await this.aiStore.generateReplies(content);
  }

  /** Use a reply suggestion (emit it to the parent to open compose) */
  useReplySuggestion(suggestion: string): void {
    this.actionClicked.emit(`reply-with:${suggestion}`);
  }

  /** Close the AI summary panel */
  closeSummary(): void {
    this.aiStore.clearSummary();
  }

  /** Close reply suggestions */
  closeReplies(): void {
    this.aiStore.clearReplies();
  }
}
