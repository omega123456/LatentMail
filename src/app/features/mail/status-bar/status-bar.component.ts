import { Component, computed, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { DateTime } from 'luxon';
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
    const duration = DateTime.now().diff(DateTime.fromISO(iso), ['days', 'hours', 'minutes', 'seconds']);
    const seconds = Math.floor(duration.as('seconds'));
    if (seconds < 10) {
      return 'just now';
    }
    if (seconds < 60) {
      return `${seconds}s ago`;
    }
    const minutes = Math.floor(duration.as('minutes'));
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.floor(duration.as('hours'));
    if (hours < 24) {
      return `${hours}h ago`;
    }
    const days = Math.floor(duration.as('days'));
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

  /** Computed icon for the queue status indicator. Checks both main and body-fetch queues.
   *  Shows 'autorenew' if either queue is processing, 'error' if either has failures and
   *  no items are actively processing (aligned with combinedHasFailed()), 'hourglass_empty'
   *  if either has pending items, 'done' only when both are fully idle.
   *
   *  Uses combinedHasFailed() for the error state so the icon is always in sync with the
   *  CSS class applied in the template (which also uses combinedHasFailed()).
   */
  readonly queueIcon = computed(() => {
    const mainProcessing = this.queueStore.processingCount() > 0;
    const bodyFetchProcessing = this.queueStore.bodyFetchProcessingCount() > 0;
    const mainPending = this.queueStore.pendingCount() > 0;
    const bodyFetchPending = this.queueStore.bodyFetchPendingCount() > 0;
    if (mainProcessing || bodyFetchProcessing) {
      return 'autorenew';
    }
    // Only show error icon when combinedHasFailed() is true (failures exist AND nothing is
    // actively processing). This keeps the icon consistent with the CSS class used in the
    // template, which also uses combinedHasFailed(). Without this alignment, a mixed
    // pending+failed state would show an error icon but a pending CSS class.
    if (this.combinedHasFailed()) {
      return 'error';
    }
    if (mainPending || bodyFetchPending) {
      return 'hourglass_empty';
    }
    return 'done';
  });

  /** True if either the main queue or body-fetch queue has items actively processing. */
  readonly combinedIsProcessing = computed(() =>
    this.queueStore.processingCount() > 0 || this.queueStore.bodyFetchProcessingCount() > 0
  );

  /**
   * True if either queue has failed items AND no items are currently processing.
   * Same semantics as the previous single-queue "show error when not actively processing" check.
   */
  readonly combinedHasFailed = computed(() =>
    (this.queueStore.failedCount() > 0 || this.queueStore.bodyFetchFailedCount() > 0) &&
    this.queueStore.activeCount() === 0
  );

  /** True only when both queues are fully idle (no active items, no failures). */
  readonly combinedIsIdle = computed(() =>
    this.queueStore.activeCount() === 0 &&
    this.queueStore.failedCount() === 0 &&
    this.queueStore.bodyFetchFailedCount() === 0
  );

  /** Total failed count across both queues (used for the badge in the status bar). */
  readonly combinedFailedCount = computed(() =>
    this.queueStore.failedCount() + this.queueStore.bodyFetchFailedCount()
  );

  /** Tooltip text for the queue status indicator — includes counts from both queues. */
  readonly queueTooltip = computed(() => {
    const mainProcessing = this.queueStore.processingCount();
    const mainPending = this.queueStore.pendingCount();
    const mainFailed = this.queueStore.failedCount();
    const bodyFetchProcessing = this.queueStore.bodyFetchProcessingCount();
    const bodyFetchPending = this.queueStore.bodyFetchPendingCount();
    const bodyFetchFailed = this.queueStore.bodyFetchFailedCount();
    const desc = this.queueStore.currentProcessingDescription();
    const parts: string[] = [];
    if (desc) {
      parts.push(`Processing: ${desc}`);
    }
    const counts: string[] = [];
    const totalPending = mainPending + bodyFetchPending;
    const totalProcessing = mainProcessing + bodyFetchProcessing;
    const totalFailed = mainFailed + bodyFetchFailed;
    if (totalPending > 0) {
      counts.push(`${totalPending} pending`);
    }
    if (totalProcessing > 0) {
      counts.push(`${totalProcessing} processing`);
    }
    if (totalFailed > 0) {
      counts.push(`${totalFailed} failed`);
    }
    if (counts.length > 0) {
      parts.push(counts.join(', '));
    }
    if (totalFailed > 0 && totalProcessing === 0 && totalPending === 0) {
      parts.push('Click to view');
    }
    const text = parts.join(' | ');
    return text || 'Queue: idle — click to open queue settings';
  });

  /** Aria label for the queue status indicator — includes combined counts from both queues. */
  readonly queueAriaLabel = computed(() => {
    const active = this.queueStore.activeCount();
    const mainFailed = this.queueStore.failedCount();
    const bodyFetchFailed = this.queueStore.bodyFetchFailedCount();
    const totalFailed = mainFailed + bodyFetchFailed;
    return `Queue: ${active} active, ${totalFailed} failed — open queue settings`;
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
    return DateTime.fromISO(iso).toLocaleString({
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
}
