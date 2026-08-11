import type { Page } from '@playwright/test';
import { playwrightIpcFixtures } from '@/tests/playwright-fixtures';

export async function installPlaywrightIpc(
  page: Page,
  overrides: Record<string, unknown> = {},
  readerState?: 'loading' | 'error',
  syncStatus?: { state: 'idle' | 'syncing' | 'error'; lastSynced: string; error?: string },
  rejectedCommands: string[] = [],
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
    ({ fixtures, overrides: supplied, readerState: state, rejectedCommands }) => {
      const responses = { ...fixtures, ...supplied } as Record<string, unknown>;
      window.__LATENTMAIL_PLAYWRIGHT_IPC__ = {
        invoke: async (command) => {
          if (rejectedCommands.includes(command)) throw new Error('Mocked IPC failure');
          if (command in responses) return responses[command];
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
    },
  );
}
