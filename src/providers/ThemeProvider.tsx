import { useEffect, type PropsWithChildren } from 'react';
import interUrl from '@/assets/inter-latin.woff2?url';
import { applyTheme, useThemeStore } from '@/stores/theme';

let fontLoaded = false;

function loadInter() {
  if (fontLoaded || typeof FontFace === 'undefined' || !document.fonts) {
    return;
  }

  fontLoaded = true;
  const face = new FontFace('Inter', `url(${interUrl})`, { weight: '100 900' });
  void face.load().then(
    (loadedFace) => document.fonts.add(loadedFace),
    () => undefined,
  );
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const theme = useThemeStore((state) => state.theme);
  const hydrate = useThemeStore((state) => state.hydrate);

  useEffect(() => {
    applyTheme(theme);
    loadInter();
  }, [theme]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return children;
}
