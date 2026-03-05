import { Component, computed, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AccountsStore } from '../../../store/accounts.store';
import { EmailsStore } from '../../../store/emails.store';
import { AiStore } from '../../../store/ai.store';
import { UiStore } from '../../../store/ui.store';
import { QueueStore } from '../../../store/queue.store';
import { ElectronService } from '../../../core/services/electron.service';
import { ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'app-status-bar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './status-bar.component.html',
  styleUrl: './status-bar.component.scss',
})
export class StatusBarComponent implements OnInit, OnDestroy {
  readonly accountsStore = inject(AccountsStore);
  readonly emailsStore = inject(EmailsStore);
  readonly aiStore = inject(AiStore);
  readonly uiStore = inject(UiStore);
  readonly queueStore = inject(QueueStore);
  private readonly electronService = inject(ElectronService);
  private readonly toastService = inject(ToastService);
  private readonly router = inject(Router);

  /** Counter that increments every 30s to trigger relative time recalculation */
  readonly tick = signal(0);
  /** True when background sync is paused (via status bar button or CLI). */
  readonly syncPaused = signal(false);
  private tickInterval?: ReturnType<typeof setInterval>;
  private aiStatusSub?: Subscription;
  private syncPausedSub?: Subscription;

  /** Computed so the value is stable during change detection and only updates when deps change. */
  readonly relativeTime = computed(() => {
    this.tick(); // dependency: recompute every 30s
    const iso = this.emailsStore.lastSyncTime();
    if (!iso) {
      return 'Never';
    }
    const diff = Date.now() - new Date(iso).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 10) {
      return 'just now';
    }
    if (seconds < 60) {
      return `${seconds}s ago`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  });

  ngOnInit(): void {
    this.tickInterval = setInterval(() => {
      this.tick.update(v => v + 1);
    }, 30_000);

    // Check AI status on init
    this.aiStore.checkStatus();

    // Subscribe to AI status push events
    this.aiStatusSub = this.electronService
      .onEvent<{ connected: boolean; url: string; currentModel: string }>('ai:status')
      .subscribe(status => {
        this.aiStore.updateStatus(status);
      });

    // Hydrate initial sync-paused state from main process
    this.electronService.getSyncPaused().then(response => {
      if (response.success && response.data) {
        this.syncPaused.set(response.data.paused);
      }
    }).catch(() => {
      // Not critical — indicator defaults to unpaused
    });

    // Subscribe to push events when pause state changes (via CLI pause-sync / resume-sync)
    this.syncPausedSub = this.electronService
      .onEvent<{ paused: boolean }>('sync:paused-state-changed')
      .subscribe(payload => {
        this.syncPaused.set(payload.paused);
      });
  }

  /** Computed icon for the queue status indicator. Always returns an icon (idle = 'done'). */
  readonly queueIcon = computed(() => {
    const processing = this.queueStore.processingCount() > 0;
    const failed = this.queueStore.failedCount() > 0;
    const pending = this.queueStore.pendingCount() > 0;
    if (processing) {
      return 'autorenew';
    }
    if (failed) {
      return 'error';
    }
    if (pending) {
      return 'hourglass_empty';
    }
    return 'done';
  });

  /** Tooltip text for the queue status indicator. */
  readonly queueTooltip = computed(() => {
    const processing = this.queueStore.processingCount();
    const pending = this.queueStore.pendingCount();
    const failed = this.queueStore.failedCount();
    const desc = this.queueStore.currentProcessingDescription();
    const parts: string[] = [];
    if (desc) {
      parts.push(`Processing: ${desc}`);
    }
    const counts: string[] = [];
    if (pending > 0) {
      counts.push(`${pending} pending`);
    }
    if (processing > 0) {
      counts.push(`${processing} processing`);
    }
    if (failed > 0) {
      counts.push(`${failed} failed`);
    }
    if (counts.length > 0) {
      parts.push(counts.join(', '));
    }
    if (failed > 0 && processing === 0 && pending === 0) {
      parts.push('Click to view');
    }
    const text = parts.join(' | ');
    return text || 'Queue: idle — click to open queue settings';
  });

  /** Aria label for the queue status indicator. */
  readonly queueAriaLabel = computed(() => {
    const active = this.queueStore.activeCount();
    const failed = this.queueStore.failedCount();
    return `Queue: ${active} active, ${failed} failed — open queue settings`;
  });

  navigateToQueue(): void {
    this.router.navigate(['/settings/queue']);
  }

  /** Trigger manual sync for the active account (same logic as former header sync button). */
  triggerManualSync(): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (activeAccount && !this.emailsStore.syncing()) {
      this.emailsStore.syncAccount(activeAccount.id);
    }
  }

  /** Pause background sync (same as CLI pause-sync). */
  pauseSync(): void {
    this.electronService.pauseSync().then(response => {
      if (response.success) {
        this.toastService.success('Sync paused');
      }
    });
  }

  /** Resume background sync (same as CLI resume-sync; also resumes after sleep). */
  resumeSync(): void {
    this.electronService.resumeSync().then(response => {
      if (response.success) {
        this.toastService.success('Sync resumed');
      }
    });
  }

  ngOnDestroy(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
    this.aiStatusSub?.unsubscribe();
    this.syncPausedSub?.unsubscribe();
  }

  fullTimestamp(): string {
    const iso = this.emailsStore.lastSyncTime();
    if (!iso) {
      return 'Never synced';
    }
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
}
