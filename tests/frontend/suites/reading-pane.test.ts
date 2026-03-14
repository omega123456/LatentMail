import type { ElectronApplication } from 'playwright';
import { DateTime } from 'luxon';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  buildRfc822,
  discardComposeIfOpen,
  extractSeededAccount,
  injectEmail,
  injectLogicalMessage,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
} from '../infrastructure/helpers';

const inboxMailboxes = ['[Gmail]/All Mail', 'INBOX'];
const inboxLabels = ['\\All', '\\Inbox'];

async function injectAndOpenSingleMessage(
  page: import('@playwright/test').Page,
  electronApp: ElectronApplication,
  accountId: number,
  seededEmail: string,
  subjectPrefix: string,
  fromAddress: string,
  body: string,
): Promise<{ subject: string; fromAddress: string; body: string; xGmThrid: string }> {
  const subject = `${subjectPrefix} ${DateTime.utc().toMillis()}`;
  const messageIdentity = await injectLogicalMessage(electronApp, {
    from: fromAddress,
    to: seededEmail,
    subject,
    body,
    mailboxes: inboxMailboxes,
    xGmLabels: inboxLabels,
  });

  await triggerSync(electronApp, accountId);
  await waitForEmailSubject(page, subject);

  await page.getByTestId(`email-item-${messageIdentity.xGmThrid}`).click();
  await expect(page.getByTestId('reading-pane-content')).toBeVisible();

  return {
    subject,
    fromAddress,
    body,
    xGmThrid: messageIdentity.xGmThrid,
  };
}

async function injectThreadMessage(
  electronApp: ElectronApplication,
  options: {
    from: string;
    to: string;
    subject: string;
    body: string;
    xGmMsgId: string;
    xGmThrid: string;
    messageId: string;
    internalDate: string;
  },
): Promise<void> {
  const rfc822 = buildRfc822({
    from: options.from,
    to: options.to,
    subject: options.subject,
    body: options.body,
    messageId: options.messageId,
  });

  for (const mailbox of inboxMailboxes) {
    await injectEmail(electronApp, {
      mailbox,
      rfc822,
      options: {
        flags: [],
        internalDate: options.internalDate,
        xGmMsgId: options.xGmMsgId,
        xGmThrid: options.xGmThrid,
        xGmLabels: inboxLabels,
      },
    });
  }
}

test.describe('Reading pane', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);
  });

  test('shows empty state when no thread selected', async ({ page }) => {
    await expect(page.getByTestId('reading-pane-empty')).toBeVisible();
  });

  test('displays email content after selecting a thread', async ({ page, electronApp }) => {
    const message = await injectAndOpenSingleMessage(
      page,
      electronApp,
      accountId,
      seededEmail,
      'Reading Pane Subject',
      'reading-pane-subject@example.com',
      'This message verifies the reading pane content view.',
    );

    await expect(page.getByTestId('thread-subject')).toContainText(message.subject);
  });

  test('displays message sender and body', async ({ page, electronApp }) => {
    const message = await injectAndOpenSingleMessage(
      page,
      electronApp,
      accountId,
      seededEmail,
      'Reading Pane Sender Body',
      'reading-pane-sender@example.com',
      'Visible body text for the reading pane sender/body assertion.',
    );

    await expect(page.getByTestId('reading-pane-content')).toContainText(message.fromAddress);
    await expect(page.getByTestId('reading-pane-content')).toContainText(message.body);
  });

  test('shows multi-message thread with expandable messages', async ({ page, electronApp }) => {
    await discardComposeIfOpen(page);

    const uniqueToken = String(DateTime.utc().toMillis());
    const threadId = `${uniqueToken}001`;
    const messageOneId = `${uniqueToken}002`;
    const messageTwoId = `${uniqueToken}003`;
    const threadSubject = `Reading Pane Thread ${uniqueToken}`;
    const firstBody = 'First message in a multi-message thread.';
    const secondBody = 'Second message in a multi-message thread.';

    await injectThreadMessage(electronApp, {
      from: 'thread-one@example.com',
      to: seededEmail,
      subject: threadSubject,
      body: firstBody,
      xGmMsgId: messageOneId,
      xGmThrid: threadId,
      messageId: `reading-pane-thread-${messageOneId}@example.test`,
      internalDate: DateTime.utc().minus({ minutes: 1 }).toISO() ?? '2026-01-01T00:00:00.000Z',
    });

    await injectThreadMessage(electronApp, {
      from: 'thread-two@example.com',
      to: seededEmail,
      subject: threadSubject,
      body: secondBody,
      xGmMsgId: messageTwoId,
      xGmThrid: threadId,
      messageId: `reading-pane-thread-${messageTwoId}@example.test`,
      internalDate: DateTime.utc().toISO() ?? '2026-01-01T00:00:00.000Z',
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, threadSubject);

    await page.getByTestId(`email-item-${threadId}`).click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    const firstMessageCard = page.getByTestId(`message-card-${messageOneId}`);
    const firstMessageHeader = page.getByTestId(`message-header-${messageOneId}`);
    const secondMessageCard = page.getByTestId(`message-card-${messageTwoId}`);

    await expect(firstMessageCard).toBeVisible();
    await expect(secondMessageCard).toBeVisible();
    await expect(firstMessageCard).toHaveClass(/(^|\s)collapsed(\s|$)/);

    await firstMessageHeader.click();

    await expect(firstMessageCard).not.toHaveClass(/(^|\s)collapsed(\s|$)/);
    await expect(firstMessageCard).toContainText(firstBody);
  });

  test('reply button opens compose in reply mode', async ({ page, electronApp }) => {
    await discardComposeIfOpen(page);

    await injectAndOpenSingleMessage(
      page,
      electronApp,
      accountId,
      seededEmail,
      'Reply Action Thread',
      'reply-action@example.com',
      'This message is used to open reply compose mode.',
    );

    await page.getByTestId('action-ribbon-standard').getByTestId('action-reply').click();

    await expect(page.getByTestId('compose-window')).toBeVisible();
    await expect(page.getByTestId('compose-header')).toContainText('Reply');

    await discardComposeIfOpen(page);
  });

  test('forward button opens compose in forward mode', async ({ page, electronApp }) => {
    await discardComposeIfOpen(page);

    await injectAndOpenSingleMessage(
      page,
      electronApp,
      accountId,
      seededEmail,
      'Forward Action Thread',
      'forward-action@example.com',
      'This message is used to open forward compose mode.',
    );

    await page.getByTestId('action-ribbon-standard').getByTestId('action-forward').click();

    await expect(page.getByTestId('compose-window')).toBeVisible();
    await expect(page.getByTestId('compose-header')).toContainText('Forward');

    await discardComposeIfOpen(page);
  });
});
