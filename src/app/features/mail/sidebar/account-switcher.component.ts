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
  styleUrl: './account-switcher.component.scss',
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
