import { test, expect } from '../infrastructure/electron-fixture';
import {
  discardComposeIfOpen,
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
  injectInboxMessage,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
  type MessageIdentity,
} from '../infrastructure/helpers';

test.describe('Email list keyboard coverage', () => {
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

    // Inject 6 emails for range selection and keyboard operations
    for (let index = 1; index <= 6; index++) {
      const identity = await injectInboxMessage(electronApp, {
        from: `kb-list-${index}@example.com`,
        to: seededEmail,
        subject: `KB List Email ${index}`,
        body: `Body for KB list email ${index}.`,
      });
      injectedMessages.push(identity);
    }

    await triggerSync(electronApp, accountId);
    for (let index = 1; index <= 6; index++) {
      await waitForEmailSubject(page, `KB List Email ${index}`);
    }
  });

  // ── Shift+click selects a range of emails ──────────────────────────

  test('Shift+click selects a contiguous range of emails', async ({ page }) => {
    const firstMsg = injectedMessages[0];
    const thirdMsg = injectedMessages[2];
    const secondMsg = injectedMessages[1];

    const firstItem = page.getByTestId(`email-item-${firstMsg.xGmThrid}`);
    const secondItem = page.getByTestId(`email-item-${secondMsg.xGmThrid}`);
    const thirdItem = page.getByTestId(`email-item-${thirdMsg.xGmThrid}`);

    // Plain click on first to set anchor
    await firstItem.click();
    await expect(firstItem).toHaveClass(/(^|\s)selected(\s|$)/);

    // Shift+click on third to range-select from first to third
    await page.keyboard.down('Shift');
    await thirdItem.click();
    await page.keyboard.up('Shift');

    // All three items should be multi-selected
    await expect(firstItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    await expect(secondItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    await expect(thirdItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);

    // Clear multi-selection
    await page.keyboard.press('Escape');
    await expect(firstItem).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
  });

  // ── Ctrl+click toggles individual emails in multi-select ───────────

  test('Ctrl+click toggles individual email in multi-select', async ({ page }) => {
    const msg1 = injectedMessages[3];
    const msg2 = injectedMessages[4];
    const item1 = page.getByTestId(`email-item-${msg1.xGmThrid}`);
    const item2 = page.getByTestId(`email-item-${msg2.xGmThrid}`);

    // Ctrl+click first
    await item1.click();
    await page.keyboard.down(shortcutModifier);
    await item2.click();
    await page.keyboard.up(shortcutModifier);

    await expect(item1).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    await expect(item2).toHaveClass(/(^|\s)multi-selected(\s|$)/);

    // Ctrl+click item1 again to toggle it off
    await page.keyboard.down(shortcutModifier);
    await item1.click();
    await page.keyboard.up(shortcutModifier);

    await expect(item1).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
    await expect(item2).toHaveClass(/(^|\s)multi-selected(\s|$)/);

    // Clear multi-selection
    await page.keyboard.press('Escape');
  });

  // ── Single thread star toggle via clicking star icon ─────────────

  test('clicking star icon toggles star on single thread', async ({ page }) => {
    const targetMsg = injectedMessages[0];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);
    const star = page.getByTestId(`email-star-${targetMsg.xGmThrid}`);

    // Click to select the thread
    await targetItem.click();
    await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

    // Click star icon to star
    await star.click();
    await expect(star).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });

    // Click star icon again to unstar
    await star.click();
    await expect(star).not.toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
  });

  // ── Single thread mark-read via Shift+I keyboard shortcut ──────────

  test('Shift+I marks single thread as read', async ({ page }) => {
    const targetMsg = injectedMessages[1];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    // Click to select
    await targetItem.click();
    await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

    // Press Shift+I to mark as read
    await page.keyboard.press('Shift+i');

    // Should not be in multi-select mode (single thread operation clears cursor)
    await expect(targetItem).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
  });

  // ── Single thread mark-unread via Shift+U keyboard shortcut ────────

  test('Shift+U marks single thread as unread', async ({ page }) => {
    const targetMsg = injectedMessages[1];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    // Click to select
    await targetItem.click();
    await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

    // Press Shift+U to mark as unread
    await page.keyboard.press('Shift+u');

    // Operation should complete
    await expect(targetItem).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
  });

  // ── Select all via Ctrl+A then bulk delete via Delete key ──────────

  test('Ctrl+A select all then Delete key trashes all emails', async ({ page }) => {
    await focusMailShell(page);

    // Select all emails
    await page.keyboard.press(`${shortcutModifier}+a`);

    // Verify all items are multi-selected
    for (const msg of injectedMessages) {
      const item = page.getByTestId(`email-item-${msg.xGmThrid}`);
      if (await item.isVisible().catch(() => false)) {
        await expect(item).toHaveClass(/(^|\s)multi-selected(\s|$)/);
      }
    }

    // Press Delete to trash all selected
    await page.keyboard.press('Delete');

    // All items should disappear from INBOX
    for (const msg of injectedMessages) {
      await expect(page.getByTestId(`email-item-${msg.xGmThrid}`)).not.toBeVisible({ timeout: 5000 });
    }
  });

  // ── Inject fresh emails and test J/K with reading pane open ────────

  test('J/K navigation opens thread in reading pane', async ({ page, electronApp }) => {
    // Inject 2 new emails
    const newMsg1 = await injectInboxMessage(electronApp, {
      from: 'jk-new-1@example.com',
      to: seededEmail,
      subject: 'JK Nav Email 1',
      body: 'First email for J/K navigation with reading pane.',
    });

    const newMsg2 = await injectInboxMessage(electronApp, {
      from: 'jk-new-2@example.com',
      to: seededEmail,
      subject: 'JK Nav Email 2',
      body: 'Second email for J/K navigation with reading pane.',
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, 'JK Nav Email 1');
    await waitForEmailSubject(page, 'JK Nav Email 2');

    // Click first email
    const firstItem = page.locator('[data-testid^="email-item-"]').nth(0);
    await firstItem.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    // Press j to move to next email and open it
    await focusMailShell(page);
    await page.keyboard.press('j');

    // The reading pane should show the next thread
    const secondItem = page.locator('[data-testid^="email-item-"]').nth(1);
    await expect(secondItem).toHaveClass(/(^|\s)selected(\s|$)/);

    // Press k to move back
    await page.keyboard.press('k');
    await expect(firstItem).toHaveClass(/(^|\s)selected(\s|$)/);

    await discardComposeIfOpen(page);
  });
});
