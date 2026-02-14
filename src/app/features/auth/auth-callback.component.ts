import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

/**
 * Auth callback component — shown briefly while the OAuth flow completes.
 * In our architecture, the OAuth callback goes to the loopback HTTP server
 * (not the Angular app), so this component serves as a "waiting" screen
 * that the user sees while the system browser handles the redirect.
 *
 * It simply shows a loading state and redirects to /mail once the flow completes.
 */
@Component({
  selector: 'app-auth-callback',
  standalone: true,
  imports: [CommonModule, MatProgressSpinnerModule],
  template: `
    <div class="callback-container">
      <div class="callback-card">
        <mat-spinner diameter="40"></mat-spinner>
        <h2>Completing sign-in...</h2>
        <p>Please complete the authorization in your browser.</p>
        <p class="hint">You'll be redirected automatically once done.</p>
      </div>
    </div>
  `,
  styles: [`
    .callback-container {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100%;
      background-color: var(--color-background);
    }

    .callback-card {
      text-align: center;
      padding: 48px;

      h2 {
        margin: 24px 0 8px;
        font-size: 20px;
        font-weight: 600;
        color: var(--color-text-primary);
      }

      p {
        font-size: 14px;
        color: var(--color-text-secondary);
        margin: 0;
      }

      .hint {
        font-size: 12px;
        color: var(--color-text-tertiary);
        margin-top: 8px;
      }
    }
  `]
})
export class AuthCallbackComponent implements OnInit {
  private readonly router = inject(Router);

  ngOnInit(): void {
    // The OAuth flow is handled entirely by the main process.
    // If someone lands here directly, redirect them appropriately.
    // The auth landing component handles the actual login flow.
    setTimeout(() => {
      this.router.navigate(['/auth']);
    }, 3000);
  }
}
