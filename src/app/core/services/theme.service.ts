import { Injectable, signal, effect } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<ThemeMode>('system');

  constructor() {
    // Load saved preference
    const saved = localStorage.getItem('theme') as ThemeMode | null;
    if (saved && ['light', 'dark', 'system'].includes(saved)) {
      this.theme.set(saved);
    }

    // Apply theme when it changes
    effect(() => {
      const mode = this.theme();
      document.documentElement.setAttribute('data-theme', mode);
      localStorage.setItem('theme', mode);
    });
  }

  setTheme(mode: ThemeMode): void {
    this.theme.set(mode);
  }

  toggleTheme(): void {
    const current = this.theme();
    const next: ThemeMode = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
    this.theme.set(next);
  }
}
