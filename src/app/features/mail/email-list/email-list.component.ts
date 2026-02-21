import { Component, ViewChild, inject, output, effect, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { EmailsStore } from '../../../store/emails.store';
import { UiStore } from '../../../store/ui.store';
import { AiStore } from '../../../store/ai.store';
import { EmailListItemComponent } from './email-list-item.component';
import { Thread } from '../../../core/models/email.model';
import { AiCategory } from '../../../core/models/ai.model';
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
  readonly aiStore = inject(AiStore);
  readonly threadSelected = output<Thread>();

  /** Active category filter from the header */
  readonly categoryFilter = signal<AiCategory | null>(null);

  /** Threads filtered by category when a category filter is active */
  readonly filteredThreads = computed(() => {
    const threads = this.emailsStore.threads();
    const filter = this.categoryFilter();
    if (!filter) {
      return threads;
    }
    const cache = this.aiStore.categoryCache();
    return threads.filter(t => cache[t.xGmThrid] === filter);
  });

  /**
   * Thread IDs from the previous render cycle, used for detecting prepended threads
   * during merge-mode background refreshes so scroll position can be compensated.
   */
  private previousThreadIds: string[] = [];

  constructor() {
    // Reset scroll to top when folder/account switches trigger a fresh thread load.
    // loadThreads() sets preserveListPosition to false — when that happens, scroll to top.
    effect(() => {
      const preserve = this.emailsStore.preserveListPosition();
      if (!preserve && this.viewport) {
        this.viewport.scrollToIndex(0);
      }
    });

    // Scroll offset compensation for prepended threads during merge-mode background refresh.
    //
    // When new threads are prepended (new arrivals while user is scrolled), CDK virtual
    // scroll would shift the viewport — the user's current view appears to "jump" because
    // the same scroll offset now points to a different item. This effect compensates by
    // detecting how many items were inserted before the user's current anchor and adjusting
    // the viewport offset accordingly, so the user sees the same content.
    //
    // Only compensates when preserveListPosition is true (user has scrolled or paginated);
    // on fresh loads (preserveListPosition=false) the other effect above scrolls to top.
    effect(() => {
      const threads = this.filteredThreads(); // reactive — runs when threads change
      const preserve = this.emailsStore.preserveListPosition();

      const currentIds = threads.map(t => t.xGmThrid);
      const prevIds = this.previousThreadIds;

      // Always update stored IDs for the next comparison, regardless of whether
      // we compensate this cycle.
      this.previousThreadIds = currentIds;

      if (!preserve || !this.viewport || prevIds.length === 0 || currentIds.length === 0) {
        return;
      }

      // Anchor: the first thread visible in the rendered range from the previous list.
      // getRenderedRange() reflects the old rendered state at effect-run time (before
      // Angular has re-rendered the DOM for the new thread list).
      const renderedRange = this.viewport.getRenderedRange();
      const anchorPrevIndex = Math.max(0, renderedRange.start);
      const anchorId = prevIds[anchorPrevIndex] ?? prevIds[0];

      if (!anchorId) {
        return;
      }

      // Find the anchor thread's new index in the updated list.
      const newAnchorIndex = currentIds.indexOf(anchorId);
      if (newAnchorIndex < 0) {
        // Anchor thread was deleted — do not compensate (selection clearing handles UI).
        return;
      }

      const deltaIndex = newAnchorIndex - anchorPrevIndex;
      if (deltaIndex !== 0) {
        // Items were prepended (deltaIndex > 0) or deleted above the viewport (deltaIndex < 0).
        // Compensate by shifting the viewport offset so the user continues looking at the same
        // content. Positive delta: new emails appear above, visible when scrolling up.
        // Negative delta: deletions above the fold — scroll offset reduces to follow content up.
        const itemSize = this.uiStore.densityHeight();
        const currentOffset = this.viewport.measureScrollOffset();
        this.viewport.scrollToOffset(currentOffset + deltaIndex * itemSize);
      }
    });
  }

  trackByThreadId(_index: number, thread: Thread): string {
    return thread.xGmThrid;
  }

  onThreadClick(thread: Thread): void {
    this.threadSelected.emit(thread);
  }

  onStarToggle(thread: Thread): void {
    const accountId = thread.accountId;
    this.emailsStore.flagEmails(
      accountId,
      [thread.xGmThrid],
      'starred',
      !thread.isStarred,
      thread.xGmThrid
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

  setCategoryFilter(category: AiCategory | null): void {
    this.categoryFilter.set(category);
  }
}
