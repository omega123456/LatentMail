import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ElectronService } from '../services/electron.service';

/**
 * AuthGuard: Checks for at least one authenticated account with valid tokens.
 * Redirects to /auth if no accounts found.
 */
export const authGuard: CanActivateFn = async () => {
  const electronService = inject(ElectronService);
  const router = inject(Router);

  // In non-Electron environment (browser dev), allow access
  if (!electronService.isElectron) {
    return true;
  }

  try {
    const response = await electronService.getAccountCount();
    if (response.success && (response.data as number) > 0) {
      return true;
    }
  } catch {
    // Fall through to redirect
  }

  return router.createUrlTree(['/auth']);
};
