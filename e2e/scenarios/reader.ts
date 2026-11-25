import { expect } from '@playwright/test';
import { installPlaywrightIpc } from '../helpers';
import {
  playwrightClippedConversation,
  playwrightMailAccount,
  playwrightTooLargeConversation,
} from '@/tests/playwright-fixtures';
import { screenshot, toggleTheme } from './shared';
import type { ScreenshotScenario } from './shared';

export const readerScenarios: ScreenshotScenario[] = [
  {
    name: 'reading pane',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
      await toggleTheme(page, theme);
      await page.keyboard.press('j');
      await expect(
        page.getByRole('heading', { name: 'Q3 Marketing Strategy Review' }),
      ).toBeVisible();
      await screenshot(page, page.getByTestId('reading-pane'), 'reader-loaded', theme);
    },
  },
  {
    name: 'clipped message notice',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          load_conversation: playwrightClippedConversation,
        },
      });
      await page.goto('/');
      await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
      await page.keyboard.press('j');
      await screenshot(page, page.getByTestId('clipped-notice'), 'reader-clipped-notice', theme);
    },
  },
  {
    name: 'too-large message notice',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          load_conversation: playwrightTooLargeConversation,
        },
      });
      await page.goto('/');
      await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
      await page.keyboard.press('j');
      await screenshot(
        page,
        page.getByTestId('too-large-notice'),
        'reader-too-large-notice',
        theme,
      );
    },
  },
  {
    name: 'attachment section',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
      await toggleTheme(page, theme);
      await page.keyboard.press('j');
      await expect(
        page.getByRole('heading', { name: 'Q3 Marketing Strategy Review' }),
      ).toBeVisible();
      await screenshot(page, page.getByTestId('attachment-section'), 'attachment-section', theme);
    },
  },
  {
    name: 'attachment preview modal',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
      await toggleTheme(page, theme);
      await page.keyboard.press('j');
      await page.getByRole('button', { name: 'Preview scan-0142.jpg' }).click();
      await expect(page.getByTestId('attachment-preview-modal')).toBeVisible();
      await screenshot(
        page,
        page.getByTestId('attachment-preview-modal'),
        'attachment-preview-modal',
        theme,
      );
    },
  },
  {
    name: 'message source modal',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
      await toggleTheme(page, theme);
      await page.keyboard.press('j');
      await page.getByRole('button', { name: 'More message actions' }).last().click();
      await page.getByRole('menuitem', { name: /Show original/ }).click();
      await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
      await screenshot(
        page,
        page.getByTestId('message-source-modal'),
        'message-source-modal',
        theme,
      );
    },
  },
];
