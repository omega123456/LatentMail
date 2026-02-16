import { Component, ViewChild, inject, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { EmailsStore } from '../../../store/emails.store';
import { UiStore } from '../../../store/ui.store';
import { EmailListItemComponent } from './email-list-item.component';
import { Thread } from '../../../core/models/email.model';
import { FoldersStore } from '../../../store/folders.store';
import { AccountsStore } from '../../../store/accounts.store';

@Component({
  selector: 'app-email-list',
  standalone: true,
  imports: [CommonModule, ScrollingModule, EmailListItemComponent],
  templateUrl: './email-list.component.html',
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    .email-list-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    .email-scroll-viewport {
      flex: 1;
      min-height: 0;
      overflow-x: hidden;
      width: 100%;
      max-width: 100%;

      ::ng-deep .cdk-virtual-scroll-content-wrapper {
        max-width: 100%;
      }
    }

    .email-list-loading, .email-list-empty {
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

      .hint {
        font-size: 12px;
      }
    }

    .spinning {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    @media (prefers-reduced-motion: reduce) {
      .spinning {
        animation: pulse 2s ease-in-out infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
    }

    .list-bottom-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px;
      color: var(--color-text-secondary);
      font-size: 13px;
      line-height: 1;
      flex-shrink: 0;

      .fetch-icon {
        font-size: inherit;
        color: var(--color-primary);
        display: flex;
        align-items: center;
      }

      .fetch-text {
        line-height: 1;
        display: flex;
        align-items: center;
      }

      .ellipsis-animated {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 2px;
        font-weight: bold;
        letter-spacing: 2px;
        line-height: 1;
        font-size: inherit;
        height: 1em;
        /* Nudge up so period baseline aligns visually with x-height of label */
        transform: translateY(-0.06em);

        .dot {
          animation: ellipsis-dot 1.4s ease-in-out infinite both;
          line-height: 1;

          &:nth-child(1) { animation-delay: 0s; }
          &:nth-child(2) { animation-delay: 0.2s; }
          &:nth-child(3) { animation-delay: 0.4s; }
        }
      }

      @keyframes ellipsis-dot {
        0%, 80%, 100% { opacity: 0.25; }
        40% { opacity: 1; }
      }

      @media (prefers-reduced-motion: reduce) {
        .ellipsis-animated .dot {
          animation: none;
          opacity: 1;
        }
      }

      &.error {
        .error-icon {
          font-size: 20px;
          color: var(--color-error, #d32f2f);
        }
        .error-text {
          color: var(--color-text-secondary);
        }
      }

      &.end {
        .end-icon {
          font-size: 20px;
          color: var(--color-text-tertiary);
        }
        .end-text {
          color: var(--color-text-tertiary);
        }
      }
    }

    .retry-btn {
      background: none;
      border: none;
      color: var(--color-primary);
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
      padding: 4px 8px;
      border-radius: 4px;

      &:hover {
        background-color: var(--color-surface-variant);
      }
    }
  `]
})
export class EmailListComponent {
  @ViewChild(CdkVirtualScrollViewport)
  private viewport?: CdkVirtualScrollViewport;

  readonly emailsStore = inject(EmailsStore);
  readonly foldersStore = inject(FoldersStore);
  readonly accountsStore = inject(AccountsStore);
  readonly uiStore = inject(UiStore);
  readonly threadSelected = output<Thread>();

  trackByThreadId(_index: number, thread: Thread): string {
    return thread.gmailThreadId;
  }

  onThreadClick(thread: Thread): void {
    this.threadSelected.emit(thread);
  }

  onStarToggle(thread: Thread): void {
    const accountId = thread.accountId;
    this.emailsStore.flagEmails(
      accountId,
      [thread.gmailThreadId],
      'starred',
      !thread.isStarred,
      thread.gmailThreadId
    );
  }

  onScroll(index: number): void {
    if (index > 0) {
      this.emailsStore.markListScrolled();
    }

    const threads = this.emailsStore.threads();
    const renderedRange = this.viewport?.getRenderedRange();
    const renderedCount = renderedRange ? Math.max(1, renderedRange.end - renderedRange.start) : 10;
    const remainingItems = threads.length - (index + renderedCount);
    const nearBottomThreshold = Math.max(10, renderedCount * 2);

    if (
      remainingItems <= nearBottomThreshold &&
      this.emailsStore.hasMore() &&
      !this.emailsStore.loading() &&
      !this.emailsStore.fetchingMore()
    ) {
      const activeAccount = this.accountsStore.activeAccount();
      const activeFolderId = this.foldersStore.activeFolderId();
      if (activeAccount && activeFolderId) {
        this.emailsStore.loadMore(activeAccount.id, activeFolderId);
      }
    }
  }

  onRetryFetch(): void {
    const activeAccount = this.accountsStore.activeAccount();
    const activeFolderId = this.foldersStore.activeFolderId();
    if (activeAccount && activeFolderId) {
      this.emailsStore.loadMoreFromServer(activeAccount.id, activeFolderId);
    }
  }
}
