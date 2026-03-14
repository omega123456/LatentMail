import { test, expect } from '../infrastructure/electron-fixture';
import {
  closeCommandPaletteIfOpen,
  discardComposeIfOpen,
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
  injectInboxMessage,
  openCommandPalette,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
} from '../infrastructure/helpers';

test.describe('Keyboard shortcuts', () => {
  test.describe.configure({ mode: 'serial' });

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
