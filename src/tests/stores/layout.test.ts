import { beforeEach, describe, expect, it } from 'vitest';
import { ipc } from '@/tests/ipc-mock';

async function loadStore() {
  const module = await import('@/stores/layout');
  module.useLayoutStore.setState({
    layout: 'three-column',
    density: 'comfortable',
    sidebarCollapsed: false,
    sidebarWidth: 260,
    listWidth: 350,
    readerHeight: 40,
    route: 'mail',
    hydrated: false,
  });
  return module.useLayoutStore;
}

describe('layout store', () => {
  beforeEach(() => ipc.reset());

  it('hydrates persisted layout preferences but keeps the fresh-launch route', async () => {
    ipc.override('read_settings', {
      theme: 'dark',
      layout: 'bottom-preview',
      density: 'compact',
      sidebarCollapsed: true,
      sidebarWidth: 300,
      listWidth: 420,
      readerHeight: 60,
      syncOnStartup: false,
      showUnreadCounts: false,
      syncIntervalMinutes: 10,
    });
    const store = await loadStore();
    store.getState().setRoute('settings');

    await store.getState().hydrate();

    expect(store.getState()).toMatchObject({
      layout: 'bottom-preview',
      density: 'compact',
      sidebarCollapsed: true,
      sidebarWidth: 300,
      listWidth: 420,
      readerHeight: 60,
      route: 'settings',
      hydrated: true,
    });
  });

  it('writes each changed pane preference immediately', async () => {
    const store = await loadStore();
    const writes: Array<{ key: string; value: unknown }> = [];
    ipc.override('write_setting', (args) => {
      writes.push(args);
    });

    store.getState().setLayout('list-only');
    store.getState().setDensity('spacious');
    store.getState().setSidebarCollapsed(true);
    store.getState().setSidebarWidth(300);
    store.getState().setListWidth(420);
    store.getState().setReaderHeight(60);
    await Promise.resolve();

    expect(writes).toEqual([
      { key: 'layout', value: 'list-only' },
      { key: 'density', value: 'spacious' },
      { key: 'sidebarCollapsed', value: true },
      { key: 'sidebarWidth', value: 300 },
      { key: 'listWidth', value: 420 },
      { key: 'readerHeight', value: 60 },
    ]);
  });
});
