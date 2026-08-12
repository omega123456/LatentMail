import { expect, test } from '@playwright/test';
import { installPlaywrightIpc } from './helpers';
import {
  playwrightLabels,
  playwrightDeferredBodyConversation,
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

  // Phase 3: the zero-labels state must still render the LABELS header and
  // its create affordance (corrected behaviour — no more early `return
  // null`), distinct from the populated state above.
  test(`sidebar labels empty state ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, {
      list_accounts: playwrightSidebarAccounts,
      list_labels: playwrightLabels.filter((label) => label.kind !== 'user'),
    });
    await page.goto('/');
    await toggleTheme(page, theme);
    await expect(page.getByTestId('sidebar-slot')).toHaveScreenshot(
      `sidebar-labels-empty-${theme}.png`,
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

  // Phase 2: multi-selection row states. The default `conversation list
  // {density} {theme}` baselines above already cover the idle row state
  // (compact/comfortable stay idle; spacious presses "j" so it doubles as
  // an active-state baseline). These two loops fill in the remaining
  // single-active and multi-selected states for every density.
  for (const density of ['compact', 'comfortable', 'spacious'] as const) {
    test(`conversation list active row ${density} ${theme}`, async ({ page }) => {
      await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
      await page.goto('/');
      await toggleTheme(page, theme);
      for (
        let index = 0;
        index < ['comfortable', 'spacious', 'compact'].indexOf(density);
        index += 1
      )
        await page.getByLabel('Cycle conversation density').click();
      await page.keyboard.press('j');
      await expect(page.getByTestId('list-slot')).toHaveScreenshot(
        `conversation-list-active-row-${density}-${theme}.png`,
      );
    });

    test(`conversation list multi-selected rows ${density} ${theme}`, async ({ page }) => {
      await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
      await page.goto('/');
      await toggleTheme(page, theme);
      for (
        let index = 0;
        index < ['comfortable', 'spacious', 'compact'].indexOf(density);
        index += 1
      )
        await page.getByLabel('Cycle conversation density').click();
      await page
        .getByLabel('Open Q3 Marketing Strategy Review')
        .click({ modifiers: ['ControlOrMeta'] });
      await page
        .getByLabel('Open Action Required: 2FA Setup')
        .click({ modifiers: ['ControlOrMeta'] });
      await expect(page.getByTestId('list-slot')).toHaveScreenshot(
        `conversation-list-multi-selected-rows-${density}-${theme}.png`,
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

  test(`reader body centered ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.getByLabel('Cycle mail layout').click();
    await page.keyboard.press('j');
    await expect(page.getByLabel('Message body')).toHaveScreenshot(
      `reader-body-centered-${theme}.png`,
    );
  });

  test(`reader body loading ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(
      page,
      {
        list_accounts: [playwrightMailAccount],
        load_conversation: playwrightDeferredBodyConversation,
      },
      undefined,
      undefined,
      [],
      ['fetch_message_body'],
    );
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.getByLabel('Open Q3 Marketing Strategy Review').click();
    await expect(page.getByText('Loading message…')).toBeVisible();
    await expect(page.getByTestId('reading-pane')).toHaveScreenshot(
      `reader-body-loading-${theme}.png`,
    );
  });

  test(`reader body fetch failure ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(
      page,
      {
        list_accounts: [playwrightMailAccount],
        load_conversation: playwrightDeferredBodyConversation,
      },
      undefined,
      undefined,
      ['fetch_message_body'],
    );
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.getByLabel('Open Q3 Marketing Strategy Review').click();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.getByTestId('reading-pane')).toHaveScreenshot(
      `reader-body-fetch-failure-${theme}.png`,
    );
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

  test(`conversation list still syncing ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, {
      list_accounts: [playwrightMailAccount],
      list_threads: { items: [], nextCursor: null },
      read_traversal_status: {
        accountId: 'mail-account',
        state: 'backfilling',
        kind: 'backfill',
        discoveredCount: 50000,
        persistedCount: 12400,
        lastAdvancedAt: Date.parse('2026-08-12T10:00:00Z'),
        isResumed: false,
      },
    });
    await page.goto('/');
    await toggleTheme(page, theme);
    await expect(page.getByText('Older mail is still arriving')).toBeVisible();
    await expect(page.getByText('12,400 of 50,000 so far')).toBeVisible();
    await expect(page.getByTestId('list-slot')).toHaveScreenshot(
      `conversation-list-still-syncing-${theme}.png`,
    );
  });

  for (const [name, traversal] of [
    [
      'backfill',
      {
        state: 'backfilling',
        kind: 'backfill',
        discoveredCount: 50000,
        persistedCount: 6400,
        lastAdvancedAt: Date.parse('2026-08-12T10:00:00Z'),
        isResumed: false,
      },
    ],
    [
      'backfill-resumed',
      {
        state: 'backfilling',
        kind: 'backfill',
        discoveredCount: 50000,
        persistedCount: 12400,
        lastAdvancedAt: Date.parse('2026-08-12T10:00:00Z'),
        isResumed: true,
      },
    ],
    [
      'reconciliation',
      {
        state: 'reconciling',
        kind: 'reconciliation',
        discoveredCount: 50000,
        persistedCount: 36,
        lastAdvancedAt: Date.parse('2026-08-12T10:00:00Z'),
        isResumed: true,
      },
    ],
  ] as const) {
    test(`status bar traversal ${name} ${theme}`, async ({ page }) => {
      await installPlaywrightIpc(page, {
        list_accounts: [playwrightMailAccount],
        read_traversal_status: { accountId: 'mail-account', ...traversal },
      });
      await page.goto('/');
      await toggleTheme(page, theme);
      await expect(page.getByTestId('status-bar')).toHaveScreenshot(
        `status-bar-traversal-${name}-${theme}.png`,
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

  // Phase 7: action and label-management surfaces.
  test(`row context menu ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.getByLabel('Open Q3 Marketing Strategy Review').click({ button: 'right' });
    await expect(page.getByRole('menu').first()).toHaveScreenshot(`row-context-menu-${theme}.png`);
  });

  test(`row context menu move-to submenu ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.getByLabel('Open Q3 Marketing Strategy Review').click({ button: 'right' });
    await page.getByText('Move to').hover();
    await expect(page.getByTestId('move-to-menu')).toHaveScreenshot(
      `row-context-menu-move-to-${theme}.png`,
    );
  });

  test(`thread action ribbon labels menu ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.keyboard.press('j');
    await page.getByTestId('action-ribbon').getByRole('button', { name: 'Labels' }).click();
    await expect(page.getByTestId('labels-menu')).toHaveScreenshot(
      `thread-ribbon-labels-menu-${theme}.png`,
    );
  });

  test(`thread action ribbon move-to menu ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.keyboard.press('j');
    await page.getByTestId('action-ribbon').getByRole('button', { name: 'Move to' }).click();
    await expect(page.getByTestId('move-to-menu')).toHaveScreenshot(
      `thread-ribbon-move-to-menu-${theme}.png`,
    );
  });


  test(`bulk selection panel ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
    await page.goto('/');
    await toggleTheme(page, theme);
    await page
      .getByLabel('Open Q3 Marketing Strategy Review')
      .click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByTestId('reader-slot')).toHaveScreenshot(
      `bulk-selection-panel-${theme}.png`,
    );
  });

  test(`sidebar label create form ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: playwrightSidebarAccounts });
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.getByRole('button', { name: 'Create label' }).click();
    await expect(page.getByTestId('sidebar-slot')).toHaveScreenshot(
      `sidebar-label-create-form-${theme}.png`,
    );
  });

  test(`sidebar label colour picker ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: playwrightSidebarAccounts });
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.getByRole('button', { name: 'Edit Work' }).click();
    await page.getByRole('button', { name: "Change Work's colour" }).click();
    await expect(page.getByTestId('label-color-picker')).toHaveScreenshot(
      `sidebar-label-color-picker-${theme}.png`,
    );
  });

  test(`sidebar label delete confirm ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { list_accounts: playwrightSidebarAccounts });
    await page.goto('/');
    await toggleTheme(page, theme);
    await page.getByRole('button', { name: 'Delete Work' }).click();
    await expect(page.getByTestId('sidebar-slot')).toHaveScreenshot(
      `sidebar-label-delete-confirm-${theme}.png`,
    );
  });
}
