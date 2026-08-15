import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { formatISO, getTime, parseISO } from 'date-fns';
import { installPlaywrightIpc } from './helpers';
import {
  playwrightContactSuggestionMatches,
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
    await screenshot(page, page.getByTestId('toast'), 'mutation-error-toast', theme);
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

  // These scenarios open the composer directly through the Playwright-only
  // test bridge `installPlaywrightIpc` seeds
  // (`window.__LATENTMAIL_PLAYWRIGHT_COMPOSE_SESSION__`, read once by
  // `MailLayout`) instead of driving the real Compose pill, keyboard
  // command, or reply/forward ribbons — the same idiom already used for
  // reader state.
  test(`composer panel ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(
      page,
      { list_accounts: [playwrightMailAccount] },
      undefined,
      undefined,
      [],
      [],
      {
        id: 'compose-session-1',
        mode: 'new',
        accountId: 'mail-account',
        from: 'you@example.com',
        recipients: { to: [], cc: [], bcc: [] },
        subject: '',
        html: '',
      },
    );
    await page.goto('/');
    await screenshot(page, page.getByTestId('compose-overlay'), 'composer-panel', theme);
  });

  test(`composer lifecycle ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(
      page,
      { list_accounts: [playwrightMailAccount] },
      undefined,
      undefined,
      ['send_compose_draft'],
      [],
      {
        id: 'compose-session-lifecycle',
        mode: 'new',
        accountId: 'mail-account',
        from: 'you@example.com',
        recipients: { to: ['elena.r@example.com'], cc: [], bcc: [] },
        subject: 'Draft to discard',
        html: '',
      },
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await screenshot(page, page.getByTestId('compose-overlay'), 'composer-lifecycle', theme);
  });

  test(`attachment strip and inline preview ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(
      page,
      { list_accounts: [playwrightMailAccount] },
      undefined,
      undefined,
      [],
      [],
      {
        id: 'compose-session-attachments',
        mode: 'new',
        accountId: 'mail-account',
        from: 'you@example.com',
        recipients: { to: ['elena.r@example.com'], cc: [], bcc: [] },
        subject: 'Q3 budget',
        html: '<p>See the chart:</p><img src="http://asset.localhost/compose-staging/chart.png" alt="Budget chart">',
        attachments: [
          {
            localId: 'budget-pdf',
            filename: 'Q3-budget.pdf',
            mimeType: 'application/pdf',
            size: 253952,
            state: 'settled',
            staged: {
              id: 'staged-budget-pdf',
              path: '/compose-staging/Q3-budget.pdf',
              assetUrl: 'http://asset.localhost/compose-staging/Q3-budget.pdf',
              size: 253952,
            },
            contentId: null,
            error: null,
          },
          {
            localId: 'chart-image',
            filename: 'chart.png',
            mimeType: 'image/png',
            size: 1024,
            state: 'settled',
            staged: {
              id: 'staged-chart-image',
              path: '/compose-staging/chart.png',
              assetUrl: 'http://asset.localhost/compose-staging/chart.png',
              size: 1024,
            },
            contentId: 'cid:chart@latentmail',
            error: null,
          },
        ],
      },
    );
    await page.route('http://asset.localhost/**', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="72"><rect width="120" height="72" fill="#dce8ff"/><path d="M12 54 40 34l20 12 42-30" fill="none" stroke="#1459c7" stroke-width="5"/></svg>',
      }),
    );
    await page.goto('/');
    await expect(page.getByTestId('attachment-strip')).toBeVisible();
    await screenshot(
      page,
      page.getByTestId('compose-overlay'),
      'attachment-strip-inline-preview',
      theme,
    );
  });

  test(`recipient field ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(
      page,
      { list_accounts: [playwrightMailAccount] },
      undefined,
      undefined,
      [],
      [],
      {
        id: 'compose-session-2',
        mode: 'new',
        accountId: 'mail-account',
        from: 'you@example.com',
        recipients: {
          // Long enough, and enough of them, to reliably wrap past the
          // three-row boundary at the panel's default width and exercise
          // the real "+N more" overflow control in a real browser layout.
          to: [
            'Priya Raman <priya.raman@example.com>',
            'Tomás Field <tomas.field@example.com>',
            'ops@example.com',
            'marketing@example.com',
            'engineering@example.com',
            'design@example.com',
            'finance.team@example.com',
            'customer.success@example.com',
            'product@example.com',
            'legal@example.com',
          ],
          cc: ['Dana Whitfield <dana.whitfield@example.com>'],
          bcc: [],
        },
        subject: '',
        html: '',
      },
    );
    await page.goto('/');
    await expect(page.getByRole('button', { name: /more recipient/ })).toBeVisible();
    await screenshot(page, page.getByTestId('recipient-field'), 'recipient-field', theme);
  });

  test(`contact suggestions ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(
      page,
      {
        list_accounts: [playwrightMailAccount],
        lookup_contacts: playwrightContactSuggestionMatches,
      },
      undefined,
      undefined,
      [],
      [],
      {
        id: 'compose-session-suggestions',
        mode: 'new',
        accountId: 'mail-account',
        from: 'you@example.com',
        recipients: { to: ['Priya Raman <priya.raman@example.com>'], cc: [], bcc: [] },
        subject: '',
        html: '',
      },
    );
    await page.goto('/');
    await page.getByRole('combobox', { name: 'To' }).fill('mar');
    await expect(page.getByRole('option', { name: /Marta Oliveira/ })).toBeVisible();
    await page.getByRole('combobox', { name: 'To' }).press('ArrowDown');
    await screenshot(page, page.getByTestId('compose-overlay'), 'contact-suggestions', theme);
  });

  test(`quote disclosure ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(
      page,
      { list_accounts: [playwrightMailAccount] },
      undefined,
      undefined,
      [],
      [],
      {
        id: 'compose-session-3',
        mode: 'reply',
        accountId: 'mail-account',
        from: 'you@example.com',
        recipients: { to: ['elena.r@example.com'], cc: [], bcc: [] },
        subject: 'Re: Q3 Marketing Strategy Review',
        html: '',
        quote: {
          html: "<p>Hi Team, I hope you're all having a great week. I've attached the finalized slide deck for tomorrow's presentation.</p>",
          attribution: 'On 14 Mar 2024 at 10:42, Elena Rodriguez wrote:',
        },
      },
    );
    await page.goto('/');
    const disclosure = page.getByTestId('quote-disclosure');
    await screenshot(page, disclosure, 'quote-disclosure-collapsed', theme);
    await page.getByRole('button', { name: 'Show quoted text' }).click();
    await expect(page.getByRole('region', { name: 'Quoted content, read-only' })).toBeVisible();
    await screenshot(page, disclosure, 'quote-disclosure-expanded', theme);
  });
}
