import { expect } from '@playwright/test';
import { formatISO, parseISO } from 'date-fns';
import { installPlaywrightIpc } from '../helpers';
import {
  playwrightAiChatQuestion,
  playwrightAiChatReadyConfigs,
  playwrightAiChatReadyIndexStatuses,
  playwrightAiChatRequestId,
  playwrightAiChatStream,
  playwrightMailAccount,
  playwrightNoAiIndexStatuses,
  playwrightPendingQueueSummary,
  playwrightReauthAccount,
  playwrightSidebarAccounts,
  playwrightUpdateAvailable,
} from '@/tests/playwright-fixtures';
import { screenshot, toggleTheme } from './shared';
import type { ScreenshotScenario } from './shared';

export const shellScenarios: ScreenshotScenario[] = [
  {
    name: 'sign-in screen',
    run: async (page, theme) => {
      await installPlaywrightIpc(page);
      await page.goto('/');
      await screenshot(page, page.getByTestId('sign-in-screen'), 'sign-in', theme);
    },
  },
  {
    name: 'reauth banner',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightReauthAccount] } });
      await page.goto('/');
      await screenshot(page, page.getByTestId('reauth-banner'), 'reauth-banner', theme);
    },
  },
  {
    name: 'update banner',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          check_for_update: playwrightUpdateAvailable,
        },
      });
      await page.goto('/');
      await screenshot(page, page.getByTestId('update-banner'), 'update-banner', theme);
    },
  },
  {
    name: 'sidebar',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: playwrightSidebarAccounts } });
      await page.goto('/');
      await screenshot(page, page.getByTestId('sidebar-slot'), 'sidebar-expanded', theme);
    },
  },
  {
    name: 'collapsed rail',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: playwrightSidebarAccounts } });
      await page.goto('/');
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await screenshot(page, page.getByTestId('collapsed-rail'), 'sidebar-collapsed', theme);
    },
  },
  {
    name: 'label form',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: playwrightSidebarAccounts } });
      await page.goto('/');
      await page.getByRole('button', { name: 'Create label' }).click();
      await screenshot(page, page.getByTestId('sidebar-slot'), 'sidebar-label-create-form', theme);
    },
  },
  {
    name: 'label colour picker',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: playwrightSidebarAccounts } });
      await page.goto('/');
      await page.getByRole('button', { name: 'Edit Work' }).click();
      await page.getByRole('button', { name: "Change Work's colour" }).click();
      await screenshot(
        page,
        page.getByTestId('label-color-picker'),
        'sidebar-label-color-picker',
        theme,
      );
    },
  },
  {
    name: 'mutation error toast',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: { list_accounts: [playwrightMailAccount] },
        rejectedCommands: ['mutate_threads'],
      });
      await page.goto('/');
      await page.getByLabel('Unstar Q3 Marketing Strategy Review', { exact: true }).click();
      await screenshot(page, page.getByTestId('toast'), 'mutation-error-toast', theme);
    },
  },
  {
    name: 'conversation list',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await screenshot(page, page.getByTestId('list-slot'), 'conversation-list-comfortable', theme);
    },
  },
  {
    name: 'status bar',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          read_ai_index_status: playwrightNoAiIndexStatuses,
          read_queue_summary: playwrightPendingQueueSummary,
        },
        syncStatus: { state: 'idle', lastSynced: formatISO(Date.now()) },
      });
      await page.goto('/');
      await screenshot(page, page.getByTestId('status-bar'), 'status-bar-idle', theme);
    },
  },
  {
    name: 'row context menu',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await page.getByLabel('Open Q3 Marketing Strategy Review').click({ button: 'right' });
      await screenshot(page, page.getByRole('menu').first(), 'row-context-menu', theme);
    },
  },
  {
    name: 'move-to menu',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await page.getByLabel('Open Q3 Marketing Strategy Review').click({ button: 'right' });
      await page.getByText('Move to').hover();
      await screenshot(page, page.getByTestId('move-to-menu'), 'row-context-menu-move-to', theme);
    },
  },
  {
    name: 'labels menu',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await page.getByLabel('Open Q3 Marketing Strategy Review').click();
      await page.getByTestId('action-ribbon').getByRole('button', { name: 'Labels' }).click();
      await screenshot(page, page.getByTestId('labels-menu'), 'thread-ribbon-labels-menu', theme);
    },
  },
  {
    name: 'bulk selection panel',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await page
        .getByLabel('Open Q3 Marketing Strategy Review')
        .click({ modifiers: ['ControlOrMeta'] });
      await page.getByLabel('Open Updates to Color Tokens').click({ modifiers: ['ControlOrMeta'] });
      await expect(page.getByText('2 conversations selected')).toBeVisible();
      await screenshot(page, page.getByTestId('reader-slot'), 'bulk-selection-panel', theme);
    },
  },
  {
    name: 'full shell',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: { list_accounts: [playwrightMailAccount] },
        syncStatus: { state: 'idle', lastSynced: formatISO(Date.now()) },
      });
      await page.goto('/');
      await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
      await toggleTheme(page, theme);
      await page.keyboard.press('j');
      await expect(
        page.getByRole('heading', { name: 'Q3 Marketing Strategy Review' }),
      ).toBeVisible();
      await screenshot(page, page.getByTestId('mail-layout'), 'full-shell-three-column', theme);
    },
  },
  {
    name: 'ai assistant panel',
    run: async (page, theme) => {
      await page.clock.setFixedTime(parseISO('2026-08-17T12:00:00'));
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          read_ai_configs: playwrightAiChatReadyConfigs,
          read_ai_index_status: playwrightAiChatReadyIndexStatuses,
        },
      });
      await page.goto('/');
      await page.getByRole('button', { name: 'AI assistant' }).click();
      await page.getByLabel('Ask a question').fill(playwrightAiChatQuestion);
      await page.getByRole('button', { name: 'Send question' }).click();
      const identity = await page.evaluate(() => {
        const call = (window.__LATENTMAIL_PLAYWRIGHT_IPC_CALLS__ ?? []).find(
          (entry) => entry.command === 'start_ai_chat',
        );
        return call?.request as { accountId: string; sessionId: string };
      });
      await page.evaluate(
        (events) =>
          events.forEach((event) =>
            window.__LATENTMAIL_PLAYWRIGHT_EMIT__?.('ai-chat://event', event),
          ),
        playwrightAiChatStream({
          requestId: playwrightAiChatRequestId,
          sessionId: identity.sessionId,
          accountId: identity.accountId,
        }),
      );
      await expect(page.getByRole('button', { name: /Harbor Insurance/ })).toBeVisible();
      await screenshot(
        page,
        page.getByRole('region', { name: 'AI assistant' }),
        'ai-assistant-panel',
        theme,
      );
    },
  },
];
