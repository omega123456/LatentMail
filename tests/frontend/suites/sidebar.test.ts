import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  injectInboxMessage,
  injectLogicalMessage,
  navigateToSettings,
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
});
