import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

it('loads the bundled Inter face when the browser supports it', async () => {
  const add = vi.fn();
  const load = vi.fn().mockResolvedValue('inter-face');
  class FakeFontFace {
    load = load;
  }
  vi.stubGlobal('FontFace', FakeFontFace);
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add } });
  vi.resetModules();
  const { ThemeProvider } = await import('@/providers/ThemeProvider');

  render(
    <ThemeProvider>
      <span>theme</span>
    </ThemeProvider>,
  );

  await vi.waitFor(() => expect(add).toHaveBeenCalledWith('inter-face'));
});
