import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DensityGlyph, LayoutGlyph } from '@/components/settings/LayoutGlyph';

describe('LayoutGlyph', () => {
  it('renders a distinct schematic for each layout mode', () => {
    for (const layout of ['three-column', 'bottom-preview', 'list-only'] as const) {
      const { container, unmount } = render(<LayoutGlyph layout={layout} />);
      expect(container.querySelectorAll('i').length).toBeGreaterThan(0);
      unmount();
    }
  });
});

describe('DensityGlyph', () => {
  it('renders a distinct schematic for each density', () => {
    for (const density of ['compact', 'comfortable', 'spacious'] as const) {
      const { container, unmount } = render(<DensityGlyph density={density} />);
      expect(container.querySelectorAll('i').length).toBe(3);
      unmount();
    }
  });
});
