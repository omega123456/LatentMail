import { PALETTE_SWATCHES_1 } from './palette-swatches-1';
import { PALETTE_SWATCHES_2 } from './palette-swatches-2';
import { PALETTE_SWATCHES_3 } from './palette-swatches-3';
import { PALETTE_SWATCHES_4 } from './palette-swatches-4';
import type { LabelColorId, LabelColorSwatch } from './palette-types';

export type { LabelColorId, LabelColorSwatch };

export const LABEL_COLOR_PALETTE: LabelColorSwatch[] = [
  ...PALETTE_SWATCHES_1,
  ...PALETTE_SWATCHES_2,
  ...PALETTE_SWATCHES_3,
  ...PALETTE_SWATCHES_4,
];

const GMAIL_COLOR_KEY_SEPARATOR = '|';

function gmailColorKey(background: string, text: string): string {
  return background.toLowerCase() + GMAIL_COLOR_KEY_SEPARATOR + text.toLowerCase();
}

export const LABEL_COLOR_BY_ID: Record<string, LabelColorSwatch> = Object.fromEntries(
  LABEL_COLOR_PALETTE.map((swatch): [string, LabelColorSwatch] => [swatch.id, swatch]),
);

export const LABEL_COLOR_BY_GMAIL_HEX: Record<string, LabelColorSwatch> = Object.fromEntries(
  LABEL_COLOR_PALETTE.map((swatch): [string, LabelColorSwatch] => [
    gmailColorKey(swatch.gmailBackground, swatch.gmailText),
    swatch,
  ]),
);

export function resolveLabelColorSwatch(
  color: { background: string; text: string } | null | undefined,
): LabelColorSwatch | null {
  if (!color) return null;
  return LABEL_COLOR_BY_GMAIL_HEX[gmailColorKey(color.background, color.text)] ?? null;
}
