import { Component, computed, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AccountsStore } from '../../../store/accounts.store';
import { EmailsStore } from '../../../store/emails.store';
import { UiStore } from '../../../store/ui.store';

@Component({
  selector: 'app-status-bar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './status-bar.component.html',
  styles: [`
    .status-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: var(--statusbar-height, 24px);
      padding: 0 12px;
      background-color: var(--color-surface-variant);
      border-top: 1px solid var(--color-border);
      font-size: 11px;
      color: var(--color-text-tertiary);
      user-select: none;
      flex-shrink: 0;
      width: 100%;
    }

    .status-left, .status-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .status-item {
      display: flex;
      align-items: center;
      gap: 4px;

      .material-symbols-outlined {
        font-size: 14px;
      }
    }

    .status-item.syncing .material-symbols-outlined {
      color: var(--color-primary);
    }

    .status-separator {
      color: var(--color-border);
    }

    .spinning {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .hint {
      opacity: 0.7;
    }
  `]
})
export class StatusBarComponent implements OnInit, OnDestroy {
  readonly accountsStore = inject(AccountsStore);
  readonly emailsStore = inject(EmailsStore);
  readonly uiStore = inject(UiStore);

  /** Counter that increments every 30s to trigger relative time recalculation */
  readonly tick = signal(0);
  private tickInterval?: ReturnType<typeof setInterval>;

  /** Computed so the value is stable during change detection and only updates when deps change. */
  readonly relativeTime = computed(() => {
    this.tick(); // dependency: recompute every 30s
    const iso = this.emailsStore.lastSyncTime();
    if (!iso) return 'Never';
    const diff = Date.now() - new Date(iso).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  });

  ngOnInit(): void {
    this.tickInterval = setInterval(() => {
      this.tick.update(v => v + 1);
    }, 30_000);
  }

  ngOnDestroy(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
  }

  fullTimestamp(): string {
    const iso = this.emailsStore.lastSyncTime();
    if (!iso) return 'Never synced';
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
}
