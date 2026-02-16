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
  templateUrl: './auth-landing.component.html',
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
