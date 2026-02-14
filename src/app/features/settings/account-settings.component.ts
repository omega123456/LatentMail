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
  template: `
    <div class="account-settings">
      <h2>Accounts</h2>
      <p class="description">Manage your connected Gmail accounts.</p>

      @if (accountsStore.loading()) {
        <div class="loading-state">
          <mat-spinner diameter="32"></mat-spinner>
        </div>
      }

      @if (accountsStore.error(); as error) {
        <div class="error-banner">
          <span class="material-symbols-outlined">error</span>
          <span>{{ error }}</span>
        </div>
      }

      <div class="accounts-list">
        @for (account of accountsStore.accounts(); track account.id) {
          <div class="account-card">
            <div class="account-avatar" [style.background-image]="account.avatarUrl ? 'url(' + account.avatarUrl + ')' : ''">
              @if (!account.avatarUrl) {
                <span class="avatar-letter">{{ account.email[0].toUpperCase() }}</span>
              }
            </div>
            <div class="account-details">
              <span class="account-name">{{ account.displayName }}</span>
              <span class="account-email">{{ account.email }}</span>
              @if (account.needsReauth) {
                <span class="reauth-warning">
                  <span class="material-symbols-outlined">warning</span>
                  Needs re-authentication
                </span>
              }
            </div>
            <div class="account-actions">
              @if (account.needsReauth) {
                <button mat-raised-button color="primary" (click)="reauthAccount(account.id)">
                  Re-authenticate
                </button>
              }
              <button
                mat-button
                color="warn"
                (click)="confirmRemoveAccount(account.id, account.email)"
                [disabled]="accountsStore.loading()"
              >
                Remove
              </button>
            </div>
          </div>
        }
      </div>

      <div class="add-account-section">
        <button
          mat-stroked-button
          (click)="addAccount()"
          [disabled]="accountsStore.loginInProgress()"
        >
          @if (accountsStore.loginInProgress()) {
            <mat-spinner diameter="18" class="btn-spinner"></mat-spinner>
            <span>Adding account...</span>
          } @else {
            <span class="material-symbols-outlined">add</span>
            <span>Add Gmail account</span>
          }
        </button>
      </div>
    </div>
  `,
  styles: [`
    .account-settings {
      max-width: 600px;
    }

    h2 {
      font-size: 18px;
      font-weight: 600;
      margin: 0 0 4px 0;
      color: var(--color-text-primary);
    }

    .description {
      font-size: 13px;
      color: var(--color-text-secondary);
      margin: 0 0 24px 0;
    }

    .loading-state {
      display: flex;
      justify-content: center;
      padding: 24px;
    }

    .error-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background-color: #FDECEA;
      border-radius: 8px;
      margin-bottom: 16px;
      font-size: 13px;
      color: var(--color-error, #D32F2F);

      .material-symbols-outlined {
        font-size: 18px;
      }
    }

    .accounts-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 24px;
    }

    .account-card {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px;
      background-color: var(--color-surface-variant);
      border-radius: 8px;
      border: 1px solid var(--color-border);
    }

    .account-avatar {
      width: 40px;
      height: 40px;
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
      font-size: 16px;
      font-weight: 600;
      color: white;
    }

    .account-details {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      overflow: hidden;
    }

    .account-name {
      font-size: 14px;
      font-weight: 500;
      color: var(--color-text-primary);
    }

    .account-email {
      font-size: 12px;
      color: var(--color-text-secondary);
    }

    .reauth-warning {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      color: var(--color-accent, #FF6F00);
      margin-top: 2px;

      .material-symbols-outlined {
        font-size: 14px;
      }
    }

    .account-actions {
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }

    .add-account-section {
      button {
        display: flex;
        align-items: center;
        gap: 8px;

        .material-symbols-outlined {
          font-size: 20px;
        }
      }
    }

    .btn-spinner {
      display: inline-block;
    }
  `]
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
