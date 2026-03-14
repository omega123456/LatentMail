import type { Page } from '@playwright/test';
import { DateTime } from 'luxon';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  injectInboxMessage as injectSeededInboxMessage,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
} from '../infrastructure/helpers';

function createUniqueSubject(prefix: string): string {
  return `${prefix} ${DateTime.utc().toMillis()}`;
}

async function injectInboxThread(
  page: Page,
  electronApp: import('playwright').ElectronApplication,
  accountId: number,
  seededEmail: string,
  options: {
    from: string;
    subjectPrefix: string;
    body: string;
    flags?: string[];
  },
): Promise<{ subject: string; xGmThrid: string }> {
  const subject = createUniqueSubject(options.subjectPrefix);
  const messageIdentity = await injectSeededInboxMessage(electronApp, {
    from: options.from,
    to: seededEmail,
    subject,
    body: options.body,
    flags: options.flags,
  });

  await triggerSync(electronApp, accountId);
  await waitForEmailSubject(page, subject);

  return {
    subject,
    xGmThrid: messageIdentity.xGmThrid,
  };
}

async function confirmDialogIfPresent(page: Page): Promise<void> {
  const confirmDialog = page.getByTestId('confirm-dialog');

  if (await confirmDialog.isVisible().catch(() => false)) {
    await page.getByTestId('confirm-dialog-ok').click();
  }
}

async function getInboxUnreadCount(page: Page): Promise<number> {
  return await page.locator('[data-testid^="email-item-"].unread').count();
}

test.describe('Mail mutations', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await triggerSync(electronApp, accountId);
    await waitForMailShell(page);
  });

  test('stars and unstars a thread', async ({ page, electronApp }) => {
    const message = await injectInboxThread(page, electronApp, accountId, seededEmail, {
      from: 'mail-mutations-star@example.com',
      subjectPrefix: 'Mail Mutation Star',
      body: 'This message verifies starring and unstarring from the thread list.',
    });

    const starButton = page.getByTestId(`email-star-${message.xGmThrid}`);

    await expect(starButton).not.toHaveClass(/(^|\s)starred(\s|$)/);

    await starButton.click();
    await expect(starButton).toHaveClass(/(^|\s)starred(\s|$)/);
    await triggerSync(electronApp, accountId);
    await expect(starButton).toHaveClass(/(^|\s)starred(\s|$)/);

    await starButton.click();
    await expect(starButton).not.toHaveClass(/(^|\s)starred(\s|$)/);
    await triggerSync(electronApp, accountId);
    await expect(starButton).not.toHaveClass(/(^|\s)starred(\s|$)/);
  });

  test('deletes a thread via the action ribbon', async ({ page, electronApp }) => {
    const message = await injectInboxThread(page, electronApp, accountId, seededEmail, {
      from: 'mail-mutations-delete@example.com',
      subjectPrefix: 'Mail Mutation Delete',
      body: 'This message verifies delete from the action ribbon.',
    });

    const threadItem = page.getByTestId(`email-item-${message.xGmThrid}`);

    await threadItem.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    await page.getByTestId('action-ribbon-standard').getByTestId('action-delete').click();
    await confirmDialogIfPresent(page);

    await expect(threadItem).toBeHidden({ timeout: 5000 });
    await triggerSync(electronApp, accountId);

    await page.getByTestId('folder-item-[Gmail]/Trash').click();
    await expect(page.getByTestId('email-list-header')).toContainText('Trash');
    await expect(threadItem).toBeVisible({ timeout: 5000 });

    await triggerSync(electronApp, accountId);
    await expect(page.getByTestId('email-list-header')).toContainText('Trash');
    await expect(threadItem).toBeVisible({ timeout: 5000 });

    await page.getByTestId('folder-item-INBOX').click();
    await expect(page.getByTestId('email-list-header')).toContainText('Inbox');
  });

  test('marks a thread as read/unread', async ({ page, electronApp }) => {
    const unreadCountBeforeRead = await getInboxUnreadCount(page);
    const message = await injectInboxThread(page, electronApp, accountId, seededEmail, {
      from: 'mail-mutations-read@example.com',
      subjectPrefix: 'Mail Mutation Read Unread',
      body: 'This message verifies read and unread toggling.',
      flags: [],
    });

    const threadItem = page.getByTestId(`email-item-${message.xGmThrid}`);

    await expect(threadItem).toHaveClass(/(^|\s)unread(\s|$)/);

    await threadItem.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();
    await expect(threadItem).not.toHaveClass(/(^|\s)unread(\s|$)/);
    await triggerSync(electronApp, accountId);
    await expect(threadItem).not.toHaveClass(/(^|\s)unread(\s|$)/);

    await expect.poll(async () => {
      return await getInboxUnreadCount(page);
    }, { timeout: 30_000 }).toBe(unreadCountBeforeRead);

    await threadItem.click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();

    await page.getByTestId('context-action-mark-read-unread').click();
    await expect(threadItem).toHaveClass(/(^|\s)unread(\s|$)/);
    await triggerSync(electronApp, accountId);
    await expect(threadItem).toHaveClass(/(^|\s)unread(\s|$)/);
    await expect.poll(async () => {
      return await getInboxUnreadCount(page);
    }, { timeout: 30_000 }).toBe(unreadCountBeforeRead + 1);
  });

  test('moves a thread to a different folder via context menu', async ({ page, electronApp }) => {
    const message = await injectInboxThread(page, electronApp, accountId, seededEmail, {
      from: 'mail-mutations-move@example.com',
      subjectPrefix: 'Mail Mutation Move',
      body: 'This message verifies moving a thread to another folder.',
    });

    const threadItem = page.getByTestId(`email-item-${message.xGmThrid}`);

    await threadItem.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    await page.getByTestId('action-ribbon-standard').getByTestId('action-move-to').click();
    await expect(page.getByTestId('move-to-menu')).toBeVisible();

    const trashOption = page.getByTestId('move-to-menu').locator('[data-testid^="move-to-option-"]', {
      hasText: 'Trash',
    });

    await expect(trashOption).toBeVisible();
    await trashOption.click();

    await expect(threadItem).toBeHidden({ timeout: 5000 });

    await page.getByTestId('folder-item-[Gmail]/Trash').click();
    await expect(page.getByTestId('email-list-header')).toContainText('Trash');
    await triggerSync(electronApp, accountId);
    await expect(threadItem).toBeVisible({ timeout: 5000 });
  });
});
