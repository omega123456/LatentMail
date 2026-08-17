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
      syncIntervalSeconds: 30,
      showSenderAvatars: false,
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
      showSenderAvatars: false,
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

  it('persists whole-pixel pane sizes from fractional drag offsets', async () => {
    const store = await loadStore();
    const writes: Array<{ key: string; value: unknown }> = [];
    ipc.override('write_setting', (args) => {
      writes.push(args);
    });


    store.getState().setSidebarWidth(300.4);
    store.getState().setListWidth(420.6);
    store.getState().setReaderHeight(60.5);
    await Promise.resolve();

    expect(writes).toEqual([
      { key: 'sidebarWidth', value: 300 },
      { key: 'listWidth', value: 421 },
      { key: 'readerHeight', value: 61 },
    ]);
    expect(store.getState()).toMatchObject({ sidebarWidth: 300, listWidth: 421, readerHeight: 61 });
  });
});
