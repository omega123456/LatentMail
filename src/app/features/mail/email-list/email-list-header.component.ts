import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FoldersStore } from '../../../store/folders.store';
import { EmailsStore } from '../../../store/emails.store';
import { UiStore } from '../../../store/ui.store';
import { LayoutMode, DensityMode } from '../../../core/services/layout.service';

@Component({
  selector: 'app-email-list-header',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="email-list-header">
      <div class="header-left">
        <span class="folder-name">{{ foldersStore.activeFolder()?.name || 'Inbox' }}</span>
        @if (emailsStore.syncing()) {
          <span class="sync-indicator">
            <span class="material-symbols-outlined spinning">sync</span>
          </span>
        }
      </div>
      <div class="header-actions">
        <!-- Density toggle -->
        <button class="header-btn" (click)="cycleDensity()" title="Change density">
          <span class="material-symbols-outlined">
            {{ densityIcon() }}
          </span>
        </button>

        <!-- Layout toggle -->
        <button class="header-btn" (click)="cycleLayout()" title="Change layout">
          <span class="material-symbols-outlined">
            {{ layoutIcon() }}
          </span>
        </button>
      </div>
    </div>
  `,
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

    .sync-indicator {
      display: flex;
      align-items: center;

      .material-symbols-outlined {
        font-size: 16px;
        color: var(--color-text-tertiary);
      }
    }

    .spinning {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
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
export class EmailListHeaderComponent {
  readonly foldersStore = inject(FoldersStore);
  readonly emailsStore = inject(EmailsStore);
  readonly uiStore = inject(UiStore);

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
