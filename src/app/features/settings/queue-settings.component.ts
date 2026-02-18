import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { QueueStore, QueueItemSnapshot } from '../../store/queue.store';

@Component({
  selector: 'app-queue-settings',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule],
  templateUrl: './queue-settings.component.html',
  styleUrl: './queue-settings.component.scss',
})
export class QueueSettingsComponent {
  readonly queueStore = inject(QueueStore);

  readonly sortedItems = computed(() => {
    return [...this.queueStore.items()].sort((a, b) => {
      // Processing first, then pending, then failed, then cancelled, then completed
      const order: Record<string, number> = { processing: 0, pending: 1, failed: 2, cancelled: 3, completed: 4 };
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
      cancelled: 'Cancelled',
    };
    return labels[status] || status;
  }

  itemStatusLabel(item: QueueItemSnapshot): string {
    if (item.status === 'completed' && item.error) {
      return 'Done (warnings)';
    }
    return this.statusLabel(item.status);
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
