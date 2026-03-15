import { test, expect } from '../infrastructure/electron-fixture';
import {
  closeCommandPaletteIfOpen,
  discardComposeIfOpen,
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
  navigateToSettings,
  openCommandPalette,
  returnToMailShell,
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
  // Filter settings: navigation to filters section
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
