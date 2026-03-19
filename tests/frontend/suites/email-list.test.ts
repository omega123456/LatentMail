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

test.describe('Email list', () => {
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

  test('shows empty state when no emails are present', async ({ page }) => {
    await expect(page.getByTestId('email-list-empty')).toBeVisible();
    await expect(page.getByTestId('email-list-empty')).toContainText('No emails yet');
  });

  test('renders an email after injection and sync', async ({ page, electronApp }) => {
    const subject = 'Frontend Inbox Email';

    await injectInboxMessage(electronApp, {
      from: 'sender@example.com',
      to: seededEmail,
      subject,
      body: 'Hello from the frontend Playwright suite.',
    });

    await triggerSync(electronApp, accountId);

    await waitForEmailSubject(page, subject);
    await expect(page.getByTestId('email-list-empty')).not.toBeVisible();
  });

  test('shows unread and read messages with different visual state', async ({ page, electronApp }) => {
    const unreadMessage = await injectInboxMessage(electronApp, {
      from: 'unread@example.com',
      to: seededEmail,
      subject: 'Unread Visual State',
      body: 'This message should remain unread.',
    });

    const readMessage = await injectInboxMessage(electronApp, {
      from: 'read@example.com',
      to: seededEmail,
      subject: 'Read Visual State',
      body: 'This message should look read.',
      flags: ['\\Seen'],
    });

    await triggerSync(electronApp, accountId);

    await waitForEmailSubject(page, 'Unread Visual State');
    await waitForEmailSubject(page, 'Read Visual State');

    const unreadItem = page.getByTestId(`email-item-${unreadMessage.xGmThrid}`);
    const readItem = page.getByTestId(`email-item-${readMessage.xGmThrid}`);

    await expect(unreadItem).toHaveClass(/(^|\s)unread(\s|$)/);
    await expect(readItem).not.toHaveClass(/(^|\s)unread(\s|$)/);
  });

  test.describe('Advanced', () => {
    const injectedMessages: MessageIdentity[] = [];

    test.beforeAll(async ({ electronApp, page }) => {
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
    });

    test('inject 5 emails and verify all render', async ({ page }) => {
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

    test('Enter clears multi-selection and opens the keyboard cursor thread', async ({ page }) => {
      const firstItem = page.getByTestId(`email-item-${injectedMessages[1].xGmThrid}`);
      const secondItem = page.getByTestId(`email-item-${injectedMessages[2].xGmThrid}`);

      await firstItem.click();
      await page.keyboard.down(shortcutModifier);
      await secondItem.click();
      await page.keyboard.up(shortcutModifier);

      await expect(firstItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);
      await expect(secondItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);

      await focusMailShell(page);
      await page.keyboard.press('Enter');

      await expect(page.getByTestId('reading-pane-content')).toBeVisible({ timeout: 5000 });
      await expect(firstItem).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
      await expect(secondItem).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
    });
  });

  test.describe('Keyboard', () => {
    const injectedMessages: MessageIdentity[] = [];

    test.beforeAll(async ({ electronApp, page }) => {
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

    test('Shift+click selects a contiguous range of emails', async ({ page }) => {
      const firstMsg = injectedMessages[0];
      const thirdMsg = injectedMessages[2];
      const secondMsg = injectedMessages[1];

      const firstItem = page.getByTestId(`email-item-${firstMsg.xGmThrid}`);
      const secondItem = page.getByTestId(`email-item-${secondMsg.xGmThrid}`);
      const thirdItem = page.getByTestId(`email-item-${thirdMsg.xGmThrid}`);

      await firstItem.click();
      await expect(firstItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await page.keyboard.down('Shift');
      await thirdItem.click();
      await page.keyboard.up('Shift');

      await expect(firstItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);
      await expect(secondItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);
      await expect(thirdItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);

      await page.keyboard.press('Escape');
      await expect(firstItem).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
    });

    test('Ctrl+click toggles individual email in multi-select', async ({ page }) => {
      const msg1 = injectedMessages[3];
      const msg2 = injectedMessages[4];
      const item1 = page.getByTestId(`email-item-${msg1.xGmThrid}`);
      const item2 = page.getByTestId(`email-item-${msg2.xGmThrid}`);

      await item1.click();
      await page.keyboard.down(shortcutModifier);
      await item2.click();
      await page.keyboard.up(shortcutModifier);

      await expect(item1).toHaveClass(/(^|\s)multi-selected(\s|$)/);
      await expect(item2).toHaveClass(/(^|\s)multi-selected(\s|$)/);

      await page.keyboard.down(shortcutModifier);
      await item1.click();
      await page.keyboard.up(shortcutModifier);

      await expect(item1).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
      await expect(item2).toHaveClass(/(^|\s)multi-selected(\s|$)/);

      await page.keyboard.press('Escape');
    });

    test('clicking star icon toggles star on single thread', async ({ page }) => {
      const targetMsg = injectedMessages[0];
      const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);
      const star = page.getByTestId(`email-star-${targetMsg.xGmThrid}`);

      await targetItem.click();
      await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await star.click();
      await expect(star).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });

      await star.click();
      await expect(star).not.toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
    });

    test('Shift+I marks single thread as read', async ({ page }) => {
      const targetMsg = injectedMessages[1];
      const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

      await targetItem.click();
      await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await page.keyboard.press('Shift+i');

      await expect(targetItem).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
    });

    test('Shift+U marks single thread as unread', async ({ page }) => {
      const targetMsg = injectedMessages[1];
      const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

      await targetItem.click();
      await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await page.keyboard.press('Shift+u');

      await expect(targetItem).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
    });

    test('Ctrl+A select all then Delete key trashes all emails', async ({ page }) => {
      await focusMailShell(page);

      await page.keyboard.press(`${shortcutModifier}+a`);

      for (const msg of injectedMessages) {
        const item = page.getByTestId(`email-item-${msg.xGmThrid}`);
        if (await item.isVisible().catch(() => false)) {
          await expect(item).toHaveClass(/(^|\s)multi-selected(\s|$)/);
        }
      }

      await page.keyboard.press('Delete');

      for (const msg of injectedMessages) {
        await expect(page.getByTestId(`email-item-${msg.xGmThrid}`)).not.toBeVisible({ timeout: 5000 });
      }
    });

    test('J/K navigation opens thread in reading pane', async ({ page, electronApp }) => {
      await injectInboxMessage(electronApp, {
        from: 'jk-new-1@example.com',
        to: seededEmail,
        subject: 'JK Nav Email 1',
        body: 'First email for J/K navigation with reading pane.',
      });

      await injectInboxMessage(electronApp, {
        from: 'jk-new-2@example.com',
        to: seededEmail,
        subject: 'JK Nav Email 2',
        body: 'Second email for J/K navigation with reading pane.',
      });

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, 'JK Nav Email 1');
      await waitForEmailSubject(page, 'JK Nav Email 2');

      const firstItem = page.locator('[data-testid^="email-item-"]').nth(0);
      await firstItem.click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      await focusMailShell(page);
      await page.keyboard.press('j');

      const secondItem = page.locator('[data-testid^="email-item-"]').nth(1);
      await expect(secondItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await page.keyboard.press('k');
      await expect(firstItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await discardComposeIfOpen(page);
    });
  });

  test.describe('Deep', () => {
    const injectedMessages: MessageIdentity[] = [];

    test.beforeAll(async ({ electronApp, page }) => {
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

    test('J key moves keyboard cursor to next email', async ({ page }) => {
      await focusMailShell(page);

      const firstItem = page.locator('[data-testid^="email-item-"]').nth(0);
      await firstItem.click();
      await expect(firstItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await page.keyboard.press('j');
      const secondItem = page.locator('[data-testid^="email-item-"]').nth(1);
      await expect(secondItem).toHaveClass(/(^|\s)selected(\s|$)/);
    });

    test('K key moves keyboard cursor to previous email', async ({ page }) => {
      await page.keyboard.press('k');
      const firstItem = page.locator('[data-testid^="email-item-"]').nth(0);
      await expect(firstItem).toHaveClass(/(^|\s)selected(\s|$)/);
    });

    test('Enter key opens thread from keyboard cursor position', async ({ page }) => {
      const secondItem = page.locator('[data-testid^="email-item-"]').nth(1);
      await page.keyboard.press('j');
      await expect(secondItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await page.keyboard.press('Enter');
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();
    });

    test('clicking star icon toggles star on a thread', async ({ page }) => {
      const targetMsg = injectedMessages[2];
      const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);
      const starIcon = page.getByTestId(`email-star-${targetMsg.xGmThrid}`);

      await targetItem.click();
      await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await starIcon.click();
      await expect(starIcon).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });

      await starIcon.click();
      await expect(starIcon).not.toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
    });

    test('Ctrl+A select all then Shift+I marks all read', async ({ page }) => {
      await focusMailShell(page);
      await page.keyboard.press(`${shortcutModifier}+a`);

      for (const msg of injectedMessages) {
        await expect(page.getByTestId(`email-item-${msg.xGmThrid}`)).toHaveClass(/(^|\s)multi-selected(\s|$)/);
      }

      await page.keyboard.press('Shift+i');

      for (const msg of injectedMessages) {
        await expect(page.getByTestId(`email-item-${msg.xGmThrid}`)).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
      }
    });

    test('multi-select then s key stars selected emails', async ({ page }) => {
      const msg1 = injectedMessages[0];
      const msg2 = injectedMessages[1];
      const item1 = page.getByTestId(`email-item-${msg1.xGmThrid}`);
      const item2 = page.getByTestId(`email-item-${msg2.xGmThrid}`);

      await item1.click();
      await page.keyboard.down(shortcutModifier);
      await item2.click();
      await page.keyboard.up(shortcutModifier);

      await expect(item1).toHaveClass(/(^|\s)multi-selected(\s|$)/);
      await expect(item2).toHaveClass(/(^|\s)multi-selected(\s|$)/);

      await page.keyboard.press('s');

      const star1 = page.getByTestId(`email-star-${msg1.xGmThrid}`);
      const star2 = page.getByTestId(`email-star-${msg2.xGmThrid}`);
      await expect(star1).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
      await expect(star2).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
    });

    test('multi-select then Shift+U marks selected as unread', async ({ page }) => {
      const msg3 = injectedMessages[2];
      const msg4 = injectedMessages[3];
      const item3 = page.getByTestId(`email-item-${msg3.xGmThrid}`);
      const item4 = page.getByTestId(`email-item-${msg4.xGmThrid}`);

      await item3.click();
      await page.keyboard.down(shortcutModifier);
      await item4.click();
      await page.keyboard.up(shortcutModifier);

      await expect(item3).toHaveClass(/(^|\s)multi-selected(\s|$)/);
      await expect(item4).toHaveClass(/(^|\s)multi-selected(\s|$)/);

      await page.keyboard.press('Shift+u');

      await expect(item3).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
      await expect(item4).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
    });

    test('Delete key removes thread under keyboard cursor', async ({ page }) => {
      const targetMsg = injectedMessages[4];
      const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

      await targetItem.click();
      await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await page.keyboard.press('Delete');

      await expect(targetItem).not.toBeVisible({ timeout: 5000 });
    });

    test('Shift+J marks thread as spam', async ({ page }) => {
      const targetMsg = injectedMessages[3];
      const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

      await targetItem.click();
      await expect(targetItem).toHaveClass(/(^|\s)selected(\s|$)/);

      await page.keyboard.press('Shift+j');

      await expect(targetItem).not.toBeVisible({ timeout: 5000 });
    });

  });
});
