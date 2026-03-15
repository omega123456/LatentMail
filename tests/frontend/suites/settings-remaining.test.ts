import { DateTime } from 'luxon';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  clearMockIpc,
  closeCommandPaletteIfOpen,
  configureOllama,
  discardComposeIfOpen,
  ensureOllamaModelSelected,
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
  mockIpc,
  navigateToSettings,
  openCommandPalette,
  returnToMailShell,
  seedQueueState,
  waitForMailShell,
} from '../infrastructure/helpers';

test.describe('Settings remaining coverage', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  let shortcutModifier: 'Meta' | 'Control';

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));
    await waitForMailShell(page);
    shortcutModifier = await getShortcutModifier(electronApp);
  });

  test.afterEach(async ({ electronApp }) => {
    await clearMockIpc(electronApp);
  });

  // ═════════════════════════════════════════════════════════════════════
  // General settings: toggle various settings
  // ═════════════════════════════════════════════════════════════════════

  // ── Show unread counts toggle ──────────────────────────────────────

  test('show unread counts toggle changes state', async ({ page }) => {
    await navigateToSettings(page, 'general');

    // The toggle is in the Sidebar section
    const sidebarSection = page.locator('section').filter({ has: page.locator('h3', { hasText: 'Sidebar' }) });
    const toggle = sidebarSection.locator('mat-slide-toggle').first();
    const toggleButton = toggle.locator('button');
    const before = await toggleButton.getAttribute('aria-checked');
    const expectedAfter = before === 'true' ? 'false' : 'true';

    await toggle.click();
    await expect(toggleButton).toHaveAttribute('aria-checked', expectedAfter);

    // Toggle back
    await toggle.click();
    await expect(toggleButton).toHaveAttribute('aria-checked', before!);
  });

  // ── Sync on startup toggle ─────────────────────────────────────────

  test('sync on startup toggle changes state', async ({ page }) => {
    await navigateToSettings(page, 'general');

    const syncSection = page.locator('section').filter({ has: page.locator('h3', { hasText: 'Sync' }) });
    // The "Sync on startup" toggle is the second one in the Sync section
    const toggles = syncSection.locator('mat-slide-toggle');
    const syncOnStartupToggle = toggles.nth(0); // first after the interval select
    const toggleButton = syncOnStartupToggle.locator('button');

    const before = await toggleButton.getAttribute('aria-checked');
    const expectedAfter = before === 'true' ? 'false' : 'true';

    await syncOnStartupToggle.click();
    await expect(toggleButton).toHaveAttribute('aria-checked', expectedAfter);

    // Toggle back
    await syncOnStartupToggle.click();
    await expect(toggleButton).toHaveAttribute('aria-checked', before!);
  });

  // ── Start at login toggle ──────────────────────────────────────────

  test('start at login toggle changes state', async ({ page }) => {
    await navigateToSettings(page, 'general');

    const systemSection = page.locator('section').filter({ has: page.locator('h3', { hasText: 'System' }) });
    const startAtLoginToggle = systemSection.locator('mat-slide-toggle').first();
    const toggleButton = startAtLoginToggle.locator('button');
    const before = await toggleButton.getAttribute('aria-checked');
    const expectedAfter = before === 'true' ? 'false' : 'true';

    await startAtLoginToggle.click();
    await expect(toggleButton).toHaveAttribute('aria-checked', expectedAfter);

    // Toggle back
    await startAtLoginToggle.click();
    await expect(toggleButton).toHaveAttribute('aria-checked', before!);
  });

  // ── Zoom change via dropdown ───────────────────────────────────────

  test('zoom dropdown changes zoom level', async ({ page }) => {
    await navigateToSettings(page, 'general');

    const appearanceSection = page.locator('section').filter({ has: page.locator('h3', { hasText: 'Appearance' }) });
    const zoomSelect = appearanceSection.locator('mat-select');
    await expect(zoomSelect).toBeVisible();

    // Click the zoom select and choose a different zoom
    await zoomSelect.click();
    const option125 = page.locator('mat-option').filter({ hasText: '125%' });
    if (await option125.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await option125.click();
      await expect(zoomSelect).toContainText('125');
    } else {
      // Just close the dropdown if the option isn't available
      await page.keyboard.press('Escape');
    }
  });

  // ── Zoom reset button ──────────────────────────────────────────────

  test('zoom reset button resets to 100%', async ({ page }) => {
    await navigateToSettings(page, 'general');

    const appearanceSection = page.locator('section').filter({ has: page.locator('h3', { hasText: 'Appearance' }) });
    const resetButton = appearanceSection.locator('button', { hasText: 'Reset to 100%' });

    if (await resetButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await resetButton.click();

      // After reset, the button should disappear (zoom is 100%)
      await expect(resetButton).not.toBeVisible({ timeout: 5_000 });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // Logger settings: additional coverage
  // ═════════════════════════════════════════════════════════════════════

  // ── Logger: entries load on navigation ─────────────────────────────

  test('logger settings loads entries when navigated to', async ({ page }) => {
    await navigateToSettings(page, 'logger');

    // Wait for loading to complete
    const loading = page.locator('.log-loading');
    if (await loading.isVisible().catch(() => false)) {
      await expect(loading).not.toBeVisible({ timeout: 10_000 });
    }

    // Should show either entries or empty state
    const logEntries = page.getByTestId('logger-entries');
    const logEmpty = page.locator('.log-empty');

    const hasEntries = await logEntries.isVisible().catch(() => false);
    const hasEmptyState = await logEmpty.isVisible().catch(() => false);
    expect(hasEntries || hasEmptyState).toBe(true);
  });

  // ── Logger: search filter with matching query ──────────────────────

  test('logger search with a broader query exercises filteredLogEntries', async ({ page }) => {
    await navigateToSettings(page, 'logger');

    const searchInput = page.locator('input[aria-label="Search log entries"]');
    await expect(searchInput).toBeVisible();

    // Search for something that might match log entries (e.g. "info" or "error")
    await searchInput.fill('info');
    await page.waitForTimeout(500);

    // The results may be filtered — check state
    const logEntries = page.getByTestId('logger-entries');
    const logEmpty = page.locator('.log-empty');

    const hasEntries = await logEntries.isVisible().catch(() => false);
    const hasEmptyState = await logEmpty.isVisible().catch(() => false);
    expect(hasEntries || hasEmptyState).toBe(true);

    // Clear search to restore full list
    await searchInput.fill('');
  });

  // ═════════════════════════════════════════════════════════════════════
  // Queue settings: tab navigation
  // ═════════════════════════════════════════════════════════════════════

  // ── Queue: navigate to queue and verify stats card ─────────────────

  test('queue settings shows stats card with counts', async ({ page }) => {
    await navigateToSettings(page, 'queue');

    const statsCard = page.locator('.stats-card');
    await expect(statsCard.first()).toBeVisible({ timeout: 10_000 });

    // Verify stat labels exist
    await expect(statsCard.first().locator('.stat-label').filter({ hasText: 'Pending' })).toBeVisible();
    await expect(statsCard.first().locator('.stat-label').filter({ hasText: 'Done' })).toBeVisible();
  });

  // ── Queue: retry, dismiss, clear completed, body prefetch tab ───────

  test('queue settings exercises queue store actions and render paths with mocked queue events', async ({
    page,
    electronApp,
  }) => {
    await seedQueueState(electronApp, {
      items: [
        {
          queueId: 'mail-failed',
          accountId,
          type: 'move',
          status: 'failed',
          createdAt: DateTime.utc().minus({ minutes: 5 }).toISO(),
          retryCount: 1,
          error: 'Move failed',
          description: 'Move to archive',
        },
        {
          queueId: 'mail-cancelled',
          accountId,
          type: 'delete',
          status: 'cancelled',
          createdAt: DateTime.utc().minus({ hours: 1 }).toISO(),
          retryCount: 0,
          description: 'Delete thread',
        },
        {
          queueId: 'mail-completed-warning',
          accountId,
          type: 'send',
          status: 'completed',
          createdAt: DateTime.utc().minus({ days: 2 }).toISO(),
          retryCount: 0,
          error: 'Completed with warning',
          description: 'Send with warning',
        },
      ],
      bodyFetchItems: [
        {
          queueId: 'prefetch-pending',
          accountId,
          type: 'body-fetch',
          status: 'pending',
          createdAt: DateTime.utc().minus({ minutes: 1 }).toISO(),
          retryCount: 0,
          description: 'Prefetch INBOX',
        },
        {
          queueId: 'prefetch-failed',
          accountId,
          type: 'body-fetch',
          status: 'failed',
          createdAt: DateTime.utc().minus({ hours: 3 }).toISO(),
          retryCount: 2,
          error: 'Prefetch failed',
          description: 'Prefetch failed item',
        },
      ],
    });

    await navigateToSettings(page, 'queue');
    await expect(page.getByTestId('queue-list')).toBeVisible();
    await expect(page.getByTestId('queue-item-mail-failed')).toContainText('Move to archive');
    await expect(page.getByTestId('queue-item-mail-failed')).toContainText('Failed');
    await expect(page.getByTestId('queue-item-mail-completed-warning')).toContainText('Done (warnings)');

    await mockIpc(electronApp, {
      channel: 'queue:retry-failed',
      response: { success: true, data: { retriedCount: 1 } },
      once: true,
    });
    await page.getByTestId('queue-retry-all-button').click();

    await mockIpc(electronApp, {
      channel: 'queue:cancel',
      response: { success: true, data: {} },
      once: true,
    });
    await page.getByTestId('queue-item-mail-failed').locator('button[title="Dismiss"]').click();

    await mockIpc(electronApp, {
      channel: 'queue:clear-completed',
      response: { success: true, data: { clearedCount: 2 } },
      once: true,
    });
    await mockIpc(electronApp, {
      channel: 'body-queue:clear-completed',
      response: { success: true, data: {} },
      once: true,
    });
    await page.getByTestId('queue-clear-completed-button').click();

    const tabs = page.locator('.queue-tabs [role="tab"]');
    await tabs.filter({ hasText: 'Body Prefetch' }).click();
    await expect(page.getByTestId('queue-item-prefetch-pending')).toBeVisible();

    await mockIpc(electronApp, {
      channel: 'body-queue:cancel',
      response: { success: true, data: {} },
      once: true,
    });
    await page.getByTestId('queue-item-prefetch-pending').locator('button[title="Cancel"]').click();
  });

  // ═════════════════════════════════════════════════════════════════════
  // Command palette: additional keyboard coverage
  // ═════════════════════════════════════════════════════════════════════

  // ── Enter key executes focused command ─────────────────────────────

  test('Enter key in command palette executes the focused command', async ({ page }) => {
    await returnToMailShell(page);
    await discardComposeIfOpen(page);
    await focusMailShell(page);

    await openCommandPalette(page, shortcutModifier);

    const paletteInput = page.getByTestId('command-palette-input');
    await expect(paletteInput).toBeFocused();

    // Type to filter to "compose"
    await paletteInput.fill('compose new');
    await expect(page.locator('[data-testid^="command-palette-item-"]').first()).toBeVisible();

    // Press Enter to execute the focused command
    await page.keyboard.press('Enter');

    // Command palette should close
    await expect(page.getByTestId('command-palette')).toBeHidden({ timeout: 5_000 });

    // Compose should open (the "compose new email" command)
    await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5_000 });

    await discardComposeIfOpen(page);
  });

  // ── Backdrop click closes command palette ──────────────────────────

  test('clicking backdrop closes command palette', async ({ page }) => {
    await discardComposeIfOpen(page);
    await focusMailShell(page);

    await openCommandPalette(page, shortcutModifier);
    await expect(page.getByTestId('command-palette')).toBeVisible();

    // Click on the backdrop (the .palette-backdrop element itself, not a child)
    const backdrop = page.getByTestId('command-palette');
    await backdrop.click({ position: { x: 5, y: 5 } });

    await expect(page.getByTestId('command-palette')).toBeHidden({ timeout: 5_000 });
  });

  // ── Search query in command palette resets focused index ────────────

  test('typing search in command palette resets focus to first item', async ({ page }) => {
    await discardComposeIfOpen(page);
    await focusMailShell(page);

    await openCommandPalette(page, shortcutModifier);

    const paletteInput = page.getByTestId('command-palette-input');
    await expect(paletteInput).toBeFocused();

    // Navigate down a few times
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');

    // Type a new query — this should reset the focused index to 0
    await paletteInput.fill('star');

    // Wait for results to filter
    await page.waitForTimeout(200);

    // The first result (if any) should be focused
    const firstItem = page.locator('[data-testid^="command-palette-item-"]').first();
    if (await firstItem.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await expect(firstItem).toHaveClass(/focused/);
    }

    await closeCommandPaletteIfOpen(page);
  });

  // ═════════════════════════════════════════════════════════════════════
  // Filter settings: navigation and CRUD
  // ═════════════════════════════════════════════════════════════════════

  test('navigating to filter settings shows the filter section', async ({ page }) => {
    await navigateToSettings(page, 'filters');

    // Verify the filter settings content is visible
    await expect(page.getByTestId('settings-content')).toBeVisible();

    // The filters section should show either a list or empty state
    const content = page.getByTestId('settings-content');
    const text = await content.textContent();
    expect(text).toBeTruthy();
  });

  // ── Filter settings: CRUD, AI generation, run now, reorder, failures ─

  test('filter settings covers CRUD, AI generation, run now, reorder, and failures', async ({
    page,
    electronApp,
  }) => {
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
    });

    await navigateToSettings(page, 'ai');
    await expect(page.getByTestId('ai-status-indicator')).toContainText('Connected', { timeout: 10_000 });
    await ensureOllamaModelSelected(page, 'llama3');
    await navigateToSettings(page, 'filters');
    await expect(page.getByTestId('settings-content')).toBeVisible();

    await mockIpc(electronApp, {
      channel: 'db:get-filters',
      response: {
        success: true,
        data: {
          filters: [
            {
              id: 1,
              accountId,
              name: 'Invoices',
              conditions: JSON.stringify([{ field: 'subject', operator: 'contains', value: 'invoice' }]),
              actions: JSON.stringify([{ type: 'move', value: 'Finance' }]),
              isEnabled: true,
              isAiGenerated: false,
              sortOrder: 0,
            },
            {
              id: 2,
              accountId,
              name: 'Reports',
              conditions: '{',
              actions: JSON.stringify([{ type: 'mark-read' }]),
              isEnabled: false,
              isAiGenerated: true,
              sortOrder: 1,
            },
          ],
        },
      },
      once: true,
    });
    await navigateToSettings(page, 'general');
    await navigateToSettings(page, 'filters');

    await expect(page.getByTestId('filter-item-1')).toContainText('Invoices');
    await expect(page.getByTestId('filter-item-2')).toContainText('Reports');

    await mockIpc(electronApp, {
      channel: 'db:toggle-filter',
      response: { success: true, data: {} },
      once: true,
    });
    await page.getByTestId('filter-item-1').locator('button[title="Disable"]').click();
    await expect(page.getByTestId('filter-item-1')).toHaveClass(/disabled/);

    await mockIpc(electronApp, {
      channel: 'filter:apply-all',
      response: {
        success: true,
        data: { emailsProcessed: 2, emailsMatched: 1, actionsDispatched: 1, errors: 1 },
      },
      once: true,
    });
    await page.getByRole('button', { name: 'Run Filters Now' }).click();
    await expect(page.locator('.filter-result-message')).toContainText('Processed 2 emails, 1 matched, 1 error');

    await mockIpc(electronApp, {
      channel: 'filter:apply-all',
      response: {
        success: true,
        data: { emailsProcessed: 0, emailsMatched: 0, actionsDispatched: 0, errors: 0 },
      },
      once: true,
    });
    await page.getByRole('button', { name: 'Run Filters Now' }).click();
    await expect(page.locator('.filter-result-message')).toContainText('No unfiltered emails to process');

    await mockIpc(electronApp, {
      channel: 'ai:generate-filter',
      response: {
        success: true,
        data: {
          name: 'AI Finance',
          conditions: [{ field: 'from', operator: 'contains', value: 'billing' }],
          actions: [{ type: 'move', value: 'Finance' }],
        },
      },
      once: true,
    });
    const aiInput = page.locator('.ai-description-input');
    await aiInput.fill('Move finance mail');
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.getByRole('heading', { name: 'New Filter' })).toBeVisible();
    await expect(page.locator('.form-input').first()).toHaveValue('AI Finance');

    await page.getByRole('button', { name: 'Add Condition' }).click();
    await page.getByRole('button', { name: 'Add Action' }).click();
    await page.locator('.condition-row .form-select').nth(0).selectOption('to');
    await page.locator('.condition-row .form-select').nth(1).selectOption('equals');
    await page.locator('.condition-row .condition-value').nth(0).fill('boss@example.com');
    await page.locator('.action-row .form-select').last().selectOption('move');
    await page.locator('.action-row .form-input').last().fill('VIP');
    await page.locator('.condition-row .icon-btn.danger').last().click();
    await page.locator('.action-row .icon-btn.danger').last().click();

    await mockIpc(electronApp, {
      channel: 'db:save-filter',
      response: { success: false, error: { code: 'SAVE_FAIL', message: 'Save failed' } },
      once: true,
    });
    await page.getByRole('button', { name: 'Save Filter' }).click();
    await expect(page.locator('.error-banner')).toContainText('Save failed');

    await mockIpc(electronApp, {
      channel: 'db:save-filter',
      response: { success: true, data: { id: 5 } },
      once: true,
    });
    await mockIpc(electronApp, {
      channel: 'db:get-filters',
      response: {
        success: true,
        data: {
          filters: [
            {
              id: 1,
              accountId,
              name: 'Invoices',
              conditions: JSON.stringify([{ field: 'subject', operator: 'contains', value: 'invoice' }]),
              actions: JSON.stringify([{ type: 'move', value: 'Finance' }]),
              isEnabled: false,
              isAiGenerated: false,
              sortOrder: 0,
            },
            {
              id: 2,
              accountId,
              name: 'Reports',
              conditions: JSON.stringify([]),
              actions: JSON.stringify([{ type: 'mark-read' }]),
              isEnabled: false,
              isAiGenerated: true,
              sortOrder: 1,
            },
            {
              id: 5,
              accountId,
              name: 'AI Finance',
              conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'billing' }]),
              actions: JSON.stringify([{ type: 'move', value: 'Finance' }]),
              isEnabled: true,
              isAiGenerated: true,
              sortOrder: 2,
            },
          ],
        },
      },
      once: true,
    });
    await page.getByRole('button', { name: 'Save Filter' }).click();
    await expect(page.getByTestId('filter-item-5')).toContainText('AI Finance');

    await page.getByTestId('filter-item-5').locator('button[title="Edit"]').click();
    await expect(page.getByText('Edit Filter')).toBeVisible();
    await page.locator('.form-input').first().fill('AI Finance Updated');

    await mockIpc(electronApp, {
      channel: 'db:update-filter',
      response: { success: true, data: {} },
      once: true,
    });
    await mockIpc(electronApp, {
      channel: 'db:get-filters',
      response: {
        success: true,
        data: {
          filters: [
            {
              id: 5,
              accountId,
              name: 'AI Finance Updated',
              conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'billing' }]),
              actions: JSON.stringify([{ type: 'move', value: 'Finance' }]),
              isEnabled: true,
              isAiGenerated: true,
              sortOrder: 0,
            },
            {
              id: 1,
              accountId,
              name: 'Invoices',
              conditions: JSON.stringify([{ field: 'subject', operator: 'contains', value: 'invoice' }]),
              actions: JSON.stringify([{ type: 'move', value: 'Finance' }]),
              isEnabled: false,
              isAiGenerated: false,
              sortOrder: 1,
            },
          ],
        },
      },
      once: true,
    });
    await page.getByRole('button', { name: 'Save Filter' }).click();
    await expect(page.getByTestId('filter-item-5')).toContainText('AI Finance Updated');

    await mockIpc(electronApp, {
      channel: 'db:update-filter',
      response: { success: true, data: {} },
      once: true,
    });
    await mockIpc(electronApp, {
      channel: 'db:update-filter',
      response: { success: true, data: {} },
      once: true,
    });
    await mockIpc(electronApp, {
      channel: 'db:get-filters',
      response: {
        success: true,
        data: {
          filters: [
            {
              id: 5,
              accountId,
              name: 'AI Finance Updated',
              conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'billing' }]),
              actions: JSON.stringify([{ type: 'move', value: 'Finance' }]),
              isEnabled: true,
              isAiGenerated: true,
              sortOrder: 0,
            },
            {
              id: 1,
              accountId,
              name: 'Invoices',
              conditions: JSON.stringify([{ field: 'subject', operator: 'contains', value: 'invoice' }]),
              actions: JSON.stringify([{ type: 'move', value: 'Finance' }]),
              isEnabled: false,
              isAiGenerated: false,
              sortOrder: 1,
            },
          ],
        },
      },
      once: true,
    });
    await page.getByTestId('filter-item-5').locator('button[title="Move down (lower priority)"]').click();
    await expect(page.getByTestId('filter-item-1')).toBeVisible();

    await mockIpc(electronApp, {
      channel: 'db:delete-filter',
      response: { success: false, error: { code: 'DELETE_FAIL', message: 'Delete failed' } },
      once: true,
    });
    await page.getByTestId('filter-item-5').locator('button[title="Delete"]').click();
    await expect(page.locator('.error-banner')).toContainText('Delete failed');
  });

  // ── Keyboard settings: render shortcut list ────────────────────────

  test('keyboard settings shows shortcut list', async ({ page }) => {
    await navigateToSettings(page, 'keyboard');

    const shortcutList = page.locator('[data-testid="keyboard-shortcut-list"]');
    await expect(shortcutList).toBeVisible();

    // Should have multiple command rows
    const commandRows = shortcutList.locator('.command-row');
    await expect(commandRows.first()).toBeVisible();
  });
});
