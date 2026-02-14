import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'mail',
    pathMatch: 'full',
  },
  {
    path: 'auth',
    loadComponent: () =>
      import('./features/auth/auth-landing.component').then(m => m.AuthLandingComponent),
  },
  {
    path: 'mail',
    loadComponent: () =>
      import('./features/mail/mail-shell.component').then(m => m.MailShellComponent),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./features/settings/settings-shell.component').then(m => m.SettingsShellComponent),
  },
  {
    path: '**',
    redirectTo: 'mail',
  },
];
