import regularUrl from '@/assets/fonts/selawik-regular.woff2?url';
import semiboldUrl from '@/assets/fonts/selawik-semibold.woff2?url';
import boldUrl from '@/assets/fonts/selawik-bold.woff2?url';

export const uiFontStack =
  "'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', Selawik, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";

export const selawikUnicodeRangeWithoutEllipsis = 'U+0000-2025, U+2027-FFFF';

export const selawikFaces = [
  { weight: '400', url: regularUrl },
  { weight: '600', url: semiboldUrl },
  { weight: '700', url: boldUrl },
];

export const selawikFontFaceCss = selawikFaces
  .map(
    ({ weight, url }) =>
      `@font-face{font-family:Selawik;src:url(${url}) format('woff2');font-weight:${weight};unicode-range:${selawikUnicodeRangeWithoutEllipsis};font-display:block}`,
  )
  .join('');
