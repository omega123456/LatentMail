import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  injectInboxMessage,
  simulateNotificationClick,
  simulateNotificationClickDuringHiddenReload,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
} from '../infrastructure/helpers';

test.describe('Notification click', () => {
  test('opens the target thread when notification click happens before the window has fully re-mounted', async ({
    page,
    electronApp,
    resetApp,
  }) => {
    const seeded = extractSeededAccount(await resetApp({ seedAccount: true }));

    await injectInboxMessage(electronApp, {
      from: 'hidden-other@example.com',
      to: seeded.email,
      subject: 'Hidden notification distractor thread',
      body: 'This thread should not be opened by the notification click.',
    });

    const notificationThread = await injectInboxMessage(electronApp, {
      from: 'hidden-notify@example.com',
      to: seeded.email,
      subject: 'Hidden notification should open thread',
      body: 'Notification click should still open the thread when the window has not been opened yet.',
    });

    await triggerSync(electronApp, seeded.accountId);
    await waitForMailShell(page);
    await waitForEmailSubject(page, 'Hidden notification should open thread');

    await simulateNotificationClickDuringHiddenReload(electronApp, {
      accountId: seeded.accountId,
      folder: 'INBOX',
      xGmThrid: notificationThread.xGmThrid,
    });

    await waitForMailShell(page);
    await expect(page.getByTestId('reading-pane-content')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('thread-subject')).toContainText('Hidden notification should open thread');
  });

  test('marks the notification-opened unread thread as read immediately', async ({
    page,
    electronApp,
    resetApp,
  }) => {
    const seeded = extractSeededAccount(await resetApp({ seedAccount: true }));

    await injectInboxMessage(electronApp, {
      from: 'visible-other@example.com',
      to: seeded.email,
      subject: 'Visible notification distractor thread',
      body: 'This distractor thread should stay unread after another notification click.',
    });

    const notificationThread = await injectInboxMessage(electronApp, {
      from: 'visible-notify@example.com',
      to: seeded.email,
      subject: 'Visible notification should mark read',
      body: 'Opening a thread from a notification should mark it read immediately.',
    });

    await triggerSync(electronApp, seeded.accountId);
    await waitForMailShell(page);
    await waitForEmailSubject(page, 'Visible notification should mark read');

    await simulateNotificationClick(electronApp, {
      accountId: seeded.accountId,
      folder: 'INBOX',
      xGmThrid: notificationThread.xGmThrid,
    });

    const openedThread = page.getByTestId(`email-item-${notificationThread.xGmThrid}`);
    await expect(page.getByTestId('reading-pane-content')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('thread-subject')).toContainText('Visible notification should mark read');
    await expect(openedThread).not.toHaveClass(/(^|\s)unread(\s|$)/, { timeout: 10_000 });
  });

  test('grouped notification click still opens the application without a specific thread id', async ({
    page,
    electronApp,
    resetApp,
  }) => {
    const seeded = extractSeededAccount(await resetApp({ seedAccount: true }));

    await injectInboxMessage(electronApp, {
      from: 'grouped-one@example.com',
      to: seeded.email,
      subject: 'Grouped notification one',
      body: 'First grouped-notification message.',
    });
    await injectInboxMessage(electronApp, {
      from: 'grouped-two@example.com',
      to: seeded.email,
      subject: 'Grouped notification two',
      body: 'Second grouped-notification message.',
    });

    await triggerSync(electronApp, seeded.accountId);
    await waitForMailShell(page);
    await waitForEmailSubject(page, 'Grouped notification one');
    await waitForEmailSubject(page, 'Grouped notification two');

    await simulateNotificationClickDuringHiddenReload(electronApp, {
      accountId: seeded.accountId,
      folder: 'INBOX',
    });

    await waitForMailShell(page);
    await expect(page.getByTestId('email-list-container')).toBeVisible({ timeout: 10_000 });
  });
});
