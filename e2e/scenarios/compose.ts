import { expect } from '@playwright/test';
import { installPlaywrightIpc, openComposeSession } from '../helpers';
import {
  playwrightAttachmentsComposeSession,
  playwrightContactSuggestionMatches,
  playwrightMailAccount,
  playwrightManyRecipientsComposeSession,
  playwrightNewComposeSession,
  playwrightReplyComposeSession,
  playwrightStagedImageSvg,
  playwrightStagedImageUrlPattern,
  playwrightSuggestionsComposeSession,
} from '@/tests/playwright-fixtures';
import { screenshot, toggleTheme } from './shared';
import type { ScreenshotScenario } from './shared';

export const composeScenarios: ScreenshotScenario[] = [
  {
    name: 'composer panel',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await openComposeSession(page, playwrightNewComposeSession);
      await screenshot(page, page.getByTestId('compose-overlay'), 'composer-panel', theme);
    },
  },
  {
    name: 'attachment strip and inline preview',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.route(playwrightStagedImageUrlPattern, (route) =>
        route.fulfill({ contentType: 'image/svg+xml', body: playwrightStagedImageSvg }),
      );
      await page.goto('/');
      await openComposeSession(page, playwrightAttachmentsComposeSession);
      await expect(page.getByTestId('attachment-strip')).toBeVisible();
      await screenshot(
        page,
        page.getByTestId('compose-overlay'),
        'attachment-strip-inline-preview',
        theme,
      );
    },
  },
  {
    name: 'recipient field',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await openComposeSession(page, playwrightManyRecipientsComposeSession);
      await expect(page.getByRole('button', { name: /more recipient/ })).toBeVisible();
      await screenshot(page, page.getByTestId('recipient-field'), 'recipient-field', theme);
    },
  },
  {
    name: 'contact suggestions',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          lookup_contacts: playwrightContactSuggestionMatches,
        },
      });
      await page.goto('/');
      await openComposeSession(page, playwrightSuggestionsComposeSession);
      await page.getByRole('combobox', { name: 'To' }).fill('mar');
      await expect(page.getByRole('option', { name: /Marta Oliveira/ })).toBeVisible();
      await page.getByRole('combobox', { name: 'To' }).press('ArrowDown');
      await screenshot(page, page.getByTestId('compose-overlay'), 'contact-suggestions', theme);
    },
  },
  {
    name: 'quote disclosure',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await openComposeSession(page, playwrightReplyComposeSession);
      await toggleTheme(page, theme);
      await page.getByRole('button', { name: 'Show quoted text' }).click();
      await expect(page.getByRole('region', { name: 'Quoted content, read-only' })).toBeVisible();
      await screenshot(
        page,
        page.getByTestId('quote-disclosure'),
        'quote-disclosure-expanded',
        theme,
      );
    },
  },
];
