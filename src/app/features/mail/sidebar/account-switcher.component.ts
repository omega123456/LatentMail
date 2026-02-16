import { Component, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { MatMenuModule } from '@angular/material/menu';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { AccountsStore } from '../../../store/accounts.store';

@Component({
  selector: 'app-account-switcher',
  standalone: true,
  imports: [CommonModule, MatMenuModule, MatButtonModule, MatDividerModule],
  templateUrl: './account-switcher.component.html',
  styles: [`
    .account-switcher {
      padding: 8px 12px;

      &.collapsed {
        padding: 8px 4px;
      }
    }

    .account-trigger {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 8px 10px;
      border: none;
      background: transparent;
      border-radius: 8px;
      cursor: pointer;
      transition: background-color 120ms ease;
      color: var(--color-text-primary);
      text-align: left;

      &:hover {
        background-color: var(--color-primary-light);
      }
    }

    .collapsed .account-trigger {
      justify-content: center;
      padding: 8px;
    }

    .avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background-color: var(--color-primary);
      background-size: cover;
      background-position: center;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .avatar-letter {
      font-size: 14px;
      font-weight: 600;
      color: white;
    }

    .account-info {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .account-name {
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .account-email {
      font-size: 11px;
      color: var(--color-text-tertiary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .expand-icon {
      font-size: 18px;
      color: var(--color-text-tertiary);
    }

    .menu-account {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .menu-avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background-color: var(--color-primary);
      background-size: cover;
      background-position: center;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;

      span {
        font-size: 12px;
        font-weight: 600;
        color: white;
      }
    }

    .menu-account-info {
      display: flex;
      flex-direction: column;
    }

    .menu-name {
      font-size: 13px;
      font-weight: 500;
    }

    .menu-email {
      font-size: 11px;
      color: var(--color-text-tertiary);
    }

    .reauth-icon {
      font-size: 18px;
      color: var(--color-accent, #FF6F00);
    }
  `]
})
export class AccountSwitcherComponent {
  readonly accountsStore = inject(AccountsStore);
  readonly collapsed = input(false);
  private readonly router = inject(Router);

  switchAccount(accountId: number): void {
    this.accountsStore.setActiveAccount(accountId);
    this.router.navigate(['/mail', accountId, 'INBOX']);
  }

  async addAccount(): Promise<void> {
    const account = await this.accountsStore.login();
    if (account) {
      this.router.navigate(['/mail', account.id, 'INBOX']);
    }
  }

  manageAccounts(): void {
    this.router.navigate(['/settings/accounts']);
  }
}
