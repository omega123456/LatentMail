import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ElectronService } from '../services/electron.service';

/**
 * SetupGuard: Checks if accounts exist. If accounts exist, redirects away from /auth to /mail.
 * This prevents authenticated users from seeing the login page.
 */
export const setupGuard: CanActivateFn = async () => {
  const electronService = inject(ElectronService);
  const router = inject(Router);

  // In non-Electron environment (browser dev), allow access to auth page
  if (!electronService.isElectron) {
    return true;
  }

  try {
    const response = await electronService.getAccountCount();
    if (response.success && (response.data as number) > 0) {
      // Already have accounts, redirect to mail
      return router.createUrlTree(['/mail']);
    }
  } catch (err) {
    console.warn('SetupGuard account check failed', err);
  }

  return true;
};
