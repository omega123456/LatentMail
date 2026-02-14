import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AccountsStore } from '../../store/accounts.store';

@Component({
  selector: 'app-auth-landing',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatProgressSpinnerModule],
  template: `
    <div class="auth-container">
      <div class="auth-card">
        <div class="app-logo">
          <span class="material-symbols-outlined logo-icon">mail</span>
        </div>
        <h1 class="app-name">MailClient</h1>
        <p class="tagline">Your email, your way.<br>AI-powered. Private.</p>

        @if (accountsStore.error(); as error) {
          <div class="error-banner">
            <span class="material-symbols-outlined">error</span>
            <span>{{ error }}</span>
            <button class="dismiss-btn" (click)="accountsStore.clearError()">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>
        }

        <button
          mat-raised-button
          class="google-signin-btn"
          (click)="onLogin()"
          [disabled]="accountsStore.loginInProgress()"
        >
          @if (accountsStore.loginInProgress()) {
            <mat-spinner diameter="20" class="btn-spinner"></mat-spinner>
            <span>Signing in...</span>
          } @else {
            <svg class="google-icon" viewBox="0 0 24 24" width="20" height="20">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            <span>Sign in with Google</span>
          }
        </button>

        <p class="legal-text">
          Secure OAuth 2.0 authentication.<br>
          Your data stays on your device.
        </p>

        @if (accountsStore.hasAccounts()) {
          <button
            mat-button
            class="skip-btn"
            (click)="goToMail()"
          >
            Skip — go to inbox
          </button>
        }
      </div>
    </div>
  `,
  styles: [`
    .auth-container {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100%;
      background-color: var(--color-background);
      padding: 24px;
    }

    .auth-card {
      max-width: 400px;
      width: 100%;
      background-color: var(--color-surface);
      border-radius: 12px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
      padding: 48px 40px;
      text-align: center;
    }

    .app-logo {
      margin-bottom: 16px;
    }

    .logo-icon {
      font-size: 56px;
      color: var(--color-primary);
    }

    .app-name {
      font-size: 28px;
      font-weight: 700;
      color: var(--color-text-primary);
      margin: 0 0 8px 0;
    }

    .tagline {
      font-size: 15px;
      color: var(--color-text-secondary);
      margin: 0 0 32px 0;
      line-height: 1.5;
    }

    .error-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background-color: #FDECEA;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 13px;
      color: var(--color-error, #D32F2F);
      text-align: left;

      .material-symbols-outlined {
        font-size: 18px;
        flex-shrink: 0;
      }

      span:nth-child(2) {
        flex: 1;
      }

      .dismiss-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 2px;
        color: inherit;
        display: flex;
        align-items: center;

        .material-symbols-outlined {
          font-size: 16px;
        }
      }
    }

    .google-signin-btn {
      width: 100%;
      height: 48px;
      font-size: 15px;
      font-weight: 500;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      border-radius: 8px !important;
      text-transform: none;
      letter-spacing: 0;
    }

    .google-icon {
      flex-shrink: 0;
    }

    .btn-spinner {
      display: inline-block;
    }

    .legal-text {
      font-size: 12px;
      color: var(--color-text-tertiary);
      margin: 20px 0 0 0;
      line-height: 1.6;
    }

    .skip-btn {
      margin-top: 12px;
      font-size: 13px;
      color: var(--color-primary);
    }
  `]
})
export class AuthLandingComponent {
  readonly accountsStore = inject(AccountsStore);
  private readonly router = inject(Router);

  async onLogin(): Promise<void> {
    const account = await this.accountsStore.login();
    if (account) {
      this.router.navigate(['/mail']);
    }
  }

  goToMail(): void {
    this.router.navigate(['/mail']);
  }
}
