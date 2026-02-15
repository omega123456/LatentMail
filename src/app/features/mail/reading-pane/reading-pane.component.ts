import { Component, inject, OnChanges, SimpleChanges, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { EmailsStore } from '../../../store/emails.store';
import { FoldersStore } from '../../../store/folders.store';
import { Email } from '../../../core/models/email.model';
import { RelativeTimePipe } from '../../../shared/pipes/relative-time.pipe';

@Component({
  selector: 'app-reading-pane',
  standalone: true,
  imports: [CommonModule, RelativeTimePipe],
  template: `
    @if (emailsStore.loadingThread()) {
      <div class="reading-pane-loading">
        <span class="material-symbols-outlined spinning">sync</span>
        <p>Loading thread...</p>
      </div>
    } @else if (emailsStore.selectedThread(); as thread) {
      <div class="reading-pane-content">
        <!-- Toolbar -->
        <div class="message-toolbar">
          @if (isDraftsFolder()) {
            <button class="toolbar-btn edit-draft-btn" (click)="actionClicked.emit('edit-draft')">
              <span class="material-symbols-outlined">edit</span>
              <span>Edit Draft</span>
            </button>
            <div class="toolbar-separator"></div>
          }
          <button class="toolbar-btn" (click)="actionClicked.emit('reply')">
            <span class="material-symbols-outlined">reply</span>
            <span>Reply</span>
          </button>
          <button class="toolbar-btn" (click)="actionClicked.emit('reply-all')">
            <span class="material-symbols-outlined">reply_all</span>
            <span>Reply All</span>
          </button>
          <button class="toolbar-btn" (click)="actionClicked.emit('forward')">
            <span class="material-symbols-outlined">forward</span>
            <span>Forward</span>
          </button>
          <div class="toolbar-separator"></div>
          <button class="toolbar-btn" (click)="actionClicked.emit('archive')">
            <span class="material-symbols-outlined">archive</span>
          </button>
          <button class="toolbar-btn" (click)="actionClicked.emit('delete')">
            <span class="material-symbols-outlined">delete</span>
          </button>
          <button class="toolbar-btn" (click)="toggleStar()">
            <span class="material-symbols-outlined" [class.starred]="thread.isStarred">
              {{ thread.isStarred ? 'star' : 'star_border' }}
            </span>
          </button>
          <button class="toolbar-btn" (click)="toggleRead()">
            <span class="material-symbols-outlined">
              {{ thread.isRead ? 'mark_email_unread' : 'mark_email_read' }}
            </span>
          </button>
        </div>

        <!-- Thread subject -->
        <div class="thread-subject">
          <h2>{{ thread.subject || '(no subject)' }}</h2>
        </div>

        <!-- Messages -->
        <div class="messages-list">
          @for (message of emailsStore.selectedMessages(); track message.gmailMessageId; let i = $index; let last = $last) {
            <div class="message-card" [class.collapsed]="!last && !expandedMessages.has(message.gmailMessageId)">
              <!-- Message header (always visible) -->
              <div
                class="message-header"
                (click)="toggleExpand(message.gmailMessageId)"
              >
                <div class="sender-avatar">{{ getInitial(message) }}</div>
                <div class="header-content">
                  <div class="header-top">
                    <span class="sender-name">{{ message.fromName || message.fromAddress }}</span>
                    <span class="message-date">{{ message.date | relativeTime }}</span>
                  </div>
                  <div class="header-bottom">
                    <span class="recipients">to {{ getRecipients(message) }}</span>
                  </div>
                </div>
              </div>

              <!-- Message body (shown when expanded) -->
              @if (last || expandedMessages.has(message.gmailMessageId)) {
                <div class="message-body">
                  @if (message.htmlBody) {
                    <div class="html-body" [innerHTML]="sanitizeHtml(message.htmlBody)"></div>
                  } @else if (message.textBody) {
                    <pre class="text-body">{{ message.textBody }}</pre>
                  } @else {
                    <p class="no-body">No content available</p>
                  }
                </div>
              } @else {
                <div class="message-snippet">{{ message.snippet || getSnippet(message) }}</div>
              }
            </div>
          }
        </div>
      </div>
    } @else {
      <div class="reading-pane-empty">
        <span class="material-symbols-outlined">mail</span>
        <p>Select an email to read</p>
      </div>
    }
  `,
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

    .html-body {
      font-size: 14px;
      line-height: 1.6;
      color: var(--color-text-primary);
      word-break: break-word;
      overflow-wrap: break-word;

      :host ::ng-deep {
        img {
          max-width: 100%;
          height: auto;
        }

        a {
          color: var(--color-primary);
        }

        blockquote {
          border-left: 3px solid var(--color-border);
          margin: 8px 0;
          padding: 4px 12px;
          color: var(--color-text-secondary);
        }
      }
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

  private sanitizer = inject(DomSanitizer);

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

  sanitizeHtml(html: string): SafeHtml {
    // Strip script tags and event handlers for safety
    // In production, use DOMPurify in the main process before sending to renderer
    let cleaned = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/on\w+="[^"]*"/gi, '')
      .replace(/on\w+='[^']*'/gi, '');
    // Strip external stylesheet links to avoid CSP violations (style-src only allows 'self' and fonts.googleapis.com)
    cleaned = cleaned.replace(/<link[^>]*\srel\s*=\s*["']?stylesheet["']?[^>]*>/gi, '');
    // Upgrade font URLs to HTTPS so they comply with CSP (style-src allows https://fonts.googleapis.com)
    cleaned = cleaned
      .replace(/http:\/\/fonts\.googleapis\.com/gi, 'https://fonts.googleapis.com')
      .replace(/http:\/\/fonts\.gstatic\.com/gi, 'https://fonts.gstatic.com');
    return this.sanitizer.bypassSecurityTrustHtml(cleaned);
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
