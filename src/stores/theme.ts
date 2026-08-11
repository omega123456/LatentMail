import { create } from 'zustand';
import { invoke } from '@/lib/ipc/commands';
import type { ThemePreference } from '@/lib/types/ipc';

export type Theme = ThemePreference;

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle(
    'dark',
    theme === 'dark' || (theme === 'system' && darkMedia.matches),
  );
}

type ThemeState = {
  theme: Theme;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setTheme: (theme: Theme) => void;
};

let hydration: Promise<void> | undefined;

export const useThemeStore = create<ThemeState>((set) => ({
  theme: 'system',
  hydrated: false,
  hydrate: () => {
    hydration ??= invoke('read_settings', {}).then(({ theme }) => {
      applyTheme(theme);
      set({ theme, hydrated: true });
    });
    return hydration;
  },
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
    void invoke('write_setting', { key: 'theme', value: theme }).catch(() => undefined);
  },
}));

darkMedia.addEventListener('change', () => {
  if (useThemeStore.getState().theme === 'system') {
    applyTheme('system');
  }
});

applyTheme('system');
