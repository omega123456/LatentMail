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
  templateUrl: './auth-callback.component.html',
  styleUrl: './auth-callback.component.scss',
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
