import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcFixtures } from '@/tests/fixtures';

beforeEach(() => {
  vi.resetModules();
});

describe('hydrateSettings', () => {
  it('shares one settings read across all callers', async () => {
    const { ipc } = await import('@/tests/ipc-mock');
    ipc.reset();
    let reads = 0;
    ipc.override('read_settings', () => {
      reads += 1;
      return ipcFixtures.read_settings;
    });
    const { hydrateSettings, resetSettingsHydration } = await import('@/lib/settings/hydrate');

    await Promise.all([hydrateSettings(), hydrateSettings(), hydrateSettings()]);

    expect(reads).toBe(1);
    resetSettingsHydration();
  });
});
