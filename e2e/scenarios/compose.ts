import { expect, type Page } from '@playwright/test';
import { installPlaywrightIpc, openComposeSession, shrinkComposeToMinimumSize } from '../helpers';
import {
  playwrightAttachmentsComposeSession,
  playwrightContactSuggestionMatches,
  playwrightLongReplyComposeSession,
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

async function expectBodyEndsAboveQuoteDisclosure(page: Page) {
  const bodyBottom = await page
    .locator('.ProseMirror')
    .evaluate((body) => body.getBoundingClientRect().bottom);
  const disclosureTop = await page
    .getByTestId('quote-disclosure')
    .evaluate((disclosure) => disclosure.getBoundingClientRect().top);
  expect(bodyBottom).toBeLessThanOrEqual(disclosureTop);
}

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
      await page.getByRole('button', { name: 'Hide quoted text' }).click();
      await shrinkComposeToMinimumSize(page);
      await expect(page.getByRole('button', { name: 'Show quoted text' })).toBeInViewport({
        ratio: 1,
      });
      await expect(page.getByRole('button', { name: 'Send' })).toBeInViewport({ ratio: 1 });
    },
  },
  {
    name: 'link bar',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await openComposeSession(page, playwrightLongReplyComposeSession);
      await expect(page.getByRole('link', { name: 'final deck' })).toBeVisible();
      await expectBodyEndsAboveQuoteDisclosure(page);
      await page.getByRole('button', { name: 'Link', exact: true }).click();
      await page.getByLabel('Link URL').fill('example.com/agenda');
      await screenshot(page, page.getByTestId('compose-overlay'), 'link-bar', theme);
    },
  },
];
