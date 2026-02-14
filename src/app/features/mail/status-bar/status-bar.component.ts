import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AccountsStore } from '../../../store/accounts.store';
import { EmailsStore } from '../../../store/emails.store';
import { UiStore } from '../../../store/ui.store';

@Component({
  selector: 'app-status-bar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="status-bar">
      <div class="status-left">
        @if (emailsStore.syncing()) {
          <span class="status-item syncing">
            <span class="material-symbols-outlined spinning">sync</span>
            Syncing{{ emailsStore.syncProgress() > 0 ? ' ' + emailsStore.syncProgress() + '%' : '...' }}
          </span>
        } @else {
          <span class="status-item">
            <span class="material-symbols-outlined">check_circle</span>
            Synced
          </span>
        }
        <span class="status-separator">|</span>
        <span class="status-item">
          {{ accountsStore.accountCount() }} account{{ accountsStore.accountCount() !== 1 ? 's' : '' }}
        </span>
      </div>
      <div class="status-right">
        <span class="status-item hint">
          Ctrl+K
        </span>
      </div>
    </div>
  `,
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
export class StatusBarComponent {
  readonly accountsStore = inject(AccountsStore);
  readonly emailsStore = inject(EmailsStore);
  readonly uiStore = inject(UiStore);
}
