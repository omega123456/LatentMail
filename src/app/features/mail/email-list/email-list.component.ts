import { Component, viewChild, inject, output, effect, signal, computed, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { MatProgressBar } from '@angular/material/progress-bar';
import { Subscription } from 'rxjs';
import { EmailsStore } from '../../../store/emails.store';
import { UiStore } from '../../../store/ui.store';
import { AiStore } from '../../../store/ai.store';
import { EmailListItemComponent } from './email-list-item.component';
import { Thread } from '../../../core/models/email.model';
import { AiCategory } from '../../../core/models/ai.model';
import { FoldersStore } from '../../../store/folders.store';
import { AccountsStore } from '../../../store/accounts.store';
import { CommandRegistryService } from '../../../core/services/command-registry.service';

@Component({
  selector: 'app-email-list',
  standalone: true,
  imports: [CommonModule, ScrollingModule, EmailListItemComponent, MatProgressBar],
  templateUrl: './email-list.component.html',
  styleUrl: './email-list.component.scss',
})
export class EmailListComponent implements OnDestroy {
  // Signal-based ViewChild — reactive, works correctly with @if/@else control flow.
  // Angular updates this signal whenever the viewport enters or leaves the DOM,
  // which re-runs any effects that read it (enabling clean setup/teardown).
  readonly viewport = viewChild(CdkVirtualScrollViewport);

  readonly emailsStore = inject(EmailsStore);
  readonly foldersStore = inject(FoldersStore);
  readonly accountsStore = inject(AccountsStore);
  readonly uiStore = inject(UiStore);
  readonly aiStore = inject(AiStore);
  private readonly commandRegistry = inject(CommandRegistryService);

  readonly threadSelected = output<Thread>();
  readonly threadContextMenu = output<{ thread: Thread; x: number; y: number }>();

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
   * The thread ID currently highlighted by J/K or Arrow Up/Down keyboard navigation.
   * Arrow-key navigation also opens the focused thread in the reading pane (same as Enter/click).
   */
  readonly keyboardCursorId = signal<string | null>(null);

  /**
   * The xGmThrid of the last thread clicked (anchor for Shift+Click range selection).
   * Updated only on click events — J/K keyboard navigation does NOT update this.
   */
  readonly lastClickedThreadId = signal<string | null>(null);

  /**
   * Thread IDs from the previous render cycle, used for detecting prepended threads
   * during merge-mode background refreshes so scroll position can be compensated.
   */
  private previousThreadIds: string[] = [];

  /**
   * Tracks the full set of thread IDs that have been seen across streaming batches.
   * Used to diff against new arrivals so we can identify and animate newly added rows.
   * Reset when streaming search transitions to idle.
   */
  private knownStreamingThreadIds = new Set<string>();

  /** Set of thread IDs currently animating as newly-added (cleared after 500ms). */
  protected readonly newlyAddedThreadIds = signal(new Set<string>());

  /** Computed label text for the streaming search result count. */
  protected readonly searchCountLabel = computed(() => {
    const status = this.aiStore.searchStreamStatus();
    const count = this.aiStore.searchStreamResultCount();
    if (status === 'searching' && count === 0) {
      return 'Searching\u2026';
    }
    if (status === 'searching' && count > 0) {
      return `${count} results so far\u2026`;
    }
    if (status === 'complete' || status === 'partial' || status === 'error') {
      return `${count} results`;
    }
    return null; // idle — don't show the label
  });

  /** Whether to show the streaming search header (progress bar, count, warning). */
  protected readonly showSearchStreamHeader = computed(() => {
    const status = this.aiStore.searchStreamStatus();
    return status === 'searching' || status === 'complete' || status === 'partial' || status === 'error';
  });

  private commandSub?: Subscription;

  constructor() {
    // Reset scroll to top when folder/account switches trigger a fresh thread load.
    // loadThreads() sets preserveListPosition to false — when that happens, scroll to top.
    effect(() => {
      const preserve = this.emailsStore.preserveListPosition();
      if (!preserve) {
        this.viewport()?.scrollToIndex(0);
        // Also clear the keyboard cursor and range anchor on folder/account switch.
        this.keyboardCursorId.set(null);
        this.lastClickedThreadId.set(null);
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

    // Streaming search animation: watch for newly appended threads and briefly tag
    // them with the animation class via `newlyAddedThreadIds`, then clear after 500ms.
    //
    // Uses a private Set (`knownStreamingThreadIds`) as a mutable accumulator across
    // batches to diff each new threads() snapshot against what we've already seen.
    // When status returns to 'idle' (search cleared), the known set is reset so the
    // next search starts fresh.
    effect(() => {
      const status = this.aiStore.searchStreamStatus();
      if (status === 'idle') {
        // Search cleared — reset so next search starts with a clean slate.
        this.knownStreamingThreadIds.clear();
        return;
      }

      if (status !== 'searching') {
        // 'complete', 'partial', 'error' — no new batches expected, skip diffing.
        return;
      }

      const currentThreads = this.emailsStore.threads();
      const newIds: string[] = [];

      for (const thread of currentThreads) {
        if (!this.knownStreamingThreadIds.has(thread.xGmThrid)) {
          newIds.push(thread.xGmThrid);
          this.knownStreamingThreadIds.add(thread.xGmThrid);
        }
      }

      if (newIds.length > 0) {
        this.newlyAddedThreadIds.set(new Set(newIds));
        setTimeout(() => {
          this.newlyAddedThreadIds.set(new Set<string>());
        }, 500);
      }
    }, { allowSignalWrites: true });

    // Subscribe to command registry events for vim-style keyboard navigation.
    // All actions that operate on the email list are delegated here so that the
    // command registry stubs remain thin and context-agnostic.
    this.commandSub = this.commandRegistry.commandTriggered$.subscribe(commandId => {
      this.handleCommand(commandId);
    });
  }

  ngOnDestroy(): void {
    this.commandSub?.unsubscribe();
  }

  // ---------------------------------------------------------------------------
  // Keyboard navigation (vim-style)
  // ---------------------------------------------------------------------------

  /**
   * Route incoming command IDs to the appropriate handler.
   * Only processes commands relevant to the email list; all others are silently ignored.
   */
  private handleCommand(commandId: string): void {
    switch (commandId) {
      case 'nav-next':
        this.moveKeyboardCursor(1);
        break;
      case 'nav-prev':
        this.moveKeyboardCursor(-1);
        break;
      case 'open-thread':
        if (this.emailsStore.multiSelectActive()) {
          // Clear multi-select, then open the keyboard cursor thread
          this.emailsStore.clearMultiSelection();
        }
        this.openKeyboardCursorThread();
        break;
      case 'delete':
        if (this.emailsStore.multiSelectActive()) {
          this.bulkDelete();
        } else {
          this.deleteKeyboardCursorThread();
        }
        break;
      case 'star':
        if (this.emailsStore.multiSelectActive()) {
          this.bulkStar();
        } else {
          this.toggleStarKeyboardCursorThread();
        }
        break;
      case 'mark-read':
        if (this.emailsStore.multiSelectActive()) {
          this.bulkMarkRead(true);
        } else {
          this.markKeyboardCursorThread(true);
        }
        break;
      case 'mark-unread':
        if (this.emailsStore.multiSelectActive()) {
          this.bulkMarkRead(false);
        } else {
          this.markKeyboardCursorThread(false);
        }
        break;
      case 'mark-spam':
        if (this.emailsStore.multiSelectActive()) {
          this.bulkMarkSpam();
        } else {
          this.markSpamKeyboardCursorThread();
        }
        break;
      case 'mark-not-spam':
        if (this.emailsStore.multiSelectActive()) {
          this.bulkMarkNotSpam();
        } else {
          this.markNotSpamKeyboardCursorThread();
        }
        break;
      case 'select-all': {
        const allThreads = this.filteredThreads();
        this.emailsStore.setMultiSelectedThreadIds(allThreads.map(t => t.xGmThrid));
        // Set cursor to first thread so open-thread has a target if cursor was null
        if (allThreads.length > 0 && !this.keyboardCursorId()) {
          this.keyboardCursorId.set(allThreads[0].xGmThrid);
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Bulk multi-select action helpers
  // ---------------------------------------------------------------------------

  private bulkDelete(): void {
    if (this.foldersStore.activeFolderId() === this.foldersStore.trashFolderId()) {
      return;
    }
    const selectedIds = this.emailsStore.multiSelectedThreadIds().slice();
    const activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) {
      return;
    }
    const currentFolder = this.foldersStore.activeFolderId() || 'INBOX';
    for (const threadId of selectedIds) {
      const thread = this.filteredThreads().find(t => t.xGmThrid === threadId);
      if (thread) {
        this.emailsStore.moveEmails(activeAccount.id, [thread.xGmThrid], this.foldersStore.trashFolderId(), thread.xGmThrid, currentFolder);
      }
    }
    this.emailsStore.clearMultiSelection();
    this.keyboardCursorId.set(null);
  }

  private bulkStar(): void {
    if (this.foldersStore.activeFolderId() === this.foldersStore.trashFolderId()) {
      return;
    }
    const selectedIds = this.emailsStore.multiSelectedThreadIds().slice();
    const activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) {
      return;
    }
    const threads = this.filteredThreads();
    // OR rule: if any is unstarred → star all; if all starred → unstar all
    const starValue = selectedIds.some(id => {
      const thread = threads.find(t => t.xGmThrid === id);
      return thread ? !thread.isStarred : false;
    });
    for (const threadId of selectedIds) {
      const thread = threads.find(t => t.xGmThrid === threadId);
      if (thread) {
        this.emailsStore.flagEmails(activeAccount.id, [thread.xGmThrid], 'starred', starValue, thread.xGmThrid);
      }
    }
    this.emailsStore.clearMultiSelection();
    this.keyboardCursorId.set(null);
  }

  private bulkMarkRead(asRead: boolean): void {
    const selectedIds = this.emailsStore.multiSelectedThreadIds().slice();
    const activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) {
      return;
    }
    const threads = this.filteredThreads();
    for (const threadId of selectedIds) {
      const thread = threads.find(t => t.xGmThrid === threadId);
      if (thread) {
        this.emailsStore.flagEmails(activeAccount.id, [thread.xGmThrid], 'read', asRead, thread.xGmThrid);
      }
    }
    this.emailsStore.clearMultiSelection();
    this.keyboardCursorId.set(null);
  }

  private bulkMarkSpam(): void {
    if (this.foldersStore.activeFolderId() === '[Gmail]/Spam') {
      return;
    }
    const selectedIds = this.emailsStore.multiSelectedThreadIds().slice();
    const activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) {
      return;
    }
    const currentFolder = this.foldersStore.activeFolderId() || 'INBOX';
    const threads = this.filteredThreads();
    for (const threadId of selectedIds) {
      const thread = threads.find(t => t.xGmThrid === threadId);
      if (thread) {
        this.emailsStore.moveEmails(activeAccount.id, [thread.xGmThrid], '[Gmail]/Spam', thread.xGmThrid, currentFolder);
      }
    }
    this.emailsStore.clearMultiSelection();
    this.keyboardCursorId.set(null);
  }

  private bulkMarkNotSpam(): void {
    if (this.foldersStore.activeFolderId() !== '[Gmail]/Spam') {
      return;
    }
    const selectedIds = this.emailsStore.multiSelectedThreadIds().slice();
    const activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) {
      return;
    }
    const currentFolder = this.foldersStore.activeFolderId() || '[Gmail]/Spam';
    const threads = this.filteredThreads();
    for (const threadId of selectedIds) {
      const thread = threads.find(t => t.xGmThrid === threadId);
      if (thread) {
        this.emailsStore.moveEmails(activeAccount.id, [thread.xGmThrid], 'INBOX', thread.xGmThrid, currentFolder);
      }
    }
    this.emailsStore.clearMultiSelection();
    this.keyboardCursorId.set(null);
  }

  /**
   * Move the keyboard cursor by `delta` rows (+1 = down, -1 = up).
   * Clamps to the list boundaries (no wrapping).
   * Also scrolls the cursor item into view inside the CDK viewport.
   */
  private moveKeyboardCursor(delta: 1 | -1): void {
    const threads = this.filteredThreads();
    if (threads.length === 0) {
      return;
    }

    const currentId = this.keyboardCursorId() ?? this.emailsStore.selectedThreadId();
    const currentIndex = currentId ? threads.findIndex(thread => thread.xGmThrid === currentId) : -1;

    let nextIndex: number;
    if (currentIndex < 0) {
      nextIndex = delta > 0 ? 0 : threads.length - 1;
    } else {
      nextIndex = currentIndex + delta;
      if (nextIndex < 0) {
        nextIndex = 0;
      }
      if (nextIndex >= threads.length) {
        nextIndex = threads.length - 1;
      }
    }

    const nextThread = threads[nextIndex];
    if (nextThread) {
      this.keyboardCursorId.set(nextThread.xGmThrid);
      this.scrollCursorIntoView(nextIndex);
      this.threadSelected.emit(nextThread);
    }
  }

  /**
   * Ensure the item at `index` is visible in the CDK virtual scroll viewport.
   * Scrolls minimally: only moves when the item is outside the current visible range.
   */
  private scrollCursorIntoView(index: number): void {
    const vp = this.viewport();
    if (!vp) {
      return;
    }

    const itemSize = this.uiStore.densityHeight();
    const currentOffset = vp.measureScrollOffset();
    const viewportSize = vp.getViewportSize();

    const itemTop = index * itemSize;
    const itemBottom = itemTop + itemSize;
    const viewTop = currentOffset;
    const viewBottom = currentOffset + viewportSize;

    if (itemTop < viewTop) {
      vp.scrollToOffset(itemTop);
    } else if (itemBottom > viewBottom) {
      vp.scrollToOffset(itemBottom - viewportSize);
    }
  }

  /**
   * Open (emit `threadSelected`) for the thread under the keyboard cursor.
   * Falls back to the store's selected thread if no keyboard cursor is set.
   */
  private openKeyboardCursorThread(): void {
    const cursorId = this.keyboardCursorId() ?? this.emailsStore.selectedThreadId();
    if (!cursorId) {
      return;
    }
    const thread = this.filteredThreads().find(t => t.xGmThrid === cursorId);
    if (thread) {
      this.threadSelected.emit(thread);
    }
  }

  /**
   * Return the thread under the keyboard cursor (or the opened thread as fallback).
   * Returns `null` if neither cursor nor selection is set.
   */
  private getKeyboardCursorThread(): Thread | null {
    const cursorId = this.keyboardCursorId() ?? this.emailsStore.selectedThreadId();
    if (!cursorId) {
      return null;
    }
    return this.filteredThreads().find(thread => thread.xGmThrid === cursorId) ?? null;
  }

  /** Delete (move to Trash) the thread under the keyboard cursor. */
  private deleteKeyboardCursorThread(): void {
    // Silently no-op when viewing Trash — deleting from Trash is not supported.
    if (this.foldersStore.activeFolderId() === this.foldersStore.trashFolderId()) {
      return;
    }
    const thread = this.getKeyboardCursorThread();
    const activeAccount = this.accountsStore.activeAccount();
    if (!thread || !activeAccount) {
      return;
    }
    const currentFolder = this.foldersStore.activeFolderId() || 'INBOX';
    this.emailsStore.moveEmails(
      activeAccount.id,
      [thread.xGmThrid],
      this.foldersStore.trashFolderId(),
      thread.xGmThrid,
      currentFolder,
    );
    this.keyboardCursorId.set(null);
  }

  /** Mark as spam (move to Spam) the thread under the keyboard cursor. */
  private markSpamKeyboardCursorThread(): void {
    if (this.foldersStore.activeFolderId() === '[Gmail]/Spam') {
      return;
    }
    const thread = this.getKeyboardCursorThread();
    const activeAccount = this.accountsStore.activeAccount();
    if (!thread || !activeAccount) {
      return;
    }
    const currentFolder = this.foldersStore.activeFolderId() || 'INBOX';
    this.emailsStore.moveEmails(
      activeAccount.id,
      [thread.xGmThrid],
      '[Gmail]/Spam',
      thread.xGmThrid,
      currentFolder,
    );
    this.keyboardCursorId.set(null);
  }

  /** Not spam (move to Inbox) the thread under the keyboard cursor. Only applies when viewing Spam. */
  private markNotSpamKeyboardCursorThread(): void {
    if (this.foldersStore.activeFolderId() !== '[Gmail]/Spam') {
      return;
    }
    const thread = this.getKeyboardCursorThread();
    const activeAccount = this.accountsStore.activeAccount();
    if (!thread || !activeAccount) {
      return;
    }
    const currentFolder = this.foldersStore.activeFolderId() || 'INBOX';
    this.emailsStore.moveEmails(
      activeAccount.id,
      [thread.xGmThrid],
      'INBOX',
      thread.xGmThrid,
      currentFolder,
    );
    this.keyboardCursorId.set(null);
  }

  /** Toggle the starred flag on the thread under the keyboard cursor. */
  private toggleStarKeyboardCursorThread(): void {
    const thread = this.getKeyboardCursorThread();
    const activeAccount = this.accountsStore.activeAccount();
    if (!thread || !activeAccount) {
      return;
    }
    if (this.foldersStore.activeFolderId() === this.foldersStore.trashFolderId()) {
      return;
    }
    this.emailsStore.flagEmails(
      activeAccount.id,
      [thread.xGmThrid],
      'starred',
      !thread.isStarred,
      thread.xGmThrid,
    );
  }

  /** Mark the thread under the keyboard cursor as read (`asRead = true`) or unread. */
  private markKeyboardCursorThread(asRead: boolean): void {
    const thread = this.getKeyboardCursorThread();
    const activeAccount = this.accountsStore.activeAccount();
    if (!thread || !activeAccount) {
      return;
    }
    this.emailsStore.flagEmails(
      activeAccount.id,
      [thread.xGmThrid],
      'read',
      asRead,
      thread.xGmThrid,
    );
  }

  // ---------------------------------------------------------------------------
  // Existing helpers
  // ---------------------------------------------------------------------------

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

  /**
   * Returns true when `threadId` is in the set of newly-arrived streaming batch threads
   * that are currently animating in. The set is cleared 500ms after each batch arrives.
   */
  protected isNewlyAdded(threadId: string): boolean {
    return this.newlyAddedThreadIds().has(threadId);
  }

  onThreadClick(event: { thread: Thread; ctrlKey: boolean; shiftKey: boolean }): void {
    const { thread, ctrlKey, shiftKey } = event;

    if (ctrlKey) {
      // Ctrl/Cmd click: toggle thread in/out of multi-selection
      this.emailsStore.toggleMultiSelectThread(thread.xGmThrid);
      this.keyboardCursorId.set(thread.xGmThrid);
      this.lastClickedThreadId.set(thread.xGmThrid);
    } else if (shiftKey) {
      // Shift click: select a range from the last-clicked anchor to this thread
      const threads = this.filteredThreads();
      const anchorId = this.lastClickedThreadId();
      const anchorIndex = anchorId ? threads.findIndex(t => t.xGmThrid === anchorId) : -1;
      const clickedIndex = threads.findIndex(t => t.xGmThrid === thread.xGmThrid);

      let rangeIds: string[];
      if (clickedIndex < 0 || anchorIndex < 0) {
        // Anchor or clicked thread not found in current list — select only the clicked thread
        rangeIds = [thread.xGmThrid];
      } else {
        const minIndex = Math.min(anchorIndex, clickedIndex);
        const maxIndex = Math.max(anchorIndex, clickedIndex);
        rangeIds = threads.slice(minIndex, maxIndex + 1).map(t => t.xGmThrid);
      }

      this.emailsStore.setMultiSelectedThreadIds(rangeIds);
      this.keyboardCursorId.set(thread.xGmThrid);
      this.lastClickedThreadId.set(thread.xGmThrid);
    } else {
      // Plain click: clear multi-selection and open the thread
      this.emailsStore.clearMultiSelection();
      this.keyboardCursorId.set(thread.xGmThrid);
      this.lastClickedThreadId.set(thread.xGmThrid);
      this.threadSelected.emit(thread);
    }
  }

  onItemContextMenu(data: { thread: Thread; x: number; y: number }): void {
    if (this.emailsStore.multiSelectedThreadIds().includes(data.thread.xGmThrid)) {
      // Right-clicking a multi-selected thread — keep multi-selection, just open the menu
      this.threadContextMenu.emit(data);
    } else {
      // Right-clicking a non-selected thread — clear multi-selection, single-select that thread
      this.emailsStore.clearMultiSelection();
      this.onThreadClick({ thread: data.thread, ctrlKey: false, shiftKey: false });
      this.threadContextMenu.emit(data);
    }
  }

  onStarToggle(thread: Thread): void {
    if (this.foldersStore.activeFolderId() === this.foldersStore.trashFolderId()) {
      return;
    }
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
