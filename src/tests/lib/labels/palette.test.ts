import { describe, expect, it } from 'vitest';
import {
  LABEL_COLOR_BY_GMAIL_HEX,
  LABEL_COLOR_BY_ID,
  LABEL_COLOR_PALETTE,
  resolveLabelColorSwatch,
} from '@/lib/labels/palette';

describe('label colour palette', () => {
  it('gives every swatch a human-readable name and literal utility classes', () => {
    expect(LABEL_COLOR_PALETTE.length).toBeGreaterThan(0);
    for (const [index, swatch] of LABEL_COLOR_PALETTE.entries()) {
      expect(swatch.name).toMatch(/\S/);

      expect(swatch.backgroundClass).toContain(`bg-label-gmail-${index}`);
      expect(swatch.textClass).toContain(`text-label-on-gmail-${index}`);
      expect(swatch.dotClass).toContain(`bg-label-gmail-${index}`);

      expect(swatch.backgroundClass).not.toMatch(/\[.*]/);
      expect(swatch.textClass).not.toMatch(/\[.*]/);
      expect(swatch.dotClass).not.toMatch(/\[.*]/);
    }
  });

  it('indexes every palette entry by id', () => {
    for (const swatch of LABEL_COLOR_PALETTE) {
      expect(LABEL_COLOR_BY_ID[swatch.id]).toBe(swatch);
    }
  });

  it('carries a real Gmail colour pair distinct from every other swatch', () => {
    const seen = new Set<string>();
    for (const swatch of LABEL_COLOR_PALETTE) {
      expect(swatch.gmailBackground).toMatch(/^#[0-9a-f]{6}$/);
      expect(swatch.gmailText).toMatch(/^#[0-9a-f]{6}$/);
      const key = `${swatch.gmailBackground}|${swatch.gmailText}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('resolves a Gmail colour pair back to its swatch, case-insensitively', () => {
    for (const swatch of LABEL_COLOR_PALETTE) {
      expect(LABEL_COLOR_BY_GMAIL_HEX[`${swatch.gmailBackground}|${swatch.gmailText}`]).toBe(
        swatch,
      );
      expect(
        resolveLabelColorSwatch({
          background: swatch.gmailBackground.toUpperCase(),
          text: swatch.gmailText.toUpperCase(),
        }),
      ).toBe(swatch);
    }
  });

  it('resolves an unrecognised or missing colour to null', () => {
    expect(resolveLabelColorSwatch(null)).toBeNull();
    expect(resolveLabelColorSwatch(undefined)).toBeNull();
    expect(resolveLabelColorSwatch({ background: '#123456', text: '#654321' })).toBeNull();
  });
});
