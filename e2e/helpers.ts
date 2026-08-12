import type { Page } from '@playwright/test';
import { playwrightIpcFixtures } from '@/tests/playwright-fixtures';

export async function installPlaywrightIpc(
  page: Page,
  overrides: Record<string, unknown> = {},
  readerState?: 'loading' | 'error',
  syncStatus?: { state: 'idle' | 'syncing' | 'error'; lastSynced: string; error?: string },
  rejectedCommands: string[] = [],
  pendingCommands: string[] = [],
) {
  // `syncStatus` feeds the same `read_sync_status`/`trigger_sync` commands
  // real usage calls through `useSyncStore.hydrateSync` — a single source
  // of truth instead of a second channel that could race the real fetch.
  const syncOverride = syncStatus
    ? {
        read_sync_status: {
          accountId: '',
          state: syncStatus.state,
          lastSyncedAt: Date.parse(syncStatus.lastSynced),
          lastError: syncStatus.error ?? null,
        },
      }
    : {};
  await page.addInitScript(
    ({
      fixtures,
      overrides: supplied,
      readerState: state,
      rejectedCommands,
      pendingCommands,
      voidCommands,
    }) => {
      const responses = { ...fixtures, ...supplied } as Record<string, unknown>;
      window.__LATENTMAIL_PLAYWRIGHT_IPC__ = {
        invoke: async (command) => {
          if (rejectedCommands.includes(command)) throw new Error('Mocked IPC failure');
          if (pendingCommands.includes(command)) return new Promise(() => undefined);
          if (command in responses) return responses[command];
          // Serializing the fixture map into the page drops every key whose
          // value is `undefined`, so the void-result commands (mutations,
          // write_setting, …) arrive here looking unmocked. Their names are
          // passed separately for exactly that reason.
          if (voidCommands.includes(command)) return undefined;
          throw new Error(`[playwright] Unmocked Tauri IPC command: ${command}`);
        },
        listen: async () => () => undefined,
      };
      window.__LATENTMAIL_PLAYWRIGHT_READER_STATE__ = state;
    },
    {
      fixtures: playwrightIpcFixtures,
      overrides: { ...overrides, ...syncOverride },
      readerState,
      rejectedCommands,
      pendingCommands,
      voidCommands: Object.keys(playwrightIpcFixtures),
    },
  );
}
