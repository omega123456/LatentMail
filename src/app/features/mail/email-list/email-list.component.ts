import { Component, viewChild, inject, output, effect, signal, computed } from '@angular/core';
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
  // Signal-based ViewChild — reactive, works correctly with @if/@else control flow.
  // Angular updates this signal whenever the viewport enters or leaves the DOM,
  // which re-runs any effects that read it (enabling clean setup/teardown).
  readonly viewport = viewChild(CdkVirtualScrollViewport);

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
      if (!preserve) {
        this.viewport()?.scrollToIndex(0);
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
      const vp = this.viewport();

      const currentIds = threads.map(t => t.xGmThrid);
      const prevIds = this.previousThreadIds;

      // Always update stored IDs for the next comparison, regardless of whether
      // we compensate this cycle.
      this.previousThreadIds = currentIds;

      if (!preserve || !vp || prevIds.length === 0 || currentIds.length === 0) {
        return;
      }

      // Anchor: the first thread visible in the rendered range from the previous list.
      // getRenderedRange() reflects the old rendered state at effect-run time (before
      // Angular has re-rendered the DOM for the new thread list).
      const renderedRange = vp.getRenderedRange();
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
        const currentOffset = vp.measureScrollOffset();
        vp.scrollToOffset(currentOffset + deltaIndex * itemSize);
      }
    });

    // Scroll-based load-more detection.
    //
    // Why not IntersectionObserver + sentinel: CDK virtual scroll manages its own content
    // wrapper with CSS transforms. Static sibling elements inside the viewport are not part
    // of this wrapper and cannot be reliably positioned at the logical "end" of the list.
    // IntersectionObserver with a custom root also has browser inconsistencies around %
    // rootMargin calculation. Using CDK's own scroll Observable + measureScrollOffset('bottom')
    // avoids all of these issues — it is a direct API call that returns the exact pixel
    // distance from the current scroll position to the bottom of the scrollable content.
    //
    // Threshold: 2× the viewport height so prefetching begins two screens before the bottom,
    // matching the original plan's intent of "seamless prefetch the user rarely notices."
    //
    // onCleanup() runs when the CDK viewport leaves the DOM (folder switch triggers the @if
    // block, destroying the viewport) or when the component is destroyed, automatically
    // unsubscribing without any ngOnDestroy boilerplate.
    effect((onCleanup) => {
      const vp = this.viewport();
      if (!vp) {
        return;
      }

      let scrolled = false;

      const subscription = vp.elementScrolled().subscribe(() => {
        // One-shot: mark list position as preserved on the first scroll event.
        // This prevents loadThreads() from resetting scroll to top during background refreshes.
        if (!scrolled && vp.measureScrollOffset() > 0) {
          scrolled = true;
          this.emailsStore.markListScrolled();
        }

        // Check if the user is close enough to the bottom to trigger a prefetch.
        this.checkAndMaybeLoadMore(vp);
      });

      onCleanup(() => subscription.unsubscribe());
    });
  }

  /**
   * Checks if the current scroll position is within the prefetch threshold of the bottom
   * and, if so, calls loadMore. Safe to call multiple times — the store guards against
   * concurrent loads and redundant calls when hasMore is false.
   */
  private checkAndMaybeLoadMore(vp: CdkVirtualScrollViewport): void {
    if (!this.emailsStore.hasMore() || this.emailsStore.anyLoadingMore()) {
      return;
    }

    const activeAccount = this.accountsStore.activeAccount();
    const activeFolderId = this.foldersStore.activeFolderId();
    if (!activeAccount || !activeFolderId) {
      return;
    }

    // measureScrollOffset('bottom') returns the number of pixels between the current
    // scroll position's bottom edge and the very end of the scrollable content.
    // When this falls below the threshold, we're close enough to start prefetching.
    const distanceFromBottom = vp.measureScrollOffset('bottom');
    const prefetchThreshold = Math.max(400, vp.getViewportSize() * 2);

    if (distanceFromBottom < prefetchThreshold) {
      this.emailsStore.loadMore(activeAccount.id, activeFolderId);
    }
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

  onRetryFetch(): void {
    const activeAccount = this.accountsStore.activeAccount();
    const activeFolderId = this.foldersStore.activeFolderId();
    if (activeAccount && activeFolderId) {
      // loadMore() internally routes to DB retry or server retry based on dbExhausted.
      // Also clears fetchError before attempting (set in the store's loadMore).
      this.emailsStore.loadMore(activeAccount.id, activeFolderId);
    }
  }

  setCategoryFilter(category: AiCategory | null): void {
    this.categoryFilter.set(category);
  }
}
