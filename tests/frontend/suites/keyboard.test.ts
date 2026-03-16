import { test, expect } from '../infrastructure/electron-fixture';
import {
  closeCommandPaletteIfOpen,
  discardComposeIfOpen,
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
  injectInboxMessage,
  navigateToSettings,
  openCommandPalette,
  returnToMailShell,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
} from '../infrastructure/helpers';

test.describe('Keyboard', () => {
  test.describe.configure({ mode: 'serial' });

  test.describe('Keyboard shortcuts', () => {
    let accountId: number;
    let seededEmail: string;
    let shortcutModifier: 'Meta' | 'Control';
    let newerThreadId: string;
    let olderThreadId: string;
    let newerSubject: string;

    test.beforeAll(async ({ resetApp, electronApp, page }) => {
      const result = await resetApp({ seedAccount: true });
      ({ accountId, email: seededEmail } = extractSeededAccount(result));

      await waitForMailShell(page);
      shortcutModifier = await getShortcutModifier(electronApp);

      const olderMessage = await injectInboxMessage(electronApp, {
        from: 'older-shortcuts@example.com',
        to: seededEmail,
        subject: 'Keyboard Shortcut Older Thread',
        body: 'This older message is used for keyboard navigation coverage.',
      });

      const newerMessage = await injectInboxMessage(electronApp, {
        from: 'newer-shortcuts@example.com',
        to: seededEmail,
        subject: 'Keyboard Shortcut Newer Thread',
        body: 'This newer message is used for keyboard navigation coverage.',
      });

      olderThreadId = olderMessage.xGmThrid;
      newerThreadId = newerMessage.xGmThrid;
      newerSubject = 'Keyboard Shortcut Newer Thread';

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, newerSubject);
    });

    test('compose shortcut opens compose window', async ({ page }) => {
      await discardComposeIfOpen(page);
      await focusMailShell(page);

      await page.keyboard.press(`${shortcutModifier}+n`);

      await expect(page.getByTestId('compose-window')).toBeVisible();

      await discardComposeIfOpen(page);
    });

    test('slash key focuses search bar', async ({ page }) => {
      await focusMailShell(page);

      await page.keyboard.press('/');

      await expect(page.getByTestId('search-input')).toBeFocused();

      await page.getByTestId('email-list-container').click({ position: { x: 20, y: 20 } });
    });

    test('Escape closes command palette', async ({ page }) => {
      await discardComposeIfOpen(page);
      await focusMailShell(page);

      await openCommandPalette(page, shortcutModifier);
      await closeCommandPaletteIfOpen(page);
    });

    test('arrow keys navigate the email list', async ({ page }) => {
      const emailItems = page.locator('[data-testid^="email-item-"]');
      const firstItem = emailItems.nth(0);
      const secondItem = emailItems.nth(1);

      await expect(emailItems).toHaveCount(2);

      await firstItem.click();
      await expect(firstItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await page.keyboard.press('ArrowDown');

      await expect(secondItem).toHaveClass(/(^|\s)selected(\s|$)/);
      await expect(firstItem).not.toHaveClass(/(^|\s)selected(\s|$)/);
    });

    test('Enter opens the selected thread in the reading pane', async ({ page }) => {
      const emailItems = page.locator('[data-testid^="email-item-"]');
      const firstItem = emailItems.nth(0);
      const secondItem = emailItems.nth(1);

      await expect(emailItems).toHaveCount(2);

      await firstItem.click();
      await expect(firstItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await page.keyboard.press('ArrowDown');
      await expect(secondItem).toHaveClass(/(^|\s)selected(\s|$)/);

      const secondItemTestId = await secondItem.getAttribute('data-testid');
      const selectedSubject = secondItemTestId === `email-item-${newerThreadId}`
        ? newerSubject
        : 'Keyboard Shortcut Older Thread';

      await page.keyboard.press('Enter');

      await expect(page.getByTestId('reading-pane-content')).toBeVisible();
      await expect(page.getByTestId('thread-subject')).toContainText(selectedSubject);
    });
  });

  test.describe('Keyboard settings', () => {
    let modifier: 'Control' | 'Meta';

    test.beforeAll(async ({ resetApp, electronApp, page }) => {
      const result = await resetApp({ seedAccount: true });
      extractSeededAccount(result);
      await waitForMailShell(page);
      modifier = await getShortcutModifier(electronApp);
      await navigateToSettings(page, 'keyboard');
    });

    test('shortcut rows are visible in keyboard settings', async ({ page }) => {
      const shortcutRows = page.locator('[data-testid^="shortcut-row-"]');
      await expect(shortcutRows.first()).toBeVisible();

      const rowCount = await shortcutRows.count();
      expect(rowCount).toBeGreaterThan(5);

      await expect(page.getByTestId('shortcut-row-compose-new')).toBeVisible();
      await expect(page.getByTestId('shortcut-row-search-focus')).toBeVisible();
    });

    test('clicking Edit enters capture mode with is-capturing class', async ({ page }) => {
      const composeRow = page.getByTestId('shortcut-row-compose-new');
      await page.getByTestId('shortcut-capture-btn-compose-new').click();

      await expect(composeRow).toHaveClass(/is-capturing/);
      await expect(page.getByTestId('shortcut-pending-keys')).toBeVisible();
    });

    test('pressing a key combination displays pending keys', async ({ page }) => {
      const pendingInput = page.getByTestId('shortcut-pending-keys');
      await pendingInput.focus();

      await page.keyboard.press(`${modifier}+Shift+l`);

      await expect(pendingInput).not.toHaveValue('');
    });

    test('applying capture commits the new binding and exits capture mode', async ({ page }) => {
      const composeRow = page.getByTestId('shortcut-row-compose-new');

      await composeRow.getByRole('button', { name: 'Apply' }).click();

      await expect(composeRow).not.toHaveClass(/is-capturing/);
      await expect(composeRow.locator('.custom-tag')).toBeVisible();
      await expect(composeRow.locator('.key-badge')).toBeVisible();
    });

    test('custom binding persists after navigating away and back', async ({ page }) => {
      await returnToMailShell(page);
      await navigateToSettings(page, 'keyboard');

      const composeRow = page.getByTestId('shortcut-row-compose-new');
      await expect(composeRow.locator('.custom-tag')).toBeVisible();
    });

    test('conflict warning appears when pressing a key combo used by another command', async ({ page }) => {
      await page.getByTestId('shortcut-capture-btn-search-focus').click();

      const searchRow = page.getByTestId('shortcut-row-search-focus');
      await expect(searchRow).toHaveClass(/is-capturing/);

      const pendingInput = page.getByTestId('shortcut-pending-keys');
      await pendingInput.focus();

      await page.keyboard.press(`${modifier}+Shift+l`);

      await expect(page.getByTestId('shortcut-conflict-warning')).toBeVisible();
    });

    test('clicking Reassign resolves the conflict and applies the binding', async ({ page }) => {
      await page.getByTestId('shortcut-reassign-btn').click();

      const searchRow = page.getByTestId('shortcut-row-search-focus');
      await expect(searchRow).not.toHaveClass(/is-capturing/);

      await expect(searchRow.locator('.custom-tag')).toBeVisible();

      const composeRow = page.getByTestId('shortcut-row-compose-new');
      await expect(composeRow.locator('.custom-tag')).not.toBeVisible();
    });

    test('reset button reverts a single command to its default binding', async ({ page }) => {
      const searchRow = page.getByTestId('shortcut-row-search-focus');
      const resetButton = page.getByTestId('shortcut-reset-btn-search-focus');
      await expect(resetButton).toBeVisible();

      await resetButton.click();

      await expect(searchRow.locator('.custom-tag')).not.toBeVisible();
    });

    test('reset all reverts all custom bindings to defaults', async ({ page }) => {
      await page.getByTestId('shortcut-capture-btn-compose-new').click();
      const pendingInput1 = page.getByTestId('shortcut-pending-keys');
      await pendingInput1.focus();
      await page.keyboard.press(`${modifier}+Shift+l`);
      await page.getByTestId('shortcut-row-compose-new')
        .getByRole('button', { name: 'Apply' }).click();

      await page.getByTestId('shortcut-capture-btn-sync-now').click();
      const pendingInput2 = page.getByTestId('shortcut-pending-keys');
      await pendingInput2.focus();
      await page.keyboard.press(`${modifier}+Shift+m`);
      await page.getByTestId('shortcut-row-sync-now')
        .getByRole('button', { name: 'Apply' }).click();

      await expect(page.getByTestId('shortcut-row-compose-new').locator('.custom-tag')).toBeVisible();
      await expect(page.getByTestId('shortcut-row-sync-now').locator('.custom-tag')).toBeVisible();

      const resetAllButton = page.getByTestId('shortcut-reset-all');
      await expect(resetAllButton).toBeVisible();
      await resetAllButton.click();

      await expect(page.getByTestId('shortcut-row-compose-new').locator('.custom-tag')).not.toBeVisible();
      await expect(page.getByTestId('shortcut-row-sync-now').locator('.custom-tag')).not.toBeVisible();

      await expect(resetAllButton).not.toBeVisible();
    });

    test('pressing Escape cancels capture mode without changing binding', async ({ page }) => {
      const composeRow = page.getByTestId('shortcut-row-compose-new');
      const originalBadgeText = await composeRow.locator('.key-badge').textContent();

      await page.getByTestId('shortcut-capture-btn-compose-new').click();
      await expect(composeRow).toHaveClass(/is-capturing/);

      const pendingInput = page.getByTestId('shortcut-pending-keys');
      await pendingInput.focus();

      await page.keyboard.press('Escape');

      await expect(composeRow).not.toHaveClass(/is-capturing/);

      const currentBadgeText = await composeRow.locator('.key-badge').textContent();
      expect(currentBadgeText).toBe(originalBadgeText);
    });
  });
});
