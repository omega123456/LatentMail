import { expect } from '@playwright/test';
import { parseISO } from 'date-fns';
import { installPlaywrightIpc } from '../helpers';
import {
  playwrightAiConfigs,
  playwrightAiIndexStatuses,
  playwrightAiModels,
  playwrightLogEntries,
  playwrightMailAccount,
  playwrightQueueAccounts,
  playwrightQueueOperationsSnapshot,
  playwrightReauthAccount,
  playwrightSettings,
  playwrightSidebarAccounts,
  playwrightTrustedSenderSettings,
  playwrightUpdateAvailable,
} from '@/tests/playwright-fixtures';
import { screenshot } from './shared';
import type { ScreenshotScenario } from './shared';

export const settingsScenarios: ScreenshotScenario[] = [
  {
    name: 'settings navigation',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await page.getByTestId('sidebar-slot').getByRole('button', { name: 'Settings' }).click();
      await screenshot(page, page.getByTestId('settings-nav'), 'settings-nav', theme);
    },
  },
  {
    name: 'settings AI section',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount, playwrightReauthAccount],
          read_ai_configs: playwrightAiConfigs,
          read_ai_index_status: playwrightAiIndexStatuses,
          list_ai_models: playwrightAiModels,
        },
      });
      await page.goto('/');
      await page.getByTestId('sidebar-slot').getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'AI', exact: true }).click();
      await page.getByRole('button', { name: /Personal/ }).click();
      await page.setViewportSize({ width: 1280, height: 1400 });
      await screenshot(page, page.getByTestId('settings-ai-section'), 'settings-ai-section', theme);
    },
  },
  {
    name: 'settings general section',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: { list_accounts: [playwrightMailAccount] },
        platform: 'windows',
      });
      await page.goto('/');
      await page.getByTestId('sidebar-slot').getByRole('button', { name: 'Settings' }).click();
      await page.setViewportSize({ width: 1280, height: 1600 });
      await screenshot(
        page,
        page.getByTestId('settings-general-section'),
        'settings-general-section',
        theme,
      );
    },
  },
  {
    name: 'settings updates section',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          check_for_update: playwrightUpdateAvailable,
        },
      });
      await page.goto('/');
      await page.getByTestId('sidebar-slot').getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Updates' }).click();
      await screenshot(
        page,
        page.getByTestId('settings-updates-section'),
        'settings-updates-section',
        theme,
      );
    },
  },
  {
    name: 'settings trusted senders',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          read_settings: playwrightTrustedSenderSettings,
        },
      });
      await page.goto('/');
      await page.getByTestId('sidebar-slot').getByRole('button', { name: 'Settings' }).click();
      await expect(page.getByText('1–10 of 12')).toBeVisible();
      await screenshot(
        page,
        page.getByTestId('settings-trusted-senders'),
        'settings-trusted-senders',
        theme,
      );
    },
  },
  {
    name: 'settings accounts section',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: playwrightSidebarAccounts } });
      await page.goto('/');
      await page.getByTestId('sidebar-slot').getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Accounts' }).click();
      await screenshot(
        page,
        page.getByTestId('settings-accounts-section'),
        'settings-accounts-section',
        theme,
      );
    },
  },
  {
    name: 'settings keyboard section',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          read_settings: playwrightSettings,
        },
      });
      await page.goto('/');
      await page.getByTestId('sidebar-slot').getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Keyboard' }).click();
      await page.getByRole('button', { name: 'Change shortcut for Forward' }).click();
      await page.getByRole('textbox', { name: 'Recording new shortcut for Forward' }).press('r');
      await page.setViewportSize({ width: 1280, height: 1500 });
      await screenshot(
        page,
        page.getByTestId('settings-keyboard-section'),
        'settings-keyboard-section',
        theme,
      );
    },
  },
  {
    name: 'settings queue section',
    run: async (page, theme) => {
      await page.clock.setFixedTime(parseISO('2026-08-18T12:00:00Z'));
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: playwrightQueueAccounts,
          read_queue_operations: playwrightQueueOperationsSnapshot,
        },
      });
      await page.goto('/');
      await page.getByTestId('sidebar-slot').getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Queue' }).click();
      await page
        .getByTestId('queue-account-card-mail-account')
        .getByRole('button', { name: 'Expand the Interactive lane' })
        .click();
      await page
        .getByTestId('queue-account-card-reauth-account')
        .getByRole('button', { name: 'Expand the Interactive lane' })
        .click();
      await screenshot(
        page,
        page.getByTestId('settings-queue-section'),
        'settings-queue-section',
        theme,
      );
    },
  },
  {
    name: 'settings logs section',
    run: async (page, theme) => {
      await page.clock.setFixedTime(parseISO('2026-08-19T14:41:30Z'));
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: playwrightSidebarAccounts,
          read_log_entries: playwrightLogEntries,
        },
      });
      await page.goto('/');
      await page.getByTestId('sidebar-slot').getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Logs' }).click();
      await screenshot(
        page,
        page.getByTestId('settings-logs-section'),
        'settings-logs-section',
        theme,
      );
    },
  },
];
