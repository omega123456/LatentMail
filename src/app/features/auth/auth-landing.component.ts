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
  styleUrl: './auth-landing.component.scss',
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
