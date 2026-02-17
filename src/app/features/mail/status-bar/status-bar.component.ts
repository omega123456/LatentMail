import { Component, computed, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { AccountsStore } from '../../../store/accounts.store';
import { EmailsStore } from '../../../store/emails.store';
import { AiStore } from '../../../store/ai.store';
import { UiStore } from '../../../store/ui.store';
import { ElectronService } from '../../../core/services/electron.service';

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
  private readonly electronService = inject(ElectronService);

  /** Counter that increments every 30s to trigger relative time recalculation */
  readonly tick = signal(0);
  private tickInterval?: ReturnType<typeof setInterval>;
  private aiStatusSub?: Subscription;

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
  }

  ngOnDestroy(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
    this.aiStatusSub?.unsubscribe();
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
