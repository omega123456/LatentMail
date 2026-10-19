import { useEffect, type PropsWithChildren } from 'react';
import { applyTheme, useThemeStore } from '@/stores/theme';
import { selawikFaces, selawikUnicodeRangeWithoutEllipsis } from '@/lib/ui-font';

let fontLoaded = false;

function loadSelawik() {
  if (fontLoaded || typeof FontFace === 'undefined' || !document.fonts) {
    return;
  }

  fontLoaded = true;
  for (const { weight, url } of selawikFaces) {
    const face = new FontFace('Selawik', `url(${url})`, {
      weight,
      unicodeRange: selawikUnicodeRangeWithoutEllipsis,
    });
    void face.load().then(
      (loadedFace) => document.fonts.add(loadedFace),
      () => undefined,
    );
  }
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const theme = useThemeStore((state) => state.theme);
  const hydrate = useThemeStore((state) => state.hydrate);

  useEffect(() => {
    applyTheme(theme);
    loadSelawik();
  }, [theme]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return children;
}
