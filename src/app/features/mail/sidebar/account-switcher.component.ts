import { Component, inject, input, output } from '@angular/core';
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

  /** Emits the account ID when the user switches or adds an account. */
  readonly accountSwitched = output<number>();

  switchAccount(accountId: number): void {
    this.accountSwitched.emit(accountId);
  }

  async addAccount(): Promise<void> {
    const account = await this.accountsStore.login();
    if (account) {
      this.accountSwitched.emit(account.id);
    }
  }

  manageAccounts(): void {
    this.router.navigate(['/settings/accounts']);
  }
}
