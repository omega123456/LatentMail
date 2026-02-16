import { Component, inject, output, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FoldersStore } from '../../../store/folders.store';
import { EmailsStore } from '../../../store/emails.store';
import { UiStore } from '../../../store/ui.store';
import { LayoutMode, DensityMode } from '../../../core/services/layout.service';

@Component({
  selector: 'app-email-list-header',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './email-list-header.component.html',
  styles: [`
    .email-list-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--color-border);
      min-height: 44px;
      flex-shrink: 0;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .folder-name {
      font-weight: 600;
      font-size: 15px;
      color: var(--color-text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .spinning {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    @media (prefers-reduced-motion: reduce) {
      .spinning {
        animation: pulse 2s ease-in-out infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
    }

    .header-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .sync-time {
      font-size: 12px;
      color: var(--color-text-tertiary);
      white-space: nowrap;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .header-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: none;
      background: none;
      border-radius: 6px;
      cursor: pointer;
      color: var(--color-text-secondary);
      transition: background-color 120ms ease, color 120ms ease;

      &:hover {
        background-color: var(--color-surface-variant);
        color: var(--color-text-primary);
      }

      .material-symbols-outlined {
        font-size: 18px;
      }
    }
  `]
})
export class EmailListHeaderComponent implements OnInit, OnDestroy {
  readonly foldersStore = inject(FoldersStore);
  readonly emailsStore = inject(EmailsStore);
  readonly uiStore = inject(UiStore);
  readonly syncClicked = output<void>();

  /** Tick signal: increments every 1s so relative time is stable during change detection (computed only changes when tick or lastSyncTime changes). */
  private readonly tick = signal(0);
  private tickInterval?: ReturnType<typeof setInterval>;

  /** Computed relative time string. Depends only on signals, so same value for both CD passes → no NG0100. */
  readonly relativeTime = computed(() => {
    this.tick(); // dependency so we recalc when tick fires
    const iso = this.emailsStore.lastSyncTime();
    if (!iso) return '';
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
    }, 1000);
  }

  ngOnDestroy(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
  }

  onSyncClick(): void {
    this.syncClicked.emit();
  }

  densityIcon(): string {
    switch (this.uiStore.density()) {
      case 'compact': return 'density_small';
      case 'comfortable': return 'density_medium';
      case 'spacious': return 'density_large';
    }
  }

  layoutIcon(): string {
    switch (this.uiStore.layout()) {
      case 'three-column': return 'view_sidebar';
      case 'bottom-preview': return 'view_agenda';
      case 'list-only': return 'view_list';
    }
  }

  cycleDensity(): void {
    const modes: DensityMode[] = ['compact', 'comfortable', 'spacious'];
    const current = modes.indexOf(this.uiStore.density());
    this.uiStore.setDensity(modes[(current + 1) % modes.length]);
  }

  cycleLayout(): void {
    const modes: LayoutMode[] = ['three-column', 'bottom-preview', 'list-only'];
    const current = modes.indexOf(this.uiStore.layout());
    this.uiStore.setLayout(modes[(current + 1) % modes.length]);
  }
}
