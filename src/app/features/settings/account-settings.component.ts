import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Router } from '@angular/router';
import { AccountsStore } from '../../store/accounts.store';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/components/confirm-dialog.component';

@Component({
  selector: 'app-account-settings',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatDialogModule, MatProgressSpinnerModule],
  templateUrl: './account-settings.component.html',
  styleUrl: './account-settings.component.scss',
})
export class AccountSettingsComponent implements OnInit {
  readonly accountsStore = inject(AccountsStore);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);

  ngOnInit(): void {
    this.accountsStore.loadAccounts();
  }

  async addAccount(): Promise<void> {
    await this.accountsStore.login();
  }

  async reauthAccount(accountId: number): Promise<void> {
    this.accountsStore.setActiveAccount(accountId);
    await this.accountsStore.login();
  }

  confirmRemoveAccount(accountId: number, email: string): void {
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: 'Remove Account',
        message: `Are you sure you want to remove ${email}? All locally cached emails and data for this account will be permanently deleted.`,
        confirmText: 'Remove',
        confirmColor: 'warn',
      } as ConfirmDialogData,
      width: '400px',
    });

    dialogRef.afterClosed().subscribe(async (confirmed: boolean) => {
      if (confirmed) {
        const success = await this.accountsStore.removeAccount(accountId);
        // If last account was removed, redirect to auth
        if (success && !this.accountsStore.hasAccounts()) {
          this.router.navigate(['/auth']);
        }
      }
    });
  }
}
