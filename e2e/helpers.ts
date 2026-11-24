import { getTime, parseISO } from 'date-fns';
import type { Page } from '@playwright/test';
import {
  playwrightFileSources,
  playwrightIpcFixtures,
  playwrightMailChangingCommands,
} from '@/tests/playwright-fixtures';
import type { OpenComposeArgs } from '@/stores/compose';

type ComposeStoreModule = typeof import('@/stores/compose');

const COMPOSE_STORE_MODULE_URL = '/src/stores/compose.ts';

export type PlaywrightSyncStatus = {
  state: 'idle' | 'syncing' | 'error';
  lastSynced: string;
  error?: string;
};

export type PlaywrightIpcOptions = {
  overrides?: Record<string, unknown>;
  syncStatus?: PlaywrightSyncStatus;
  rejectedCommands?: string[];
  pendingCommands?: string[];
  platform?: 'windows' | 'macos';
};

function syncStatusOverride(syncStatus: PlaywrightSyncStatus | undefined) {
  if (!syncStatus) return {};
  return {
    read_sync_status: {
      accountId: '',
      state: syncStatus.state,
      lastSyncedAt: getTime(parseISO(syncStatus.lastSynced)),
      lastError: syncStatus.error ?? null,
    },
  };
}

export async function installPlaywrightIpc(page: Page, options: PlaywrightIpcOptions = {}) {
  await page.addInitScript(
    ({
      fixtures,
      overrides,
      rejectedCommands,
      pendingCommands,
      platform,
      fileSources,
      mailChangingCommands,
    }) => {
      const responses = { ...fixtures, ...overrides } as Record<string, unknown>;
      const calls: { command: string; args: unknown }[] = [];
      const listeners = new Map<string, ((payload: unknown) => void)[]>();
      const emit = (event: string, payload: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      };
      const announceMailChange = (command: string, args: unknown) => {
        if (!mailChangingCommands.includes(command)) return;
        const { accountId } = args as { accountId: string };
        emit('mail://changed', { accountId });
      };
      window.__LATENTMAIL_PLAYWRIGHT_IPC_CALLS__ = calls;
      window.__LATENTMAIL_PLAYWRIGHT_EMIT__ = emit;
      window.__LATENTMAIL_PLAYWRIGHT_IPC__ = {
        invoke: async (command, args) => {
          calls.push({ command, args });
          if (pendingCommands.includes(command)) return new Promise(() => undefined);
          announceMailChange(command, args);
          if (rejectedCommands.includes(command)) throw new Error('Mocked IPC failure');
          if (command in responses) return responses[command];
          throw new Error(`[playwright] Unmocked Tauri IPC command: ${command}`);
        },
        listen: async (event, listener) => {
          const subscription = (payload: unknown) => listener(payload);
          listeners.set(event, [...(listeners.get(event) ?? []), subscription]);
          return () => {
            listeners.set(
              event,
              (listeners.get(event) ?? []).filter((entry) => entry !== subscription),
            );
          };
        },
        convertFileSrc: (path) =>
          fileSources.byPathMarker.find((source) => path.includes(source.marker))?.src ??
          fileSources.placeholder,
      };
      window.__TAURI_OS_PLUGIN_INTERNALS__ = {
        eol: '\n',
        os_type: platform,
        platform,
        family: platform === 'windows' ? 'windows' : 'unix',
        version: '',
        arch: 'x86_64',
        exe_extension: platform === 'windows' ? 'exe' : '',
      };
    },
    {
      fixtures: playwrightIpcFixtures,
      overrides: { ...options.overrides, ...syncStatusOverride(options.syncStatus) },
      rejectedCommands: options.rejectedCommands ?? [],
      pendingCommands: options.pendingCommands ?? [],
      platform: options.platform ?? 'macos',
      fileSources: playwrightFileSources,
      mailChangingCommands: playwrightMailChangingCommands,
    },
  );
}

export async function openComposeSession(page: Page, session: OpenComposeArgs) {
  await page.getByTestId('mail-layout').waitFor();
  await page.evaluate(
    async ({ moduleUrl, args }) => {
      const composeStore: ComposeStoreModule = await import(moduleUrl);
      composeStore.useComposeStore.getState().open(args);
    },
    { moduleUrl: COMPOSE_STORE_MODULE_URL, args: session },
  );
}
