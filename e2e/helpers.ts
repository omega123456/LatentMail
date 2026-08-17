import type { Page } from '@playwright/test';
import { playwrightIpcFixtures } from '@/tests/playwright-fixtures';
import type { OpenComposeArgs } from '@/stores/compose';

export async function installPlaywrightIpc(
  page: Page,
  overrides: Record<string, unknown> = {},
  readerState?: 'loading' | 'error',
  syncStatus?: { state: 'idle' | 'syncing' | 'error'; lastSynced: string; error?: string },
  rejectedCommands: string[] = [],
  pendingCommands: string[] = [],
  composeSession?: OpenComposeArgs,
) {

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
      composeSession: session,
    }) => {
      const responses = { ...fixtures, ...supplied } as Record<string, unknown>;
      window.__LATENTMAIL_PLAYWRIGHT_IPC__ = {
        invoke: async (command) => {
          if (rejectedCommands.includes(command)) throw new Error('Mocked IPC failure');
          if (pendingCommands.includes(command)) return new Promise(() => undefined);
          if (command in responses) return responses[command];

          if (voidCommands.includes(command)) return undefined;
          throw new Error(`[playwright] Unmocked Tauri IPC command: ${command}`);
        },
        listen: async () => () => undefined,
      };
      window.__LATENTMAIL_PLAYWRIGHT_READER_STATE__ = state;
      window.__LATENTMAIL_PLAYWRIGHT_COMPOSE_SESSION__ = session;
    },
    {
      fixtures: playwrightIpcFixtures,
      overrides: { ...overrides, ...syncOverride },
      readerState,
      rejectedCommands,
      pendingCommands,
      voidCommands: Object.keys(playwrightIpcFixtures),
      composeSession,
    },
  );
}
