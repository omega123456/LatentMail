import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  injectInboxMessage,
  triggerSync,
  waitForEmailSubject,
} from '../infrastructure/helpers';

test.describe('Mail list', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;

  test.beforeAll(async ({ resetApp }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));
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
});
