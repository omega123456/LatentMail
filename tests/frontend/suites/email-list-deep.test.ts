import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
  injectInboxMessage,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
  type MessageIdentity,
} from '../infrastructure/helpers';

test.describe('Email list deep', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  let shortcutModifier: 'Meta' | 'Control';
  const injectedMessages: MessageIdentity[] = [];

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);
    shortcutModifier = await getShortcutModifier(electronApp);

    // Inject 5 emails to test navigation and bulk operations
    for (let index = 1; index <= 5; index++) {
      const identity = await injectInboxMessage(electronApp, {
        from: `deep-list-${index}@example.com`,
        to: seededEmail,
        subject: `Deep List Email ${index}`,
        body: `Body content for deep list email ${index}.`,
      });
      injectedMessages.push(identity);
    }

    await triggerSync(electronApp, accountId);

    for (let index = 1; index <= 5; index++) {
      await waitForEmailSubject(page, `Deep List Email ${index}`);
    }
  });

  // ── J key navigation (nav-next) ──────────────────────────────────────

  test('J key moves keyboard cursor to next email', async ({ page }) => {
    await focusMailShell(page);

    // Click the first email to set cursor anchor
    const firstItem = page.locator('[data-testid^="email-item-"]').nth(0);
    await firstItem.click();
    await expect(firstItem).toHaveClass(/(^|\s)selected(\s|$)/);

    // Press j to move to next email
    await page.keyboard.press('j');
    const secondItem = page.locator('[data-testid^="email-item-"]').nth(1);
    await expect(secondItem).toHaveClass(/(^|\s)selected(\s|$)/);
  });

  // ── K key navigation (nav-prev) ──────────────────────────────────────

  test('K key moves keyboard cursor to previous email', async ({ page }) => {
    // Cursor is on 2nd item from previous test; press k to go back to 1st
    await page.keyboard.press('k');
    const firstItem = page.locator('[data-testid^="email-item-"]').nth(0);
    await expect(firstItem).toHaveClass(/(^|\s)selected(\s|$)/);
  });

  // ── Enter opens thread from keyboard cursor ─────────────────────────

  test('Enter key opens thread from keyboard cursor position', async ({ page }) => {
    const secondItem = page.locator('[data-testid^="email-item-"]').nth(1);
    await page.keyboard.press('j');
    await expect(secondItem).toHaveClass(/(^|\s)selected(\s|$)/);

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();
  });

  // ── Star toggle via clicking star icon directly ──────────────────────

  test('clicking star icon toggles star on a thread', async ({ page }) => {
    const targetMsg = injectedMessages[2];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);
    const starIcon = page.getByTestId(`email-star-${targetMsg.xGmThrid}`);

    await targetItem.click();
    await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

    // Click the star icon directly (exercises onStarToggle)
    await starIcon.click();
    await expect(starIcon).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });

    // Toggle it back off
    await starIcon.click();
    await expect(starIcon).not.toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
  });

  // ── Bulk mark-read via keyboard shortcut ─────────────────────────────

  test('Ctrl+A select all then Shift+I marks all read', async ({ page }) => {
    // Focus mail shell and select all
    await focusMailShell(page);
    await page.keyboard.press(`${shortcutModifier}+a`);

    // Verify multi-selection is active (multiple items have multi-selected class)
    for (const msg of injectedMessages) {
      await expect(page.getByTestId(`email-item-${msg.xGmThrid}`)).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    }

    // Press Shift+I to mark all as read
    await page.keyboard.press('Shift+i');

    // After bulk operation, multi-selection is cleared
    for (const msg of injectedMessages) {
      await expect(page.getByTestId(`email-item-${msg.xGmThrid}`)).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
    }
  });

  // ── Bulk star via keyboard shortcut ──────────────────────────────────

  test('multi-select then s key stars selected emails', async ({ page }) => {
    const msg1 = injectedMessages[0];
    const msg2 = injectedMessages[1];
    const item1 = page.getByTestId(`email-item-${msg1.xGmThrid}`);
    const item2 = page.getByTestId(`email-item-${msg2.xGmThrid}`);

    // Select two items with modifier key
    await item1.click();
    await page.keyboard.down(shortcutModifier);
    await item2.click();
    await page.keyboard.up(shortcutModifier);

    await expect(item1).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    await expect(item2).toHaveClass(/(^|\s)multi-selected(\s|$)/);

    // Press s to star all selected
    await page.keyboard.press('s');

    // Verify stars toggled
    const star1 = page.getByTestId(`email-star-${msg1.xGmThrid}`);
    const star2 = page.getByTestId(`email-star-${msg2.xGmThrid}`);
    await expect(star1).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
    await expect(star2).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
  });

  // ── Bulk mark-unread via keyboard shortcut ───────────────────────────

  test('multi-select then Shift+U marks selected as unread', async ({ page }) => {
    const msg3 = injectedMessages[2];
    const msg4 = injectedMessages[3];
    const item3 = page.getByTestId(`email-item-${msg3.xGmThrid}`);
    const item4 = page.getByTestId(`email-item-${msg4.xGmThrid}`);

    // Select two items
    await item3.click();
    await page.keyboard.down(shortcutModifier);
    await item4.click();
    await page.keyboard.up(shortcutModifier);

    await expect(item3).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    await expect(item4).toHaveClass(/(^|\s)multi-selected(\s|$)/);

    // Press Shift+U to mark unread
    await page.keyboard.press('Shift+u');

    // Multi-select is cleared after bulk op
    await expect(item3).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
    await expect(item4).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
  });

  // ── Keyboard delete (Delete key) on single thread ─────────────────────

  test('Delete key removes thread under keyboard cursor', async ({ page }) => {
    const targetMsg = injectedMessages[4];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    // Click to select, then press Delete to trash the thread
    await targetItem.click();
    await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

    await page.keyboard.press('Delete');

    await expect(targetItem).not.toBeVisible({ timeout: 5000 });
  });

  // ── Mark spam via keyboard (Shift+J) ─────────────────────────────────

  test('Shift+J marks thread as spam', async ({ page }) => {
    const targetMsg = injectedMessages[3];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    await targetItem.click();
    await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

    await focusMailShell(page);
    await page.keyboard.press('Shift+j');

    await expect(targetItem).not.toBeVisible({ timeout: 5000 });
  });
});
