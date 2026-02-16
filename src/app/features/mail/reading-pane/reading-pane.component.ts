import { Component, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EmailsStore } from '../../../store/emails.store';
import { FoldersStore } from '../../../store/folders.store';
import { Email } from '../../../core/models/email.model';
import { RelativeTimePipe } from '../../../shared/pipes/relative-time.pipe';
import { EmailBodyFrameComponent } from './email-body-frame.component';

@Component({
  selector: 'app-reading-pane',
  standalone: true,
  imports: [CommonModule, RelativeTimePipe, EmailBodyFrameComponent],
  templateUrl: './reading-pane.component.html',
  styleUrl: './reading-pane.component.scss',
})
export class ReadingPaneComponent {
  readonly emailsStore = inject(EmailsStore);
  private readonly foldersStore = inject(FoldersStore);
  readonly actionClicked = output<string>();
  readonly expandedMessages = new Set<string>();

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
    if (addresses.length <= 2) return addresses.join(', ');
    return `${addresses[0]} and ${addresses.length - 1} others`;
  }

  getSnippet(email: Email): string {
    if (email.textBody) return email.textBody.substring(0, 100);
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
    if (!thread) return;
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
    if (!thread) return;
    const messageIds = this.emailsStore.selectedMessages().map(m => m.gmailMessageId);
    this.emailsStore.flagEmails(
      thread.accountId,
      messageIds.length > 0 ? messageIds : [thread.gmailThreadId],
      'read',
      !thread.isRead,
      thread.gmailThreadId
    );
  }
}
