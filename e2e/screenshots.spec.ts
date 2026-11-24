import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { formatISO, parseISO } from 'date-fns';
import { installPlaywrightIpc, openComposeSession } from './helpers';
import {
  playwrightAttachmentsComposeSession,
  playwrightBackfillingTraversalStatus,
  playwrightEmptySearchPage,
  playwrightManyRecipientsComposeSession,
  playwrightNewComposeSession,
  playwrightNoAiIndexStatuses,
  playwrightPendingQueueSummary,
  playwrightQueueAccounts,
  playwrightReplyComposeSession,
  playwrightStagedImageSvg,
  playwrightStagedImageUrlPattern,
  playwrightSuggestionsComposeSession,
  playwrightZeroSearchTotal,
  playwrightClippedConversation,
  playwrightContactSuggestionMatches,
  playwrightLogEntries,
  playwrightMailAccount,
  playwrightParsedSearchQuery,
  playwrightQueueOperationsSnapshot,
  playwrightReauthAccount,
  playwrightSearchThreadPage,
  playwrightSearchTotal,
  playwrightSettings,
  playwrightSidebarAccounts,
  playwrightTooLargeConversation,
  playwrightTrustedSenderSettings,
  playwrightUpdateAvailable,
  playwrightAiConfigs,
  playwrightAiIndexStatuses,
  playwrightAiModels,
  playwrightAiChatQuestion,
  playwrightAiChatReadyConfigs,
  playwrightAiChatReadyIndexStatuses,
  playwrightAiChatRequestId,
  playwrightAiChatStream,
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
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightReauthAccount] } });
    await page.goto('/');
    await screenshot(page, page.getByTestId('reauth-banner'), 'reauth-banner', theme);
  });

  test(`update banner ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, {
      overrides: {
        list_accounts: [playwrightMailAccount],
        check_for_update: playwrightUpdateAvailable,
      },
    });
    await page.goto('/');
    await screenshot(page, page.getByTestId('update-banner'), 'update-banner', theme);
  });

  test(`sidebar ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: playwrightSidebarAccounts } });
    await page.goto('/');
    await screenshot(page, page.getByTestId('sidebar-slot'), 'sidebar-expanded', theme);
  });

  test(`collapsed rail ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: playwrightSidebarAccounts } });
    await page.goto('/');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await screenshot(page, page.getByTestId('collapsed-rail'), 'sidebar-collapsed', theme);
  });

  test(`label form ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: playwrightSidebarAccounts } });
    await page.goto('/');
    await page.getByRole('button', { name: 'Create label' }).click();
    await screenshot(page, page.getByTestId('sidebar-slot'), 'sidebar-label-create-form', theme);
  });

  test(`label colour picker ${theme}`, async ({ page }) => {
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
  });

  test(`mutation error toast ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, {
      overrides: { list_accounts: [playwrightMailAccount] },
      rejectedCommands: ['mutate_threads'],
    });
    await page.goto('/');
    await page.getByLabel('Unstar Q3 Marketing Strategy Review', { exact: true }).click();
    await screenshot(page, page.getByTestId('toast'), 'mutation-error-toast', theme);
  });

  test(`conversation list ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await screenshot(page, page.getByTestId('list-slot'), 'conversation-list-comfortable', theme);
  });

  test(`reading pane ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
    await toggleTheme(page, theme);
    await page.keyboard.press('j');
    await expect(page.getByRole('heading', { name: 'Q3 Marketing Strategy Review' })).toBeVisible();
    await screenshot(page, page.getByTestId('reading-pane'), 'reader-loaded', theme);
  });

  test(`clipped message notice ${theme}`, async ({ page }) => {
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
  });

  test(`too-large message notice ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, {
      overrides: {
        list_accounts: [playwrightMailAccount],
        load_conversation: playwrightTooLargeConversation,
      },
    });
    await page.goto('/');
    await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
    await page.keyboard.press('j');
    await screenshot(page, page.getByTestId('too-large-notice'), 'reader-too-large-notice', theme);
  });

  test(`attachment section ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
    await toggleTheme(page, theme);
    await page.keyboard.press('j');
    await expect(page.getByRole('heading', { name: 'Q3 Marketing Strategy Review' })).toBeVisible();
    await screenshot(page, page.getByTestId('attachment-section'), 'attachment-section', theme);
  });

  test(`attachment preview modal ${theme}`, async ({ page }) => {
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
  });

  test(`message source modal ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
    await toggleTheme(page, theme);
    await page.keyboard.press('j');
    await page.getByRole('button', { name: 'More message actions' }).last().click();
    await page.getByRole('menuitem', { name: /Show original/ }).click();
    await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
    await screenshot(page, page.getByTestId('message-source-modal'), 'message-source-modal', theme);
  });

  test(`status bar ${theme}`, async ({ page }) => {
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
  });

  test(`row context menu ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await page.getByLabel('Open Q3 Marketing Strategy Review').click({ button: 'right' });
    await screenshot(page, page.getByRole('menu').first(), 'row-context-menu', theme);
  });

  test(`move-to menu ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await page.getByLabel('Open Q3 Marketing Strategy Review').click({ button: 'right' });
    await page.getByText('Move to').hover();
    await screenshot(page, page.getByTestId('move-to-menu'), 'row-context-menu-move-to', theme);
  });

  test(`labels menu ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await page.getByLabel('Open Q3 Marketing Strategy Review').click();
    await page.getByTestId('action-ribbon').getByRole('button', { name: 'Labels' }).click();
    await screenshot(page, page.getByTestId('labels-menu'), 'thread-ribbon-labels-menu', theme);
  });

  test(`bulk selection panel ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await page
      .getByLabel('Open Q3 Marketing Strategy Review')
      .click({ modifiers: ['ControlOrMeta'] });
    await page.getByLabel('Open Updates to Color Tokens').click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByText('2 conversations selected')).toBeVisible();
    await screenshot(page, page.getByTestId('reader-slot'), 'bulk-selection-panel', theme);
  });

  test(`full shell ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, {
      overrides: { list_accounts: [playwrightMailAccount] },
      syncStatus: { state: 'idle', lastSynced: formatISO(Date.now()) },
    });
    await page.goto('/');
    await expect(page.getByLabel('Open Q3 Marketing Strategy Review')).toBeVisible();
    await toggleTheme(page, theme);
    await page.keyboard.press('j');
    await expect(page.getByRole('heading', { name: 'Q3 Marketing Strategy Review' })).toBeVisible();
    await screenshot(page, page.getByTestId('mail-layout'), 'full-shell-three-column', theme);
  });

  test(`ai assistant panel ${theme}`, async ({ page }) => {
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
  });

  test(`search field focused ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await page.getByLabel('Search mail').click();
    await page.getByLabel('Search mail').fill('from:anna');
    await screenshot(page, page.getByRole('search'), 'search-field-focused', theme);
  });

  test(`search keyword suggestions ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await page.getByLabel('Search mail').click();
    await page.getByLabel('Search mail').fill('is:');
    await screenshot(
      page,
      page.getByRole('listbox', { name: 'Search suggestions' }),
      'search-keyword-suggestions',
      theme,
    );
  });

  test(`advanced search panel ${theme}`, async ({ page }) => {
    await page.clock.setFixedTime(parseISO('2026-08-17T12:00:00'));
    await installPlaywrightIpc(page, {
      overrides: {
        list_accounts: [playwrightMailAccount],
        parse_search_query: playwrightParsedSearchQuery,
      },
    });
    await page.goto('/');
    await page.getByLabel('Search mail').fill('from:anna quarterly');
    await page.getByRole('button', { name: 'Show search options' }).click();
    await expect(page.getByLabel('From')).toHaveValue('anna');
    await page.getByRole('button', { name: 'Custom…' }).click();
    await page.getByRole('button', { name: 'Between' }).click();
    await page.getByRole('button', { name: '4 August 2026', exact: true }).click();
    await page.getByRole('button', { name: '13 August 2026', exact: true }).click();
    await expect(page.getByTestId('date-filter-summary')).toHaveText('4 Aug 2026 – 13 Aug 2026');
    await screenshot(
      page,
      page.getByTestId('advanced-search-panel'),
      'advanced-search-panel',
      theme,
    );
  });

  test(`select menu ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, {
      overrides: {
        list_accounts: [playwrightMailAccount],
        parse_search_query: playwrightParsedSearchQuery,
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Show search options' }).click();
    await page.getByLabel('Search in').click();
    await screenshot(page, page.getByRole('listbox'), 'select-menu', theme);
  });

  test(`search results sidebar row ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, {
      overrides: {
        list_accounts: [playwrightMailAccount],
        search_threads: playwrightSearchThreadPage,
        search_total: playwrightSearchTotal,
      },
    });
    await page.goto('/');
    await page.getByLabel('Search mail').fill('from:anna');
    await page.getByLabel('Search mail').press('Enter');
    await screenshot(page, page.getByTestId('search-results-row'), 'search-results-row', theme);
  });

  test(`search result row source badge ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, {
      overrides: {
        list_accounts: [playwrightMailAccount],
        search_threads: playwrightSearchThreadPage,
        search_total: playwrightSearchTotal,
      },
    });
    await page.goto('/');
    await page.getByLabel('Search mail').fill('from:anna');
    await page.getByLabel('Search mail').press('Enter');
    await expect(page.getByText('Re: Q3 invoice')).toBeVisible();
    await screenshot(page, page.getByTestId('list-slot'), 'search-result-row-source-badge', theme);
  });

  test(`search zero results ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, {
      overrides: {
        list_accounts: [playwrightMailAccount],
        search_threads: playwrightEmptySearchPage,
        search_total: playwrightZeroSearchTotal,
      },
    });
    await page.goto('/');
    await page.getByLabel('Search mail').fill('from:anna quarterly');
    await page.getByLabel('Search mail').press('Enter');
    await screenshot(page, page.getByTestId('empty-state-search'), 'search-zero-results', theme);
  });

  test(`search incomplete backfill notice ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, {
      overrides: {
        list_accounts: [playwrightMailAccount],
        search_threads: playwrightSearchThreadPage,
        search_total: playwrightSearchTotal,
        read_traversal_status: playwrightBackfillingTraversalStatus,
      },
    });
    await page.goto('/');
    await page.getByLabel('Search mail').fill('from:anna');
    await page.getByLabel('Search mail').press('Enter');
    await screenshot(
      page,
      page.getByTestId('search-incomplete-notice'),
      'search-incomplete-notice',
      theme,
    );
  });

  test(`composer panel ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await openComposeSession(page, playwrightNewComposeSession);
    await screenshot(page, page.getByTestId('compose-overlay'), 'composer-panel', theme);
  });

  test(`attachment strip and inline preview ${theme}`, async ({ page }) => {
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
  });

  test(`recipient field ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await openComposeSession(page, playwrightManyRecipientsComposeSession);
    await expect(page.getByRole('button', { name: /more recipient/ })).toBeVisible();
    await screenshot(page, page.getByTestId('recipient-field'), 'recipient-field', theme);
  });

  test(`contact suggestions ${theme}`, async ({ page }) => {
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
  });

  test(`settings navigation ${theme}`, async ({ page }) => {
    await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
    await page.goto('/');
    await page.getByTestId('sidebar-slot').getByRole('button', { name: 'Settings' }).click();
    await screenshot(page, page.getByTestId('settings-nav'), 'settings-nav', theme);
  });

  test(`settings AI section ${theme}`, async ({ page }) => {
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
  });

  test(`settings general section ${theme}`, async ({ page }) => {
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
  });

  test(`settings updates section ${theme}`, async ({ page }) => {
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
  });

  test(`settings trusted senders ${theme}`, async ({ page }) => {
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
  });

  test(`settings accounts section ${theme}`, async ({ page }) => {
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
  });

  test(`settings keyboard section ${theme}`, async ({ page }) => {
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
  });

  test(`settings queue section ${theme}`, async ({ page }) => {
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
  });

  test(`settings logs section ${theme}`, async ({ page }) => {
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
  });

  test(`quote disclosure ${theme}`, async ({ page }) => {
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
  });
}
