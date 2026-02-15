import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { QueueStore, QueueItemSnapshot } from '../../store/queue.store';

@Component({
  selector: 'app-queue-settings',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule],
  template: `
    <div class="queue-settings">
      <h2>Mail Operation Queue</h2>
      <p class="subtitle">View and manage queued mail operations.</p>

      <!-- Statistics card -->
      <div class="stats-card">
        <div class="stat">
          <span class="material-symbols-outlined stat-icon pending">hourglass_empty</span>
          <span class="stat-value">{{ queueStore.pendingCount() }}</span>
          <span class="stat-label">Pending</span>
        </div>
        <div class="stat">
          <span class="material-symbols-outlined stat-icon processing">autorenew</span>
          <span class="stat-value">{{ queueStore.processingCount() }}</span>
          <span class="stat-label">Processing</span>
        </div>
        <div class="stat">
          <span class="material-symbols-outlined stat-icon completed">check_circle</span>
          <span class="stat-value">{{ queueStore.completedCount() }}</span>
          <span class="stat-label">Done</span>
        </div>
        <div class="stat">
          <span class="material-symbols-outlined stat-icon failed">error</span>
          <span class="stat-value">{{ queueStore.failedCount() }}</span>
          <span class="stat-label">Failed</span>
        </div>
      </div>

      <!-- Action buttons -->
      <div class="actions">
        @if (queueStore.failedCount() > 0) {
          <button mat-stroked-button color="warn" (click)="retryAll()">
            <span class="material-symbols-outlined">refresh</span>
            Retry All Failed
          </button>
        }
        @if (queueStore.completedCount() > 0) {
          <button mat-stroked-button (click)="clearCompleted()">
            <span class="material-symbols-outlined">clear_all</span>
            Clear Completed
          </button>
        }
      </div>

      <!-- Queue items -->
      @if (queueStore.hasItems()) {
        <div class="queue-list">
          @for (item of sortedItems(); track item.queueId) {
            <div class="queue-item" [class]="'status-' + item.status">
              <span class="material-symbols-outlined type-icon">{{ typeIcon(item.type) }}</span>
              <div class="item-info">
                <div class="item-description">{{ item.description }}</div>
                @if (item.status === 'failed' && item.error) {
                  <div class="item-error">{{ item.error }}</div>
                }
              </div>
              <span class="status-badge" [class]="'badge-' + item.status">
                {{ statusLabel(item.status) }}
              </span>
              <span class="item-time">{{ relativeTime(item.createdAt) }}</span>
              @if (item.status === 'failed') {
                <div class="item-actions">
                  <button mat-icon-button (click)="retry(item.queueId)" title="Retry">
                    <span class="material-symbols-outlined">refresh</span>
                  </button>
                  <button mat-icon-button (click)="cancel(item.queueId)" title="Dismiss">
                    <span class="material-symbols-outlined">close</span>
                  </button>
                </div>
              }
            </div>
          }
        </div>
      } @else {
        <div class="empty-state">
          <span class="material-symbols-outlined empty-icon">check_circle</span>
          <p>No pending operations</p>
          <p class="empty-sub">All mail operations have been processed.</p>
        </div>
      }
    </div>
  `,
  styles: [`
    .queue-settings {
      max-width: 700px;
    }

    h2 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 4px;
    }

    .subtitle {
      color: var(--color-text-secondary);
      font-size: 14px;
      margin-bottom: 24px;
    }

    .stats-card {
      display: flex;
      gap: 24px;
      padding: 16px 24px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      margin-bottom: 16px;
    }

    .stat {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .stat-icon {
      font-size: 20px;
      &.pending { color: var(--color-accent, #ff9800); }
      &.processing { color: var(--color-primary); animation: spin 1s linear infinite; }
      &.completed { color: #4caf50; }
      &.failed { color: #f44336; }
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .stat-value {
      font-weight: 600;
      font-size: 16px;
    }

    .stat-label {
      font-size: 13px;
      color: var(--color-text-secondary);
    }

    .actions {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;

      button {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 13px;

        .material-symbols-outlined {
          font-size: 18px;
        }
      }
    }

    .queue-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .queue-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 16px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 6px;

      &.status-failed {
        border-color: #f4433640;
      }
    }

    .type-icon {
      font-size: 20px;
      color: var(--color-text-secondary);
    }

    .item-info {
      flex: 1;
      min-width: 0;
    }

    .item-description {
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .item-error {
      font-size: 12px;
      color: #f44336;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-badge {
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 12px;
      white-space: nowrap;

      &.badge-pending { background: #ff980020; color: #ff9800; }
      &.badge-processing { background: var(--color-primary-light, #2196f320); color: var(--color-primary); }
      &.badge-completed { background: #4caf5020; color: #4caf50; }
      &.badge-failed { background: #f4433620; color: #f44336; }
    }

    .item-time {
      font-size: 12px;
      color: var(--color-text-tertiary);
      white-space: nowrap;
    }

    .item-actions {
      display: flex;
      gap: 0;
    }

    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--color-text-secondary);

      .empty-icon {
        font-size: 48px;
        color: #4caf50;
        margin-bottom: 12px;
      }

      p {
        margin: 0;
        font-size: 16px;
      }

      .empty-sub {
        font-size: 14px;
        color: var(--color-text-tertiary);
        margin-top: 4px;
      }
    }
  `],
})
export class QueueSettingsComponent {
  readonly queueStore = inject(QueueStore);

  readonly sortedItems = computed(() => {
    return [...this.queueStore.items()].sort((a, b) => {
      // Processing first, then pending, then failed, then completed
      const order: Record<string, number> = { processing: 0, pending: 1, failed: 2, completed: 3 };
      const diff = (order[a.status] ?? 4) - (order[b.status] ?? 4);
      if (diff !== 0) return diff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  });

  typeIcon(type: string): string {
    const icons: Record<string, string> = {
      'draft-create': 'edit_note',
      'draft-update': 'edit_note',
      'send': 'send',
      'move': 'drive_file_move',
      'flag': 'flag',
      'delete': 'delete',
    };
    return icons[type] || 'pending';
  }

  statusLabel(status: string): string {
    const labels: Record<string, string> = {
      pending: 'Pending',
      processing: 'Active',
      completed: 'Done',
      failed: 'Failed',
    };
    return labels[status] || status;
  }

  relativeTime(isoDate: string): string {
    const diff = Date.now() - new Date(isoDate).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

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
