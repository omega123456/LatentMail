import { Component, inject, computed, signal, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTabsModule } from '@angular/material/tabs';
import { DateTime } from 'luxon';
import { QueueStore, QueueItemSnapshot } from '../../store/queue.store';

@Component({
  selector: 'app-queue-settings',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatPaginatorModule, MatTabsModule],
  templateUrl: './queue-settings.component.html',
  styleUrl: './queue-settings.component.scss',
})
export class QueueSettingsComponent {
  readonly queueStore = inject(QueueStore);

  readonly pageSizeOptions = [10, 25, 50, 100];

  // ---------------------------------------------------------------------------
  // Mail ops tab (all non-body-fetch operations)
  // ---------------------------------------------------------------------------

  readonly mailPageIndex = signal(0);
  readonly mailPageSize = signal(25);

  readonly mailItems = computed(() =>
    this.queueStore.items().filter((item) => item.type !== 'body-fetch'),
  );

  readonly sortedMailItems = computed(() =>
    [...this.mailItems()].sort((itemA, itemB) => {
      const order: Record<string, number> = { processing: 0, pending: 1, failed: 2, cancelled: 3, completed: 4 };
      const diff = (order[itemA.status] ?? 4) - (order[itemB.status] ?? 4);
      if (diff !== 0) { return diff; }
      return DateTime.fromISO(itemB.createdAt).toMillis() - DateTime.fromISO(itemA.createdAt).toMillis();
    }),
  );

  readonly paginatedMailItems = computed(() => {
    const allItems = this.sortedMailItems();
    const startIndex = this.mailPageIndex() * this.mailPageSize();
    return allItems.slice(startIndex, startIndex + this.mailPageSize());
  });

  readonly mailPendingCount = computed(() => this.mailItems().filter((item) => item.status === 'pending').length);
  readonly mailProcessingCount = computed(() => this.mailItems().filter((item) => item.status === 'processing').length);
  readonly mailCompletedCount = computed(() => this.mailItems().filter((item) => item.status === 'completed').length);
  readonly mailFailedCount = computed(() => this.mailItems().filter((item) => item.status === 'failed').length);
  readonly mailActiveCount = computed(() => this.mailItems().filter((item) => item.status === 'pending' || item.status === 'processing').length);

  // ---------------------------------------------------------------------------
  // Body-prefetch tab
  // ---------------------------------------------------------------------------

  readonly prefetchPageIndex = signal(0);
  readonly prefetchPageSize = signal(25);

  readonly prefetchItems = computed(() =>
    this.queueStore.items().filter((item) => item.type === 'body-fetch'),
  );

  readonly sortedPrefetchItems = computed(() =>
    [...this.prefetchItems()].sort((itemA, itemB) => {
      const order: Record<string, number> = { processing: 0, pending: 1, failed: 2, cancelled: 3, completed: 4 };
      const diff = (order[itemA.status] ?? 4) - (order[itemB.status] ?? 4);
      if (diff !== 0) { return diff; }
      return DateTime.fromISO(itemB.createdAt).toMillis() - DateTime.fromISO(itemA.createdAt).toMillis();
    }),
  );

  readonly paginatedPrefetchItems = computed(() => {
    const allItems = this.sortedPrefetchItems();
    const startIndex = this.prefetchPageIndex() * this.prefetchPageSize();
    return allItems.slice(startIndex, startIndex + this.prefetchPageSize());
  });

  readonly prefetchPendingCount = computed(() => this.prefetchItems().filter((item) => item.status === 'pending').length);
  readonly prefetchProcessingCount = computed(() => this.prefetchItems().filter((item) => item.status === 'processing').length);
  readonly prefetchCompletedCount = computed(() => this.prefetchItems().filter((item) => item.status === 'completed').length);
  readonly prefetchFailedCount = computed(() => this.prefetchItems().filter((item) => item.status === 'failed').length);
  readonly prefetchActiveCount = computed(() => this.prefetchItems().filter((item) => item.status === 'pending' || item.status === 'processing').length);

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  constructor() {
    // Reset mail page when item count changes and current page is out of bounds.
    effect(() => {
      const total = this.sortedMailItems().length;
      untracked(() => {
        if (total > 0 && this.mailPageIndex() * this.mailPageSize() >= total) {
          this.mailPageIndex.set(0);
        }
      });
    });

    // Reset prefetch page when item count changes and current page is out of bounds.
    effect(() => {
      const total = this.sortedPrefetchItems().length;
      untracked(() => {
        if (total > 0 && this.prefetchPageIndex() * this.prefetchPageSize() >= total) {
          this.prefetchPageIndex.set(0);
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Pagination handlers
  // ---------------------------------------------------------------------------

  onMailPage(event: PageEvent): void {
    // Reset to page 0 when page size changes to avoid landing on an empty page.
    if (event.pageSize !== this.mailPageSize()) {
      this.mailPageIndex.set(0);
    } else {
      this.mailPageIndex.set(event.pageIndex);
    }
    this.mailPageSize.set(event.pageSize);
  }

  onPrefetchPage(event: PageEvent): void {
    // Reset to page 0 when page size changes to avoid landing on an empty page.
    if (event.pageSize !== this.prefetchPageSize()) {
      this.prefetchPageIndex.set(0);
    } else {
      this.prefetchPageIndex.set(event.pageIndex);
    }
    this.prefetchPageSize.set(event.pageSize);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  typeIcon(type: string): string {
    const icons: Record<string, string> = {
      'draft-create': 'edit_note',
      'draft-update': 'edit_note',
      'send': 'send',
      'move': 'drive_file_move',
      'flag': 'flag',
      'delete': 'delete',
      'delete-label': 'label_off',
      'add-labels': 'label',
      'remove-labels': 'label_off',
      'sync-folder': 'folder_sync',
      'sync-thread': 'mark_email_read',
      'sync-allmail': 'all_inbox',
      'fetch-older': 'history',
      'body-fetch': 'download',
    };
    return icons[type] || 'pending';
  }

  itemStatusLabel(item: QueueItemSnapshot): string {
    if (item.status === 'completed' && item.error) {
      return 'Done (warnings)';
    }
    const labels: Record<string, string> = {
      pending: 'Pending',
      processing: 'Active',
      completed: 'Done',
      failed: 'Failed',
      cancelled: 'Cancelled',
    };
    return labels[item.status] || item.status;
  }

  relativeTime(isoDate: string): string {
    const duration = DateTime.now().diff(DateTime.fromISO(isoDate), ['days', 'hours', 'minutes', 'seconds']);
    const seconds = Math.floor(duration.as('seconds'));
    if (seconds < 60) { return 'just now'; }
    const minutes = Math.floor(duration.as('minutes'));
    if (minutes < 60) { return `${minutes}m ago`; }
    const hours = Math.floor(duration.as('hours'));
    if (hours < 24) { return `${hours}h ago`; }
    return `${Math.floor(duration.as('days'))}d ago`;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async retryAll(): Promise<void> {
    await this.queueStore.retryAll();
  }

  async clearCompleted(): Promise<void> {
    await this.queueStore.clearCompleted();
  }

  async retry(queueId: string): Promise<void> {
    await this.queueStore.retrySingle(queueId);
  }

  async cancel(queueId: string): Promise<void> {
    await this.queueStore.cancelOperation(queueId);
  }
}
