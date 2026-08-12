import { expect, test } from '@playwright/test';
import { installPlaywrightIpc } from './helpers';
import {
  playwrightMailAccount,
  playwrightReauthAccount,
  playwrightSidebarAccounts,
} from '@/tests/playwright-fixtures';

const toggleTheme = (page: import('@playwright/test').Page, theme: 'light' | 'dark') =>
  page
    .locator('html')
    .evaluate((element, value) => element.classList.toggle('dark', value === 'dark'), theme);

for (const theme of ['light', 'dark'] as const) {
  test(`sign-in ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page);
    await page.goto('/');
    await toggleTheme(page, theme);
    await expect(page.getByTestId('sign-in-screen')).toHaveScreenshot(`sign-in-${theme}.png`);
  });

  test(`reauth banner ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightReauthAccount] });
    await page.goto('/');
    await toggleTheme(page, theme);
    await expect(page.getByTestId('reauth-banner')).toHaveScreenshot(`reauth-banner-${theme}.png`);
  });

  test(`sidebar expanded ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: playwrightSidebarAccounts });
    await page.goto('/');
    await toggleTheme(page, theme);
    await expect(page.getByTestId('sidebar-slot')).toHaveScreenshot(
      `sidebar-expanded-${theme}.png`,
    );
  });

  test(`sidebar collapsed ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: playwrightSidebarAccounts });
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByTestId('collapsed-rail')).toHaveScreenshot(
      `sidebar-collapsed-${theme}.png`,
    );
  });

  test(`mail shell ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] }, undefined, {
      state: 'idle',
      lastSynced: new Date().toISOString(),
    });
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.keyboard.press('j');
    await expect(page.getByTestId('mail-layout')).toHaveScreenshot(`mail-shell-${theme}.png`);
  });

  test(`mutation error toast ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(
      page,
      { list_accounts: [playwrightMailAccount] },
      undefined,
      undefined,
      // The fixture thread is already starred, so the row's control toggles
      // *un*star — rejecting only `star_thread` left the click succeeding and
      // the assertion passing off an unrelated toast.
      ['star_thread', 'unstar_thread'],
    );
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.getByLabel('Unstar Q3 Marketing Strategy Review', { exact: true }).click();
    await expect(page.getByRole('alert')).toHaveScreenshot(`mutation-error-toast-${theme}.png`);
    await page.getByLabel('Dismiss error').click();
  });

  for (const density of ['compact', 'comfortable', 'spacious'] as const) {
    test(`conversation list ${density} ${theme}`, async ({ page }) => {
      await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
      await page.goto('/');
      await toggleTheme(page, theme);
      for (
        let index = 0;
        index < ['comfortable', 'spacious', 'compact'].indexOf(density);
        index += 1
      )
        await page.getByLabel('Cycle conversation density').click();
      if (density === 'spacious') await page.keyboard.press('j');
      await expect(page.getByTestId('list-slot')).toHaveScreenshot(
        `conversation-list-${density}-${theme}.png`,
      );
    });
  }

  test(`reader no selection ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await toggleTheme(page, theme);
    await expect(page.getByTestId('reader-slot')).toHaveScreenshot(
      `reader-no-selection-${theme}.png`,
    );
  });

  for (const state of ['idle', 'syncing', 'paused', 'error'] as const) {
    test(`status bar ${state} ${theme}`, async ({ page }) => {
      const lastSynced = new Date().toISOString();
      const queue =
        state === 'paused'
          ? { pending: 3, active: 0, failed: 0, done: 0, paused: true }
          : { pending: 2, active: state === 'syncing' ? 1 : 0, failed: 0, done: 0, paused: false };
      const syncStatus =
        state === 'paused'
          ? { state: 'idle' as const, lastSynced }
          : state === 'error'
            ? { state: 'error' as const, lastSynced, error: 'Gmail is unavailable' }
            : { state: state as 'idle' | 'syncing', lastSynced };
      await installPlaywrightIpc(
        page,
        { list_accounts: [playwrightMailAccount], read_queue_summary: queue },
        undefined,
        syncStatus,
      );
      await page.goto('/');
      await toggleTheme(page, theme);
      await expect(page.getByTestId('status-bar')).toHaveScreenshot(
        `status-bar-${state}-${theme}.png`,
      );
    });
  }

  test(`reader loaded ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.keyboard.press('j');
    await expect(page.getByTestId('reading-pane')).toHaveScreenshot(`reader-loaded-${theme}.png`);
  });

  for (const readerState of ['loading', 'error'] as const) {
    test(`reader ${readerState} ${theme}`, async ({ page }) => {
      await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] }, readerState);
      await page.goto('/');
      await toggleTheme(page, theme);
      await page.keyboard.press('j');
      await expect(page.getByTestId('reader-slot')).toHaveScreenshot(
        `reader-${readerState}-${theme}.png`,
      );
    });
  }

  for (const state of ['loading', 'empty', 'error'] as const) {
    test(`conversation list ${state} ${theme}`, async ({ page }) => {
      await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
      await page.goto(`/?listState=${state}`);
      await toggleTheme(page, theme);
      await expect(page.getByTestId('list-slot')).toHaveScreenshot(
        `conversation-list-${state}-${theme}.png`,
      );
    });
  }

  // Phase 18: the converged full-shell baselines — every region (sidebar,
  // list, reader, status bar) filled with real (mocked-IPC) data, across all
  // three layout modes. Earlier phases deliberately kept baselines
  // region-scoped; this is the first point the plan produces full-shell
  // screenshots.
  for (const layout of ['three-column', 'bottom-preview', 'list-only'] as const) {
    test(`full shell ${layout} ${theme}`, async ({ page }) => {
      await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] }, undefined, {
        state: 'idle',
        lastSynced: new Date().toISOString(),
      });
      await page.goto('/');
      await toggleTheme(page, theme);
      const layoutOrder = ['three-column', 'bottom-preview', 'list-only'];
      for (let index = 0; index < layoutOrder.indexOf(layout); index += 1)
        await page.getByLabel('Cycle mail layout').click();
      await page.keyboard.press('j');
      await expect(page.getByTestId('mail-layout')).toHaveScreenshot(
        `full-shell-${layout}-${theme}.png`,
      );
    });
  }
}
