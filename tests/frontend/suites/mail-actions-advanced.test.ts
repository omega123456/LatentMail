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

test.describe('Mail actions advanced', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  const injectedMessages: MessageIdentity[] = [];

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await triggerSync(electronApp, accountId);
    await waitForMailShell(page);

    for (let i = 1; i <= 4; i++) {
      const identity = await injectInboxMessage(electronApp, {
        from: `actions-sender-${i}@example.com`,
        to: seededEmail,
        subject: `Actions Email ${i}`,
        body: `Body content for actions email ${i}.`,
      });
      injectedMessages.push(identity);
    }

    await triggerSync(electronApp, accountId);

    for (let i = 1; i <= 4; i++) {
      await waitForEmailSubject(page, `Actions Email ${i}`);
    }
  });

  test('context menu delete removes email and moves to trash', async ({ page, electronApp }) => {
    const targetMsg = injectedMessages[0];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    await targetItem.click();
    await targetItem.click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();

    await page.getByTestId('context-action-delete').click();
    await expect(targetItem).not.toBeVisible({ timeout: 5000 });

    await page.getByTestId('folder-item-[Gmail]/Trash').click();
    await expect(page.getByTestId('email-list-header')).toContainText('Trash');
    await triggerSync(electronApp, accountId);
    await expect(targetItem).toBeVisible({ timeout: 5000 });

    await page.getByTestId('folder-item-INBOX').click();
    await expect(page.getByTestId('email-list-header')).toContainText('Inbox');
  });

  test('context menu star toggle adds and removes starred class', async ({ page }) => {
    const targetMsg = injectedMessages[1];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);
    const starIcon = page.getByTestId(`email-star-${targetMsg.xGmThrid}`);

    await targetItem.click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.getByTestId('context-action-star').click();

    await expect(starIcon).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });

    await targetItem.click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.getByTestId('context-action-star').click();

    await expect(starIcon).not.toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
  });

  test('context menu mark read/unread toggles unread class', async ({ page }) => {
    const targetMsg = injectedMessages[1];
    const targetItem = page.getByTestId(`email-item-${targetMsg.xGmThrid}`);

    await targetItem.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();
    await expect(targetItem).not.toHaveClass(/(^|\s)unread(\s|$)/, { timeout: 5000 });

    await targetItem.click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.getByTestId('context-action-mark-read-unread').click();

    await expect(targetItem).toHaveClass(/(^|\s)unread(\s|$)/, { timeout: 5000 });
  });

  test('multi-select bulk delete via context menu', async ({ page, electronApp }) => {
    const secondMsg = injectedMessages[1];
    const thirdMsg = injectedMessages[2];
    const secondItem = page.getByTestId(`email-item-${secondMsg.xGmThrid}`);
    const thirdItem = page.getByTestId(`email-item-${thirdMsg.xGmThrid}`);

    const modifier = await getShortcutModifier(electronApp);

    await secondItem.click();
    await page.keyboard.down(modifier);
    await thirdItem.click();
    await page.keyboard.up(modifier);

    await expect(secondItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    await expect(thirdItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);

    await secondItem.click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();

    await page.getByTestId('context-action-delete').click();

    await expect(secondItem).not.toBeVisible({ timeout: 5000 });
    await expect(thirdItem).not.toBeVisible({ timeout: 5000 });
  });

  test('keyboard shortcut g then i navigates to inbox', async ({ page }) => {
    await page.getByTestId('folder-item-[Gmail]/Sent Mail').click();
    await expect(page.getByTestId('email-list-header')).toContainText('Sent');

    await focusMailShell(page);
    await page.keyboard.press('g');
    await page.waitForTimeout(200);
    await page.keyboard.press('i');

    await expect(page.getByTestId('email-list-header')).toContainText('Inbox', { timeout: 5000 });
  });

  test('keyboard shortcut g then s navigates to sent', async ({ page }) => {
    await focusMailShell(page);
    await page.keyboard.press('g');
    await page.waitForTimeout(200);
    await page.keyboard.press('s');

    await expect(page.getByTestId('email-list-header')).toContainText('Sent', { timeout: 5000 });
  });

  test('keyboard shortcut g then d navigates to drafts', async ({ page }) => {
    await focusMailShell(page);
    await page.keyboard.press('g');
    await page.waitForTimeout(200);
    await page.keyboard.press('d');

    await expect(page.getByTestId('email-list-header')).toContainText('Drafts', { timeout: 5000 });
  });

  test('keyboard shortcut r opens reply compose', async ({ page, electronApp }) => {
    await discardComposeIfOpen(page);

    await page.getByTestId('folder-item-INBOX').click();
    await expect(page.getByTestId('email-list-header')).toContainText('Inbox');

    const replyMessage = await injectInboxMessage(electronApp, {
      from: 'actions-reply@example.com',
      to: seededEmail,
      subject: 'Actions Reply Target',
      body: 'This message is used to test the reply keyboard shortcut.',
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, 'Actions Reply Target');

    await page.getByTestId(`email-item-${replyMessage.xGmThrid}`).click();

    await focusMailShell(page);
    await page.keyboard.press('r');

    await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('compose-window')).toContainText('Reply');

    await discardComposeIfOpen(page);
  });

  test('keyboard shortcut f opens forward compose', async ({ page }) => {
    await discardComposeIfOpen(page);

    await focusMailShell(page);
    await page.keyboard.press('f');

    await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('compose-window')).toContainText('Forward');

    await discardComposeIfOpen(page);
  });
});
