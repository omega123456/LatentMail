import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
  injectInboxMessage,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
  discardComposeIfOpen,
  type MessageIdentity,
} from '../infrastructure/helpers';

test.describe('Context menu actions', () => {
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

    // Inject 6 emails for various context menu tests
    for (let index = 1; index <= 6; index++) {
      const identity = await injectInboxMessage(electronApp, {
        from: `ctx-menu-${index}@example.com`,
        to: seededEmail,
        subject: `Context Menu Email ${index}`,
        body: `Body content for context menu email ${index}.`,
      });
      injectedMessages.push(identity);
    }

    await triggerSync(electronApp, accountId);

    for (let index = 1; index <= 6; index++) {
      await waitForEmailSubject(page, `Context Menu Email ${index}`);
    }
  });

  // ── Right-click opens context menu ────────────────────────────────────

  test('right-click on email opens context menu', async ({ page }) => {
    const targetMsg = injectedMessages[0];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    // Right-click to open context menu
    await targetItem.click({ button: 'right' });

    // Context menu should appear
    const contextMenu = page.getByTestId('context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 5000 });

    // Close the menu by pressing Escape
    await page.keyboard.press('Escape');
    await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
  });

  // ── Star via context menu ─────────────────────────────────────────────

  test('star action from context menu toggles star', async ({ page }) => {
    const targetMsg = injectedMessages[0];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    // Open context menu
    await targetItem.click({ button: 'right' });
    const contextMenu = page.getByTestId('context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 5000 });

    // Click star action
    await page.getByTestId('context-action-star').click();

    // Context menu should close
    await expect(contextMenu).not.toBeVisible({ timeout: 3000 });

    // Verify the star state changed
    const starIcon = page.getByTestId(`email-star-${targetMsg.xGmThrid}`);
    await expect(starIcon).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
  });

  // ── Mark read/unread via context menu ─────────────────────────────────

  test('mark read/unread from context menu toggles read state', async ({ page }) => {
    const targetMsg = injectedMessages[1];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    // Open context menu
    await targetItem.click({ button: 'right' });
    const contextMenu = page.getByTestId('context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 5000 });

    // Click mark-read-unread action
    await page.getByTestId('context-action-mark-read-unread').click();
    await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
  });

  // ── Delete via context menu ───────────────────────────────────────────

  test('delete from context menu removes thread', async ({ page }) => {
    const targetMsg = injectedMessages[2];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    // Open context menu
    await targetItem.click({ button: 'right' });
    const contextMenu = page.getByTestId('context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 5000 });

    // Click delete action
    await page.getByTestId('context-action-delete').click();

    // Thread should be removed from the list
    await expect(targetItem).not.toBeVisible({ timeout: 5000 });
  });

  // ── Mark spam via context menu ────────────────────────────────────────

  test('mark spam from context menu moves thread to spam', async ({ page }) => {
    const targetMsg = injectedMessages[3];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    // Open context menu
    await targetItem.click({ button: 'right' });
    const contextMenu = page.getByTestId('context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 5000 });

    // Click mark-spam action
    await page.getByTestId('context-action-mark-spam').click();

    // Thread should be removed from the list
    await expect(targetItem).not.toBeVisible({ timeout: 5000 });
  });

  // ── Reply via context menu opens compose ──────────────────────────────

  test('reply from context menu opens compose window', async ({ page }) => {
    const targetMsg = injectedMessages[4];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    // Click to select and load the thread first
    await targetItem.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible({ timeout: 10000 });

    // Right-click to open context menu
    await targetItem.click({ button: 'right' });
    const contextMenu = page.getByTestId('context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 5000 });

    // Click reply action
    await page.getByTestId('context-action-reply').click();

    // Compose window should open
    await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5000 });

    // Clean up
    await discardComposeIfOpen(page);
  });

  // ── Forward via context menu opens compose ────────────────────────────

  test('forward from context menu opens compose window', async ({ page }) => {
    const targetMsg = injectedMessages[4];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    // Click to select and load the thread first
    await targetItem.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible({ timeout: 10000 });

    // Right-click to open context menu
    await targetItem.click({ button: 'right' });
    const contextMenu = page.getByTestId('context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 5000 });

    // Click forward action
    await page.getByTestId('context-action-forward').click();

    // Compose window should open
    await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5000 });

    // Clean up
    await discardComposeIfOpen(page);
  });

  // ── Reply-all via context menu opens compose ──────────────────────────

  test('reply-all from context menu opens compose window', async ({ page }) => {
    const targetMsg = injectedMessages[4];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    // Click to select and load the thread first
    await targetItem.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible({ timeout: 10000 });

    // Right-click to open context menu
    await targetItem.click({ button: 'right' });
    const contextMenu = page.getByTestId('context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 5000 });

    // Click reply-all action
    await page.getByTestId('context-action-reply-all').click();

    // Compose window should open
    await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5000 });

    // Clean up
    await discardComposeIfOpen(page);
  });

  // ── Multi-select context menu (bulk delete) ───────────────────────────

  test('multi-select context menu delete removes selected threads', async ({ page }) => {
    // Only msg[0], msg[1], msg[4], msg[5] are still in the list (msg[2] deleted, msg[3] spammed)
    const msgA = injectedMessages[0];
    const msgB = injectedMessages[1];
    const itemA = page.getByTestId(`email-item-${msgA.xGmThrid}`);
    const itemB = page.getByTestId(`email-item-${msgB.xGmThrid}`);

    // Select first with click, then Ctrl+click second for multi-select
    await itemA.click();
    await page.keyboard.down(shortcutModifier);
    await itemB.click();
    await page.keyboard.up(shortcutModifier);

    await expect(itemA).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    await expect(itemB).toHaveClass(/(^|\s)multi-selected(\s|$)/);

    // Right-click on one of the selected items
    await itemA.click({ button: 'right' });
    const contextMenu = page.getByTestId('context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 5000 });

    // Delete via context menu (bulk dispatch)
    await page.getByTestId('context-action-delete').click();

    // Both should be removed
    await expect(itemA).not.toBeVisible({ timeout: 5000 });
    await expect(itemB).not.toBeVisible({ timeout: 5000 });
  });

  // ── Escape clears selection ───────────────────────────────────────────

  test('Escape key clears email selection', async ({ page }) => {
    const targetMsg = injectedMessages[4];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    // Click to select
    await targetItem.click();
    await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

    // Press Escape
    await focusMailShell(page);
    await page.keyboard.press('Escape');

    // Selection should be cleared
    await expect(targetItem).not.toHaveClass(/(^|\s)selected(\s|$)/, { timeout: 3000 });
  });

  // ── Shift+click range selection ───────────────────────────────────────

  test('Shift+click selects a range of emails', async ({ page }) => {
    // msg[4] and msg[5] are still in the list
    const msgFirst = injectedMessages[4];
    const msgLast = injectedMessages[5];
    const itemFirst = page.getByTestId(`email-item-${msgFirst.xGmThrid}`);
    const itemLast = page.getByTestId(`email-item-${msgLast.xGmThrid}`);

    // Click first to set anchor
    await itemFirst.click();

    // Shift+click last to select range
    await itemLast.click({ modifiers: ['Shift'] });

    // Both should have multi-selected class
    await expect(itemFirst).toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 3000 });
    await expect(itemLast).toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 3000 });

    // Clear multi-select by pressing Escape
    await focusMailShell(page);
    await page.keyboard.press('Escape');
  });
});
