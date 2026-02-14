import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { Router } from '@angular/router';
import { ElectronService } from '../../core/services/electron.service';

@Component({
  selector: 'app-auth-landing',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatCardModule],
  template: `
    <div class="auth-container">
      <mat-card class="auth-card">
        <mat-card-content>
          <div class="auth-header">
            <span class="material-symbols-outlined auth-icon">mail</span>
            <h1>MailClient</h1>
            <p class="auth-tagline">Your email, your way.<br>AI-powered. Private.</p>
          </div>

          <button mat-raised-button color="primary" class="auth-button" (click)="signIn()">
            Sign in with Google
          </button>

          <p class="auth-legal">
            By signing in, you agree to our Terms of Service.
          </p>
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [`
    .auth-container {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      background-color: var(--color-background);
    }

    .auth-card {
      max-width: 400px;
      width: 100%;
      padding: 48px 32px;
      text-align: center;
    }

    .auth-header {
      margin-bottom: 32px;
    }

    .auth-icon {
      font-size: 48px;
      color: var(--color-primary);
      margin-bottom: 16px;
    }

    h1 {
      font-size: 24px;
      font-weight: 600;
      color: var(--color-text-primary);
      margin: 8px 0;
    }

    .auth-tagline {
      color: var(--color-text-secondary);
      font-size: 14px;
      line-height: 1.6;
    }

    .auth-button {
      width: 100%;
      height: 48px;
      font-size: 16px;
      margin-bottom: 16px;
    }

    .auth-legal {
      color: var(--color-text-tertiary);
      font-size: 12px;
    }
  `]
})
export class AuthLandingComponent {
  constructor(
    private electronService: ElectronService,
    private router: Router,
  ) {}

  async signIn(): Promise<void> {
    const result = await this.electronService.login();
    if (result.success) {
      this.router.navigate(['/mail']);
    }
  }
}
