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
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .reading-pane-loading, .reading-pane-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--color-text-tertiary);
      gap: 8px;

      .material-symbols-outlined {
        font-size: 48px;
        opacity: 0.5;
      }

      p {
        font-size: 14px;
        margin: 0;
      }
    }

    .spinning {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .reading-pane-content {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .message-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--color-border);
    }

    .toolbar-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border: none;
      background: none;
      border-radius: 6px;
      cursor: pointer;
      color: var(--color-text-secondary);
      font-size: 13px;
      transition: background-color 120ms ease;

      &:hover {
        background-color: var(--color-surface-variant);
        color: var(--color-text-primary);
      }

      &.edit-draft-btn {
        color: var(--color-primary);
        font-weight: 500;

        &:hover {
          background-color: var(--color-primary-light);
        }
      }

      .material-symbols-outlined {
        font-size: 18px;
      }

      .starred {
        color: var(--color-accent);
        font-variation-settings: 'FILL' 1;
      }
    }

    .toolbar-separator {
      width: 1px;
      height: 24px;
      background-color: var(--color-border);
      margin: 0 4px;
    }

    .thread-subject {
      padding: 16px 24px 8px;

      h2 {
        margin: 0;
        font-size: 20px;
        font-weight: 600;
        color: var(--color-text-primary);
      }
    }

    .messages-list {
      flex: 1;
      overflow-y: auto;
      padding: 0 24px 24px;
    }

    .message-card {
      border: 1px solid var(--color-border);
      border-radius: 8px;
      margin-top: 12px;
      overflow: hidden;

      &.collapsed {
        .message-header {
          cursor: pointer;
        }
      }
    }

    .message-header {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 16px;
      cursor: pointer;

      &:hover {
        background-color: var(--color-surface-variant);
      }
    }

    .sender-avatar {
      width: 36px;
      height: 36px;
      min-width: 36px;
      border-radius: 50%;
      background-color: var(--color-primary);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 500;
    }

    .header-content {
      flex: 1;
      min-width: 0;
    }

    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }

    .sender-name {
      font-size: 14px;
      font-weight: 500;
      color: var(--color-text-primary);
    }

    .message-date {
      font-size: 12px;
      color: var(--color-text-tertiary);
    }

    .header-bottom {
      margin-top: 2px;
    }

    .recipients {
      font-size: 12px;
      color: var(--color-text-tertiary);
    }

    .message-body {
      padding: 0 16px 16px 64px;
    }

    .text-body {
      font-size: 14px;
      line-height: 1.6;
      color: var(--color-text-primary);
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
      margin: 0;
    }

    .no-body {
      font-size: 14px;
      color: var(--color-text-tertiary);
      font-style: italic;
    }

    .message-snippet {
      padding: 0 16px 12px 64px;
      font-size: 13px;
      color: var(--color-text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `]
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
