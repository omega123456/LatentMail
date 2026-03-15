import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  getShortcutModifier,
  navigateToSettings,
  returnToMailShell,
  waitForMailShell,
} from '../infrastructure/helpers';

test.describe('Keyboard settings deep', () => {
  test.describe.configure({ mode: 'serial' });

  let modifier: 'Control' | 'Meta';

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    extractSeededAccount(result);
    await waitForMailShell(page);
    modifier = await getShortcutModifier(electronApp);
    await navigateToSettings(page, 'keyboard');
  });

  // Scenario 1: Navigate to keyboard settings and verify shortcut rows are visible

  test('shortcut rows are visible in keyboard settings', async ({ page }) => {
    const shortcutRows = page.locator('[data-testid^="shortcut-row-"]');
    await expect(shortcutRows.first()).toBeVisible();

    const rowCount = await shortcutRows.count();
    expect(rowCount).toBeGreaterThan(5);

    // Verify compose-new and search-focus rows specifically exist
    await expect(page.getByTestId('shortcut-row-compose-new')).toBeVisible();
    await expect(page.getByTestId('shortcut-row-search-focus')).toBeVisible();
  });

  // Scenario 2: Click capture button → verify capture mode is-capturing class

  test('clicking Edit enters capture mode with is-capturing class', async ({ page }) => {
    const composeRow = page.getByTestId('shortcut-row-compose-new');
    await page.getByTestId('shortcut-capture-btn-compose-new').click();

    await expect(composeRow).toHaveClass(/is-capturing/);
    await expect(page.getByTestId('shortcut-pending-keys')).toBeVisible();
  });

  // Scenario 3: Press a new key combination → verify pending keys display

  test('pressing a key combination displays pending keys', async ({ page }) => {
    const pendingInput = page.getByTestId('shortcut-pending-keys');
    await pendingInput.focus();

    await page.keyboard.press(`${modifier}+Shift+l`);

    await expect(pendingInput).not.toHaveValue('');
  });

  // Scenario 4: Click Apply to commit → verify capture exits and new binding shows

  test('applying capture commits the new binding and exits capture mode', async ({ page }) => {
    const composeRow = page.getByTestId('shortcut-row-compose-new');

    await composeRow.getByRole('button', { name: 'Apply' }).click();

    await expect(composeRow).not.toHaveClass(/is-capturing/);
    await expect(composeRow.locator('.custom-tag')).toBeVisible();
    await expect(composeRow.locator('.key-badge')).toBeVisible();
  });

  // Scenario 5: Navigate away then back → verify custom binding persists

  test('custom binding persists after navigating away and back', async ({ page }) => {
    await returnToMailShell(page);
    await navigateToSettings(page, 'keyboard');

    const composeRow = page.getByTestId('shortcut-row-compose-new');
    await expect(composeRow.locator('.custom-tag')).toBeVisible();
  });

  // Scenario 6: Conflict detection — press same key combo on different command

  test('conflict warning appears when pressing a key combo used by another command', async ({ page }) => {
    await page.getByTestId('shortcut-capture-btn-search-focus').click();

    const searchRow = page.getByTestId('shortcut-row-search-focus');
    await expect(searchRow).toHaveClass(/is-capturing/);

    const pendingInput = page.getByTestId('shortcut-pending-keys');
    await pendingInput.focus();

    // Press the same combo currently assigned to compose-new
    await page.keyboard.press(`${modifier}+Shift+l`);

    await expect(page.getByTestId('shortcut-conflict-warning')).toBeVisible();
  });

  // Scenario 7: Click Reassign → verify conflict resolved

  test('clicking Reassign resolves the conflict and applies the binding', async ({ page }) => {
    await page.getByTestId('shortcut-reassign-btn').click();

    // Capture mode should exit on search-focus
    const searchRow = page.getByTestId('shortcut-row-search-focus');
    await expect(searchRow).not.toHaveClass(/is-capturing/);

    // search-focus should now have the custom binding
    await expect(searchRow.locator('.custom-tag')).toBeVisible();

    // compose-new should have been reset to its default (no custom tag)
    const composeRow = page.getByTestId('shortcut-row-compose-new');
    await expect(composeRow.locator('.custom-tag')).not.toBeVisible();
  });

  // Scenario 8: Reset single command binding

  test('reset button reverts a single command to its default binding', async ({ page }) => {
    const searchRow = page.getByTestId('shortcut-row-search-focus');
    const resetButton = page.getByTestId('shortcut-reset-btn-search-focus');
    await expect(resetButton).toBeVisible();

    await resetButton.click();

    await expect(searchRow.locator('.custom-tag')).not.toBeVisible();
  });

  // Scenario 9: Customize two shortcuts, then Reset All

  test('reset all reverts all custom bindings to defaults', async ({ page }) => {
    // Customize compose-new
    await page.getByTestId('shortcut-capture-btn-compose-new').click();
    const pendingInput1 = page.getByTestId('shortcut-pending-keys');
    await pendingInput1.focus();
    await page.keyboard.press(`${modifier}+Shift+l`);
    await page.getByTestId('shortcut-row-compose-new')
      .getByRole('button', { name: 'Apply' }).click();

    // Customize sync-now
    await page.getByTestId('shortcut-capture-btn-sync-now').click();
    const pendingInput2 = page.getByTestId('shortcut-pending-keys');
    await pendingInput2.focus();
    await page.keyboard.press(`${modifier}+Shift+m`);
    await page.getByTestId('shortcut-row-sync-now')
      .getByRole('button', { name: 'Apply' }).click();

    // Both should show custom tags
    await expect(page.getByTestId('shortcut-row-compose-new').locator('.custom-tag')).toBeVisible();
    await expect(page.getByTestId('shortcut-row-sync-now').locator('.custom-tag')).toBeVisible();

    // Reset All button should be visible and clickable
    const resetAllButton = page.getByTestId('shortcut-reset-all');
    await expect(resetAllButton).toBeVisible();
    await resetAllButton.click();

    // Both should revert to defaults (no custom tags)
    await expect(page.getByTestId('shortcut-row-compose-new').locator('.custom-tag')).not.toBeVisible();
    await expect(page.getByTestId('shortcut-row-sync-now').locator('.custom-tag')).not.toBeVisible();

    // Reset All button should disappear (no custom bindings remain)
    await expect(resetAllButton).not.toBeVisible();
  });

  // Scenario 10: Escape cancels capture without changing binding

  test('pressing Escape cancels capture mode without changing binding', async ({ page }) => {
    const composeRow = page.getByTestId('shortcut-row-compose-new');
    const originalBadgeText = await composeRow.locator('.key-badge').textContent();

    await page.getByTestId('shortcut-capture-btn-compose-new').click();
    await expect(composeRow).toHaveClass(/is-capturing/);

    const pendingInput = page.getByTestId('shortcut-pending-keys');
    await pendingInput.focus();

    await page.keyboard.press('Escape');

    // Capture mode should exit
    await expect(composeRow).not.toHaveClass(/is-capturing/);

    // Binding should remain unchanged
    const currentBadgeText = await composeRow.locator('.key-badge').textContent();
    expect(currentBadgeText).toBe(originalBadgeText);
  });
});
