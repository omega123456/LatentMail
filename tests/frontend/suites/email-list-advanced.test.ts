import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  getShortcutModifier,
  injectInboxMessage,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
  type MessageIdentity,
} from '../infrastructure/helpers';

test.describe('Email list advanced', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  const injectedMessages: MessageIdentity[] = [];

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);
  });

  test('inject 5 emails and verify all render', async ({ page, electronApp }) => {
    for (let i = 1; i <= 5; i++) {
      const identity = await injectInboxMessage(electronApp, {
        from: `list-sender-${i}@example.com`,
        to: seededEmail,
        subject: `List Email ${i}`,
        body: `Body content for list email ${i}.`,
      });
      injectedMessages.push(identity);
    }

    await triggerSync(electronApp, accountId);

    for (let i = 1; i <= 5; i++) {
      await waitForEmailSubject(page, `List Email ${i}`);
    }

    for (const msg of injectedMessages) {
      await expect(page.getByTestId(`email-item-${msg.xGmThrid}`)).toBeVisible();
    }
  });

  test('density toggle cycles through density modes', async ({ page }) => {
    const densityToggle = page.getByTestId('density-toggle');
    const firstEmailItem = page.getByTestId(`email-item-${injectedMessages[0].xGmThrid}`);

    const classBefore = await firstEmailItem.getAttribute('class') ?? '';
    await densityToggle.click();
    await page.waitForTimeout(200);
    const classAfter = await firstEmailItem.getAttribute('class') ?? '';

    expect(classAfter).not.toBe(classBefore);

    await densityToggle.click();
    await densityToggle.click();
  });

  test('layout toggle cycles through modes and restores default', async ({ page }) => {
    const layoutToggle = page.getByTestId('layout-toggle');
    const mailShell = page.locator('.mail-shell');

    await layoutToggle.click();
    await expect(mailShell).toHaveClass(/(^|\s)layout-bottom(\s|$)/);

    await layoutToggle.click();
    await layoutToggle.click();
  });

  test('multi-select with modifier key', async ({ page, electronApp }) => {
    const firstItem = page.getByTestId(`email-item-${injectedMessages[0].xGmThrid}`);
    const thirdItem = page.getByTestId(`email-item-${injectedMessages[2].xGmThrid}`);

    await firstItem.click();

    const modifier = await getShortcutModifier(electronApp);
    await page.keyboard.down(modifier);
    await thirdItem.click();
    await page.keyboard.up(modifier);

    await expect(firstItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    await expect(thirdItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);
  });

  test('multi-select reading pane shows selection state', async ({ page }) => {
    const emptyPane = page.getByTestId('reading-pane-empty');

    await expect(emptyPane).toBeVisible();
    await expect(emptyPane).toContainText('conversations selected');
  });

  test('right-click opens context menu', async ({ page }) => {
    await page.getByTestId('email-list-container').click({ position: { x: 10, y: 10 }, force: true });

    const targetItem = page.getByTestId(`email-item-${injectedMessages[0].xGmThrid}`);
    await targetItem.click({ button: 'right' });

    await expect(page.getByTestId('context-menu')).toBeVisible();
  });

  test('context menu contains expected actions', async ({ page }) => {
    await expect(page.getByTestId('context-action-reply')).toBeVisible();
    await expect(page.getByTestId('context-action-forward')).toBeVisible();
    await expect(page.getByTestId('context-action-delete')).toBeVisible();
  });

  test('escape closes context menu', async ({ page }) => {
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('context-menu')).not.toBeVisible();
  });

  test('navigate to Sent folder shows different content', async ({ page }) => {
    await page.getByTestId('folder-item-[Gmail]/Sent Mail').click();

    const emptyState = page.getByTestId('email-list-empty');
    const firstInjectedSubject = page.getByTestId('email-list-container').getByText('List Email 1', { exact: true });

    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasInboxSubject = await firstInjectedSubject.isVisible().catch(() => false);

    expect(isEmpty || !hasInboxSubject).toBe(true);
  });

  test('click email shows thread subject in reading pane', async ({ page }) => {
    await page.getByTestId('folder-item-INBOX').click();
    await waitForEmailSubject(page, 'List Email 1');

    const targetMessage = injectedMessages[0];
    await page.getByTestId(`email-item-${targetMessage.xGmThrid}`).click();

    await expect(page.getByTestId('thread-subject')).toContainText('List Email 1');
  });

  test('select-all via Ctrl+A selects every email', async ({ page, electronApp }) => {
    await page.getByTestId('folder-item-INBOX').click();
    await waitForEmailSubject(page, 'List Email 1');

    const modifier = await getShortcutModifier(electronApp);

    await page.getByTestId('email-list-container').click();
    await page.keyboard.press(`${modifier}+A`);

    for (const msg of injectedMessages) {
      await expect(page.getByTestId(`email-item-${msg.xGmThrid}`)).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    }
  });

  test('delete key removes selected thread', async ({ page }) => {
    const targetMsg = injectedMessages[0];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    await targetItem.click();
    await page.keyboard.press('Delete');

    await expect(targetItem).not.toBeVisible({ timeout: 5000 });
  });

  test('star toggle via S key', async ({ page }) => {
    const targetMsg = injectedMessages[1];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);
    const starIcon = page.getByTestId(`email-star-${targetMsg.xGmThrid}`);

    await targetItem.click();
    await page.keyboard.press('s');

    await expect(starIcon).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });

    await page.keyboard.press('s');

    await expect(starIcon).not.toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
  });

  test('shift+click range selection', async ({ page }) => {
    const firstItem = page.getByTestId(`email-item-${injectedMessages[1].xGmThrid}`);
    const thirdItem = page.getByTestId(`email-item-${injectedMessages[3].xGmThrid}`);

    await firstItem.click();
    await page.keyboard.down('Shift');
    await thirdItem.click();
    await page.keyboard.up('Shift');

    for (const msg of [injectedMessages[1], injectedMessages[2], injectedMessages[3]]) {
      await expect(page.getByTestId(`email-item-${msg.xGmThrid}`)).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    }
  });

  test('mark read/unread via keyboard shortcut', async ({ page }) => {
    const targetMsg = injectedMessages[1];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    await targetItem.click();
    await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

    await page.keyboard.press('Shift+i');
    await expect(targetItem).not.toHaveClass(/(^|\s)unread(\s|$)/, { timeout: 5000 });

    await page.keyboard.press('Shift+u');
    await expect(targetItem).toHaveClass(/(^|\s)unread(\s|$)/, { timeout: 5000 });
  });
});
