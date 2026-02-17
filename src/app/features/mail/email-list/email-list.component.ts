import { Component, ViewChild, inject, output, effect } from '@angular/core';
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
  styleUrl: './email-list.component.scss',
})
export class EmailListComponent {
  @ViewChild(CdkVirtualScrollViewport)
  private viewport?: CdkVirtualScrollViewport;

  readonly emailsStore = inject(EmailsStore);
  readonly foldersStore = inject(FoldersStore);
  readonly accountsStore = inject(AccountsStore);
  readonly uiStore = inject(UiStore);
  readonly threadSelected = output<Thread>();

  constructor() {
    // Reset scroll to top when folder/account switches trigger a fresh thread load.
    // loadThreads() sets preserveListPosition to false — when that happens, scroll to top.
    effect(() => {
      const preserve = this.emailsStore.preserveListPosition();
      if (!preserve && this.viewport) {
        this.viewport.scrollToIndex(0);
      }
    });
  }

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
