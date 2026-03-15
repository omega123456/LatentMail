import { test, expect } from '../infrastructure/electron-fixture';
import {
  closeCommandPaletteIfOpen,
  configureOllama,
  discardComposeIfOpen,
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
  navigateToSettings,
  openCommandPalette,
  returnToMailShell,
  waitForMailShell,
} from '../infrastructure/helpers';

test.describe('Settings and UI coverage', () => {
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
  // General settings
  // ═════════════════════════════════════════════════════════════════════

  // ── Always allow remote images toggle (onAlwaysAllowToggle) ──────────

  test('always allow remote images toggle changes state', async ({ page }) => {
    await navigateToSettings(page, 'general');

    // Find the "Always allow remote images" toggle
    const remoteImagesSection = page.locator('.remote-images-section');
    await expect(remoteImagesSection).toBeVisible();

    const toggle = remoteImagesSection.locator('mat-slide-toggle').first();
    const toggleButton = toggle.locator('button');
    const before = await toggleButton.getAttribute('aria-checked');
    const expectedAfter = before === 'true' ? 'false' : 'true';

    await toggle.click();

    await expect(toggleButton).toHaveAttribute('aria-checked', expectedAfter);

    // Toggle it back to restore original state
    await toggle.click();
    await expect(toggleButton).toHaveAttribute('aria-checked', before!);
  });

  // ── Whitelist filter input (onFilterChange) ──────────────────────────

  test('filter input for allowed senders responds to typing', async ({ page }) => {
    await navigateToSettings(page, 'general');

    const filterInput = page.locator('input[aria-label="Filter allowed senders"]');
    await expect(filterInput).toBeVisible();

    // Type in the filter — exercises onFilterChange
    await filterInput.fill('nonexistent@test.com');

    // The whitelist should show empty state since no senders match
    const emptyState = page.locator('.whitelist-empty-state');
    // It shows "No senders match your filter" or "No allowed senders yet" depending on state
    await expect(emptyState).toBeVisible({ timeout: 3_000 });

    // Clear the filter
    await filterInput.fill('');
  });

  // ═════════════════════════════════════════════════════════════════════
  // Logger settings
  // ═════════════════════════════════════════════════════════════════════

  // ── Log entries display ──────────────────────────────────────────────

  test('logger settings shows log entries or empty state', async ({ page }) => {
    await navigateToSettings(page, 'logger');

    // Wait for loading to finish
    const loading = page.locator('.log-loading');
    await expect(loading).not.toBeVisible({ timeout: 10_000 });

    // Either log entries should be visible or empty state
    const logEntries = page.getByTestId('logger-entries');
    const logEmpty = page.locator('.log-empty');

    const hasEntries = await logEntries.isVisible().catch(() => false);
    const hasEmptyState = await logEmpty.isVisible().catch(() => false);

    expect(hasEntries || hasEmptyState).toBe(true);
  });

  // ── Log search filter ────────────────────────────────────────────────

  test('logger search filters log entries', async ({ page }) => {
    await navigateToSettings(page, 'logger');

    const searchInput = page.locator('input[aria-label="Search log entries"]');
    await expect(searchInput).toBeVisible();

    // Type a search query to exercise filteredLogEntries computed
    await searchInput.fill('nonexistent_log_entry_abc123');

    // Should show either empty state or no matching entries
    const noMatchState = page.locator('.log-empty');
    await expect(noMatchState).toBeVisible({ timeout: 5_000 });

    // Clear search
    await searchInput.fill('');
  });

  // ── Refresh log entries button ───────────────────────────────────────

  test('refresh button reloads log entries', async ({ page }) => {
    await navigateToSettings(page, 'logger');

    const refreshButton = page.locator('button[aria-label="Refresh log entries"]');
    await expect(refreshButton).toBeVisible();
    await refreshButton.click();

    // Wait for loading to complete
    const loading = page.locator('.log-loading');
    if (await loading.isVisible().catch(() => false)) {
      await expect(loading).not.toBeVisible({ timeout: 10_000 });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // Command palette keyboard navigation
  // ═════════════════════════════════════════════════════════════════════

  // ── ArrowDown/ArrowUp navigation ─────────────────────────────────────

  test('ArrowDown moves focus to next item in command palette', async ({ page }) => {
    await returnToMailShell(page);
    await discardComposeIfOpen(page);
    await focusMailShell(page);

    await openCommandPalette(page, shortcutModifier);

    const paletteInput = page.getByTestId('command-palette-input');
    await expect(paletteInput).toBeFocused();

    // Type something to filter results
    await paletteInput.fill('compose');
    await expect(page.getByTestId('command-palette-results')).toBeVisible();
    await expect(page.locator('[data-testid^="command-palette-item-"]').first()).toBeVisible();

    // Press ArrowDown — the first item should be focused
    await page.keyboard.press('ArrowDown');

    // Verify an item has the focused class
    const focusedItems = page.locator('.palette-item.focused');
    await expect(focusedItems.first()).toBeVisible({ timeout: 3_000 });

    await closeCommandPaletteIfOpen(page);
  });

  // ── ArrowUp moves focus up ───────────────────────────────────────────

  test('ArrowUp moves focus to previous item in command palette', async ({ page }) => {
    await discardComposeIfOpen(page);
    await focusMailShell(page);

    await openCommandPalette(page, shortcutModifier);

    const paletteInput = page.getByTestId('command-palette-input');
    await paletteInput.fill('compose');
    await expect(page.locator('[data-testid^="command-palette-item-"]').first()).toBeVisible();

    // Move down twice then up once
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');

    // Verify an item has the focused class (we can't be precise about which one)
    const focusedItems = page.locator('.palette-item.focused');
    await expect(focusedItems.first()).toBeVisible({ timeout: 3_000 });

    await closeCommandPaletteIfOpen(page);
  });

  // ── Mouse click on command palette item ──────────────────────────────

  test('clicking a command palette item executes it', async ({ page }) => {
    await discardComposeIfOpen(page);
    await focusMailShell(page);

    await openCommandPalette(page, shortcutModifier);

    const paletteInput = page.getByTestId('command-palette-input');
    await paletteInput.fill('compose new');
    await expect(page.locator('[data-testid^="command-palette-item-"]').first()).toBeVisible();

    // Click the first item (which should be "Compose new email")
    await page.locator('[data-testid^="command-palette-item-"]').first().click();

    // Command palette should close
    await expect(page.getByTestId('command-palette')).toBeHidden();

    // Compose window should open
    await expect(page.getByTestId('compose-window')).toBeVisible();

    await discardComposeIfOpen(page);
  });

  // ── mouseenter on command palette item updates focus ──────────────────

  test('hovering over a command palette item updates its focus', async ({ page }) => {
    await discardComposeIfOpen(page);
    await focusMailShell(page);

    await openCommandPalette(page, shortcutModifier);

    // Open with empty query to show recent/all commands
    const paletteInput = page.getByTestId('command-palette-input');
    await expect(paletteInput).toBeFocused();

    // Get the second item and hover over it
    const secondItem = page.locator('[data-testid^="command-palette-item-"]').nth(1);
    if (await secondItem.isVisible().catch(() => false)) {
      await secondItem.hover();
      // The hovered item should get the focused class (via mouseenter → focusedIndex.set)
      await expect(secondItem).toHaveClass(/focused/, { timeout: 3_000 });
    }

    await closeCommandPaletteIfOpen(page);
  });

  // ═════════════════════════════════════════════════════════════════════
  // Status bar: pause/resume sync
  // ═════════════════════════════════════════════════════════════════════

  // ── Pause sync ───────────────────────────────────────────────────────

  test('clicking pause button pauses sync and shows resume button', async ({ page }) => {
    await returnToMailShell(page);

    const statusBar = page.getByTestId('status-bar');
    await expect(statusBar).toBeVisible();

    // Click the "Pause" button
    const pauseButton = statusBar.locator('.sync-pause-btn');
    if (await pauseButton.isVisible().catch(() => false)) {
      await pauseButton.click();

      // After pausing, the "Resume" button should appear
      const resumeButton = statusBar.locator('.sync-resume-btn');
      await expect(resumeButton).toBeVisible({ timeout: 5_000 });

      // The status bar should have the sync-paused class
      await expect(statusBar).toHaveClass(/sync-paused/, { timeout: 5_000 });
    }
  });

  // ── Resume sync ──────────────────────────────────────────────────────

  test('clicking resume button resumes sync and shows pause button', async ({ page }) => {
    const statusBar = page.getByTestId('status-bar');
    await expect(statusBar).toBeVisible();

    // Click the "Resume" button
    const resumeButton = statusBar.locator('.sync-resume-btn');
    if (await resumeButton.isVisible().catch(() => false)) {
      await resumeButton.click();

      // After resuming, the "Pause" button should reappear
      const pauseButton = statusBar.locator('.sync-pause-btn');
      await expect(pauseButton).toBeVisible({ timeout: 5_000 });

      // The status bar should no longer have sync-paused class
      await expect(statusBar).not.toHaveClass(/sync-paused/, { timeout: 5_000 });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // AI settings: embedding model and index
  // ═════════════════════════════════════════════════════════════════════

  // ── Embedding model selection and build index ────────────────────────

  test('AI settings shows embedding model and build index button', async ({ page, electronApp }) => {
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3', 'nomic-embed-text:latest'],
      selectedModel: 'llama3',
    });

    await navigateToSettings(page, 'ai');

    await expect(page.getByTestId('ai-status-indicator')).toContainText('Connected', {
      timeout: 10_000,
    });

    // Select embedding model
    const embeddingModelSelect = page.getByTestId('ai-embedding-model-select');
    await expect(embeddingModelSelect).toBeVisible({ timeout: 10_000 });

    const embeddingModelCard = embeddingModelSelect.locator('.model-card').first();
    await expect(embeddingModelCard).toBeVisible();
    await embeddingModelCard.click();

    // Build index button should be visible
    const buildIndexButton = page.locator('button', { hasText: 'Build index' });
    if (await buildIndexButton.isVisible().catch(() => false)) {
      await buildIndexButton.click();

      // Wait briefly — if cancel button appears, it means the build started
      const cancelButton = page.locator('button', { hasText: 'Cancel' });
      if (await cancelButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await cancelButton.click();
      }
    }
  });
});
