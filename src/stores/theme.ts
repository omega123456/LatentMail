import { create } from 'zustand';
import { invoke } from '@/lib/ipc/commands';
import { hydrateSettings } from '@/lib/settings/hydrate';
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

export const useThemeStore = create<ThemeState>((set) => ({
  theme: 'system',
  hydrated: false,
  hydrate: () => {
    return hydrateSettings().then(({ theme }) => {
      applyTheme(theme);
      set({ theme, hydrated: true });
    });
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
