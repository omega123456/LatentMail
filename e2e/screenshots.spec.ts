import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { formatISO, getTime, parseISO } from 'date-fns';
import { installPlaywrightIpc } from './helpers';
import {
  playwrightMailAccount,
  playwrightReauthAccount,
  playwrightSidebarAccounts,
} from '@/tests/playwright-fixtures';

const themes = ['light', 'dark'] as const;

const toggleTheme = (page: Page, theme: (typeof themes)[number]) =>
  page
    .locator('html')
    .evaluate((element, value) => element.classList.toggle('dark', value === 'dark'), theme);

async function screenshot(
  page: Page,
  locator: Locator,
  name: string,
  theme: (typeof themes)[number],
) {
  await toggleTheme(page, theme);
  await expect(locator).toHaveScreenshot(`${name}-${theme}.png`);
}

for (const theme of themes) {
  test(`sign-in screen ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page);
    await page.goto('/');
    await screenshot(page, page.getByTestId('sign-in-screen'), 'sign-in', theme);
  });

  test(`reauth banner ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightReauthAccount] });
    await page.goto('/');
    await screenshot(page, page.getByTestId('reauth-banner'), 'reauth-banner', theme);
  });

  test(`sidebar ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: playwrightSidebarAccounts });
    await page.goto('/');
    await screenshot(page, page.getByTestId('sidebar-slot'), 'sidebar-expanded', theme);
  });

  test(`collapsed rail ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: playwrightSidebarAccounts });
    await page.goto('/');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await screenshot(page, page.getByTestId('collapsed-rail'), 'sidebar-collapsed', theme);
  });

  test(`label form ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: playwrightSidebarAccounts });
    await page.goto('/');
    await page.getByRole('button', { name: 'Create label' }).click();
    await screenshot(page, page.getByTestId('sidebar-slot'), 'sidebar-label-create-form', theme);
  });

  test(`label colour picker ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: playwrightSidebarAccounts });
    await page.goto('/');
    await page.getByRole('button', { name: 'Edit Work' }).click();
    await page.getByRole('button', { name: "Change Work's colour" }).click();
    await screenshot(
      page,
      page.getByTestId('label-color-picker'),
      'sidebar-label-color-picker',
      theme,
    );
  });

  test(`label delete confirmation ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: playwrightSidebarAccounts });
    await page.goto('/');
    await page.getByRole('button', { name: 'Delete Work' }).click();
    await screenshot(page, page.getByTestId('sidebar-slot'), 'sidebar-label-delete-confirm', theme);
  });

  test(`mutation error toast ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(
      page,
      { list_accounts: [playwrightMailAccount] },
      undefined,
      undefined,
      ['mutate_threads'],
    );
    await page.goto('/');
    await page.getByLabel('Unstar Q3 Marketing Strategy Review', { exact: true }).click();
    await screenshot(page, page.getByRole('alert'), 'mutation-error-toast', theme);
  });

  test(`conversation list ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await screenshot(page, page.getByTestId('list-slot'), 'conversation-list-comfortable', theme);
  });

  test(`still-syncing empty state ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, {
      list_accounts: [playwrightMailAccount],
      list_threads: { items: [], nextCursor: null },
      read_traversal_status: {
        accountId: 'mail-account',
        state: 'backfilling',
        kind: 'backfill',
        discoveredCount: 50000,
        persistedCount: 12400,
        lastAdvancedAt: getTime(parseISO('2026-08-12T10:00:00Z')),
        isResumed: false,
      },
    });
    await page.goto('/');
    await screenshot(page, page.getByTestId('list-slot'), 'conversation-list-still-syncing', theme);
  });

  test(`reading pane ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
    await toggleTheme(page, theme);
    await page.keyboard.press('j');
    await expect(page.getByRole('heading', { name: 'Q3 Marketing Strategy Review' })).toBeVisible();
    await screenshot(page, page.getByTestId('reading-pane'), 'reader-loaded', theme);
  });

  test(`status bar ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(
      page,
      {
        list_accounts: [playwrightMailAccount],
        read_queue_summary: { pending: 2, active: 0, failed: 0, done: 0, paused: false },
      },
      undefined,
      { state: 'idle', lastSynced: formatISO(Date.now()) },
    );
    await page.goto('/');
    await screenshot(page, page.getByTestId('status-bar'), 'status-bar-idle', theme);
  });

  test(`row context menu ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await page.getByLabel('Open Q3 Marketing Strategy Review').click({ button: 'right' });
    await screenshot(page, page.getByRole('menu').first(), 'row-context-menu', theme);
  });

  test(`move-to menu ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await page.getByLabel('Open Q3 Marketing Strategy Review').click({ button: 'right' });
    await page.getByText('Move to').hover();
    await screenshot(page, page.getByTestId('move-to-menu'), 'row-context-menu-move-to', theme);
  });

  test(`labels menu ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await page.getByLabel('Open Q3 Marketing Strategy Review').click();
    await page.getByTestId('action-ribbon').getByRole('button', { name: 'Labels' }).click();
    await screenshot(page, page.getByTestId('labels-menu'), 'thread-ribbon-labels-menu', theme);
  });

  test(`bulk selection panel ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await page
      .getByLabel('Open Q3 Marketing Strategy Review')
      .click({ modifiers: ['ControlOrMeta'] });
    await screenshot(page, page.getByTestId('reader-slot'), 'bulk-selection-panel', theme);
  });

  test(`full shell ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] }, undefined, {
      state: 'idle',
      lastSynced: formatISO(Date.now()),
    });
    await page.goto('/');
    await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
    await toggleTheme(page, theme);
    await page.keyboard.press('j');
    await expect(page.getByRole('heading', { name: 'Q3 Marketing Strategy Review' })).toBeVisible();
    await screenshot(page, page.getByTestId('mail-layout'), 'full-shell-three-column', theme);
  });
}
