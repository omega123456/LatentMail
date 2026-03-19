import { test, expect } from '../infrastructure/electron-fixture';
import {
  clearMockIpc,
  extractSeededAccount,
  injectInboxMessage,
  injectLogicalMessage,
  mockIpc,
  navigateToSettings,
  returnToMailShell,
  triggerSync,
  waitForEmailSubject,
} from '../infrastructure/helpers';

test.describe('Sidebar', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await triggerSync(electronApp, accountId);
    await expect(page.getByTestId('folder-item-INBOX')).toBeVisible();
  });

  test.afterEach(async ({ electronApp }) => {
    await clearMockIpc(electronApp);
  });

  test('renders system folders in the sidebar', async ({ page }) => {
    await expect(page.getByTestId('folder-item-INBOX')).toBeVisible();
    await expect(page.getByTestId('folder-item-[Gmail]/Sent Mail')).toBeVisible();
    await expect(page.getByTestId('folder-item-[Gmail]/Drafts')).toBeVisible();
  });

  test('changes email list context when a folder is clicked', async ({ page, electronApp }) => {
    const inboxSubject = 'Inbox Sidebar Message';
    const sentSubject = 'Sent Sidebar Message';

    await injectInboxMessage(electronApp, {
      from: 'inbox@example.com',
      to: seededEmail,
      subject: inboxSubject,
      body: 'Inbox content for sidebar navigation.',
    });

    await injectLogicalMessage(electronApp, {
      from: 'sent@example.com',
      to: seededEmail,
      subject: sentSubject,
      body: 'Sent content for sidebar navigation.',
      mailboxes: ['[Gmail]/All Mail', '[Gmail]/Sent Mail'],
      xGmLabels: ['\\All', '\\Sent'],
    });

    await triggerSync(electronApp, accountId);

    await waitForEmailSubject(page, inboxSubject);
    await expect(page.getByTestId('email-list-header')).toContainText('Inbox');

    await page.getByTestId('folder-item-[Gmail]/Sent Mail').click();

    await expect(page.getByTestId('email-list-header')).toContainText('Sent');
    await waitForEmailSubject(page, sentSubject);
    await expect(page.getByText(inboxSubject)).not.toBeVisible();
  });

  test('collapses and expands the sidebar', async ({ page }) => {
    const sidebar = page.getByTestId('sidebar');
    const collapseButton = page.getByTestId('sidebar-collapse-button');

    await expect(sidebar).not.toHaveClass(/(^|\s)collapsed(\s|$)/);

    await collapseButton.click();
    await expect(sidebar).toHaveClass(/(^|\s)collapsed(\s|$)/);

    await collapseButton.click();
    await expect(sidebar).not.toHaveClass(/(^|\s)collapsed(\s|$)/);
  });

  test('renders the labels section', async ({ page }) => {
    await expect(page.getByTestId('labels-section')).toBeVisible();
    await expect(page.getByTestId('create-label-button')).toBeVisible();
  });

  test('navigates to settings from the sidebar', async ({ page }) => {
    await navigateToSettings(page);
    await expect(page.getByTestId('settings-content')).toBeVisible();
  });

  test('manage accounts action in the account switcher opens account settings', async ({ page }) => {
    await returnToMailShell(page);
    await page.getByTestId('account-switcher').locator('.account-trigger').click();
    await page.getByRole('menuitem', { name: 'Manage accounts' }).click();

    await expect(page.getByTestId('settings-content')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('settings-nav-accounts')).toBeVisible();
  });

  test('switching accounts through the account switcher loads the selected account mailbox', async ({ page, electronApp }) => {
    await mockIpc(electronApp, {
      channel: 'auth:get-accounts',
      response: {
        success: true,
        data: [
          {
            id: accountId,
            email: seededEmail,
            displayName: 'Primary Account',
            avatarUrl: null,
            needsReauth: false,
          },
          {
            id: accountId + 1,
            email: 'secondary@example.com',
            displayName: 'Secondary Account',
            avatarUrl: null,
            needsReauth: false,
          },
        ],
      },
      once: true,
    });
    await mockIpc(electronApp, {
      channel: 'mail:get-folders',
      response: {
        success: true,
        data: [
          { id: 101, accountId, gmailLabelId: 'INBOX', name: 'Inbox', type: 'system', unreadCount: 0, totalCount: 1 },
          { id: 102, accountId, gmailLabelId: '[Gmail]/Sent Mail', name: 'Sent', type: 'system', unreadCount: 0, totalCount: 0 },
          { id: 103, accountId, gmailLabelId: '[Gmail]/Drafts', name: 'Drafts', type: 'system', unreadCount: 0, totalCount: 0 },
          { id: 201, accountId: accountId + 1, gmailLabelId: 'INBOX', name: 'Inbox', type: 'system', unreadCount: 0, totalCount: 1 },
          { id: 202, accountId: accountId + 1, gmailLabelId: '[Gmail]/Sent Mail', name: 'Sent', type: 'system', unreadCount: 0, totalCount: 0 },
          { id: 203, accountId: accountId + 1, gmailLabelId: '[Gmail]/Drafts', name: 'Drafts', type: 'system', unreadCount: 0, totalCount: 0 },
        ],
      },
      once: true,
    });
    await mockIpc(electronApp, {
      channel: 'mail:fetch-emails',
      response: {
        success: true,
        data: [
          {
            id: 9001,
            accountId: accountId + 1,
            xGmThrid: 'secondary-thread-1',
            subject: 'Secondary Account Inbox Message',
            fromAddress: 'secondary-sender@example.com',
            fromName: 'Secondary Sender',
            snippet: 'Mailbox content for switched account.',
            lastMessageDate: '2026-03-16T00:00:00.000Z',
            isRead: false,
            isStarred: false,
            hasAttachments: false,
            folder: 'INBOX',
            folders: ['INBOX'],
            messageCount: 1,
          },
        ],
      },
      once: true,
    });

    await navigateToSettings(page, 'accounts');
    await page.getByTestId('settings-back-link').click();
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('account-switcher').locator('.account-trigger').click();
    await page.getByTestId(`account-item-${accountId + 1}`).click();

    await expect(page.getByTestId('email-list-header')).toContainText('Inbox', { timeout: 10_000 });
    await expect(page.getByText('Secondary Account Inbox Message')).toBeVisible({ timeout: 10_000 });
  });
});
