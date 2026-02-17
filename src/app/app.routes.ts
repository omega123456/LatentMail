import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { setupGuard } from './core/guards/setup.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'mail',
    pathMatch: 'full',
  },
  {
    path: 'auth',
    canActivate: [setupGuard],
    loadComponent: () =>
      import('./features/auth/auth-landing.component').then(m => m.AuthLandingComponent),
  },
  {
    path: 'auth/callback',
    loadComponent: () =>
      import('./features/auth/auth-callback.component').then(m => m.AuthCallbackComponent),
  },
  {
    path: 'mail',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/mail/mail-shell.component').then(m => m.MailShellComponent),
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/settings/settings-shell.component').then(m => m.SettingsShellComponent),
    children: [
      {
        path: '',
        redirectTo: 'general',
        pathMatch: 'full',
      },
      {
        path: 'general',
        loadComponent: () =>
          import('./features/settings/general-settings.component').then(m => m.GeneralSettingsComponent),
      },
      {
        path: 'accounts',
        loadComponent: () =>
          import('./features/settings/account-settings.component').then(m => m.AccountSettingsComponent),
      },
      {
        path: 'queue',
        loadComponent: () =>
          import('./features/settings/queue-settings.component').then(m => m.QueueSettingsComponent),
      },
    ],
  },
  {
    path: '**',
    redirectTo: 'mail',
  },
];
