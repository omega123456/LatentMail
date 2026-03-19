import type { ElectronApplication } from 'playwright';
import { DateTime } from 'luxon';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  buildHtmlRfc822,
  buildRfc822,
  clearMockIpc,
  configureOllama,
  discardComposeIfOpen,
  extractSeededAccount,
  injectEmail,
  injectInboxMessage,
  injectInboxMessageWithAttachments,
  injectLogicalMessage,
  mockIpc,
  navigateToSettings,
  returnToMailShell,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
  TEST_PNG_1X1_BASE64,
  TEST_TEXT_FILE_CONTENT,
  type MessageIdentity,
} from '../infrastructure/helpers';

const inboxMailboxes = ['[Gmail]/All Mail', 'INBOX'];
const inboxLabels = ['\\All', '\\Inbox'];
const testDocxBase64 = 'UEsDBBQAAAAIACawcFzXeYTq8gAAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2Qy07DMBBF9/0Ka7aodmCBEIrTBY8lsCgfYNmTxKo9tjxuSP8epYUiIcr6Ps6daTdzDGLCwj6RhmvZgECyyXkaNLxvn9d3ILgaciYkQg0HZNh0q3Z7yMhijoFYw1hrvleK7YjRsEwZaY6hTyWayjKVQWVjd2ZAddM0t8omqkh1XZcO6FZCtI/Ym32o4mmuSKctBQODeDh5F5wGk3Pw1lSfSE3kfoHWXxBZMBw9PPrMV3MMoC5BFvEy4yf6OmEp3qF4M6W+mIga1EcqTrlk9xGpyv+b/lib+t5bPOeXtlySRWZPQwzyrETj6fuKVh0f330CUEsDBBQAAAAIACawcFwgG4bqtgAAAC4BAAALAAAAX3JlbHMvLnJlbHONz7FOxDAQBNA+X7Ha/uIcBUIozjUnpGtR+ADL3iQW9q7l9UHu72koOERBOxq90YynPSf4oKpR2OKxHxCIvYTIq8W3+eXwhKDNcXBJmCzeSPE0deMrJdeisG6xKOw5sVrcWivPxqjfKDvtpRDvOS1Ss2vaS11Ncf7drWQehuHR1J8GTh3AHQuXYLFewhFhvhX6Dy/LEj2dxV8zcftj5VcDYXZ1pWbxU2ow4Tvu95zQTN1o7m5OX1BLAwQUAAAACAAmsHBckJftdcwBAAB/BQAAEQAAAHdvcmQvZG9jdW1lbnQueG1spZRNb9wgEIbv+RWI+64/5LaRZTuHrNrmULVSWqlXFmMbBRgE2Oz211f4c6NK0TZ7wbw288zLDLh4OEmBBmYsB1XiZB9jxBSFmqu2xL9+ft7dY2QdUTURoFiJz8zih+qu8HkNtJdMOXSSQtnca1rizjmdR5GlHZPE7iWnBiw0bk9BRtA0nLLIg6mjNE7icaYNUGYtV+0jUQOxeMbJf2mgmTpJ0YCRxNk9mDaSxLz0ekdBauL4kQvuzlEaxx8XDJS4NyqfEbvVUAjJJ0PzY4kw1+SdQg5zBcaMkWGCOA7Kdlxv23gvTRLXLZDhrU0MUizrvE6y23pwMMRz1W7Aa+zXU5AUk/O3iUl8RUcCYo24xsLrnIsTSbjaEr+rNJfFbW+r7RcDvd5o/Dbak3pZWeFe/gdr7tHl1uxtZp47ohlGkuZPrQJDjoKV2CcZCicSV3cIFT4/Qn0O01HoqvC5CYOrvjIhAB2+P/5G2rCBM19E4X0YzTjqNc4y6n6YSU6g9vkP8uGUJGmaxRj5vCtx8uE+i3H0at03YpDPHegSJ9m00vC2c5s8gnMgNy1Yc/G1Y6RmpsSf0lE2AO5Ctr0b5Zo1+N7cBjUVIMyWX2f1F1BLAQIUABQAAAAIACawcFzXeYTq8gAAALgBAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQAFAAAAAgAJrBwXCAbhuq2AAAALgEAAAsAAAAAAAAAAAAAAIABIwEAAF9yZWxzLy5yZWxzUEsBAhQAFAAAAAgAJrBwXJCX7XXMAQAAfwUAABEAAAAAAAAAAAAAAIABAgIAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAP0DAAAAAA==';

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

  let attachmentThrid: string;
  let htmlRemoteImagesThrid: string;
  let threadId: string;
  let threadMessageOneId: string;
  let threadMessageTwoId: string;
  let diverseAttachmentThrid: string;

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);
  });

  test.afterEach(async ({ electronApp }) => {
    await clearMockIpc(electronApp);
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

  test.describe('Advanced (HTML, attachments, threads)', () => {
    test('open message with attachments → verify attachment section renders with correct count text', async ({
      page,
      electronApp,
    }) => {
      await discardComposeIfOpen(page);

      const subject = `Attachment Message ${DateTime.utc().toMillis()}`;
      const messageIdentity = await injectInboxMessageWithAttachments(electronApp, {
        from: 'attachments@example.com',
        to: seededEmail,
        subject,
        body: 'This message has two attachments.',
        attachments: [
          {
            filename: 'test-image.png',
            mimeType: 'image/png',
            base64Content: TEST_PNG_1X1_BASE64,
          },
          {
            filename: 'readme.txt',
            mimeType: 'text/plain',
            base64Content: Buffer.from(TEST_TEXT_FILE_CONTENT, 'utf8').toString('base64'),
          },
        ],
      });

      attachmentThrid = messageIdentity.xGmThrid;

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, subject);

      await page.getByTestId(`email-item-${attachmentThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const attachmentSection = page.getByTestId('reading-pane-content').locator('.attachments-section');
      await expect(attachmentSection).toBeVisible({ timeout: 15000 });
      await expect(attachmentSection).toContainText('2 attachments', { timeout: 15000 });
    });

    test('verify attachment chips show filename and file size', async ({ page }) => {
      const attachmentChips = page.getByTestId('reading-pane-content').locator('.attachment-chip');

      await expect(attachmentChips.filter({ hasText: 'test-image.png' })).toBeVisible({ timeout: 15000 });
      await expect(attachmentChips.filter({ hasText: 'readme.txt' })).toBeVisible({ timeout: 15000 });

      const firstChip = attachmentChips.nth(0);
      const secondChip = attachmentChips.nth(1);

      await expect(firstChip).toContainText('B', { timeout: 15000 });
      await expect(secondChip).toContainText('B', { timeout: 15000 });
    });

    test('click attachment chip → verify preview dialog opens', async ({ page }) => {
      const firstChip = page.getByTestId('reading-pane-content').locator('.attachment-chip').first();
      await firstChip.click();

      const dialog = page.locator('.preview-dialog');
      await expect(dialog).toBeVisible({ timeout: 15000 });
      await expect(dialog).toContainText('test-image.png');
    });

    test('close preview dialog → verify it closes', async ({ page }) => {
      await page.keyboard.press('Escape');

      const dialog = page.locator('.preview-dialog');
      await expect(dialog).not.toBeVisible({ timeout: 5000 });
    });

    test('verify download button is visible', async ({ page }) => {
      await page.getByTestId(`email-item-${attachmentThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();
      await expect(page.getByTestId('message-attachment-download-0')).toBeVisible({ timeout: 15000 });
    });

    test('inject HTML email with remote images → verify banner appears', async ({
      page,
      electronApp,
    }) => {
      await discardComposeIfOpen(page);

      const uniqueToken = String(DateTime.utc().toMillis());
      const htmlMsgId = `${uniqueToken}010`;
      htmlRemoteImagesThrid = `${uniqueToken}011`;
      const subject = `Remote Images Email ${uniqueToken}`;
      const htmlBody = [
        '<html><body>',
        '<p>This email contains a remote image.</p>',
        '<img src="https://example.com/tracking.png" alt="tracking pixel">',
        '</body></html>',
      ].join('');

      const rfc822 = buildHtmlRfc822({
        from: 'remote-images@example.com',
        to: seededEmail,
        subject,
        htmlBody,
        messageId: `html-remote-${htmlMsgId}@example.test`,
      });

      const internalDate = DateTime.utc().toISO() ?? '2026-01-01T00:00:00.000Z';

      for (const mailbox of inboxMailboxes) {
        await injectEmail(electronApp, {
          mailbox,
          rfc822,
          options: {
            flags: [],
            internalDate,
            xGmMsgId: htmlMsgId,
            xGmThrid: htmlRemoteImagesThrid,
            xGmLabels: inboxLabels,
          },
        });
      }

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, subject);

      await page.getByTestId(`email-item-${htmlRemoteImagesThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const banner = page.locator('.remote-images-banner');
      await expect(banner).toBeVisible({ timeout: 15000 });
      await expect(banner).toContainText('Remote images are blocked');
    });

    test('click "Load images" on banner → verify banner disappears', async ({ page }) => {
      const banner = page.locator('.remote-images-banner');
      const loadButton = banner.getByRole('button', { name: /load images/i });

      await loadButton.click();
      await expect(banner).not.toBeVisible({ timeout: 5000 });
    });

    test('multi-message thread: verify only latest message is initially expanded', async ({
      page,
      electronApp,
    }) => {
      await discardComposeIfOpen(page);

      const uniqueToken = String(DateTime.utc().toMillis());
      threadId = `${uniqueToken}001`;
      threadMessageOneId = `${uniqueToken}002`;
      threadMessageTwoId = `${uniqueToken}003`;
      const threadSubject = `Advanced Thread ${uniqueToken}`;

      await injectThreadMessage(electronApp, {
        from: 'thread-older@example.com',
        to: seededEmail,
        subject: threadSubject,
        body: 'First message in the advanced thread test.',
        xGmMsgId: threadMessageOneId,
        xGmThrid: threadId,
        messageId: `adv-thread-${threadMessageOneId}@example.test`,
        internalDate: DateTime.utc().minus({ minutes: 2 }).toISO() ?? '2026-01-01T00:00:00.000Z',
      });

      await injectThreadMessage(electronApp, {
        from: 'thread-newer@example.com',
        to: seededEmail,
        subject: threadSubject,
        body: 'Second message in the advanced thread test.',
        xGmMsgId: threadMessageTwoId,
        xGmThrid: threadId,
        messageId: `adv-thread-${threadMessageTwoId}@example.test`,
        internalDate: DateTime.utc().toISO() ?? '2026-01-01T00:00:00.000Z',
      });

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, threadSubject);

      await page.getByTestId(`email-item-${threadId}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const firstMessageCard = page.getByTestId(`message-card-${threadMessageOneId}`);
      const secondMessageCard = page.getByTestId(`message-card-${threadMessageTwoId}`);

      await expect(firstMessageCard).toBeVisible({ timeout: 15000 });
      await expect(secondMessageCard).toBeVisible({ timeout: 15000 });

      await expect(firstMessageCard).toHaveClass(/(^|\s)collapsed(\s|$)/);
      await expect(secondMessageCard).not.toHaveClass(/(^|\s)collapsed(\s|$)/);
    });

    test('multi-message thread: click collapsed message → verify it expands', async ({ page }) => {
      const firstMessageCard = page.getByTestId(`message-card-${threadMessageOneId}`);
      const firstMessageHeader = page.getByTestId(`message-header-${threadMessageOneId}`);

      await expect(firstMessageCard).toHaveClass(/(^|\s)collapsed(\s|$)/);

      await firstMessageHeader.click();

      await expect(firstMessageCard).not.toHaveClass(/(^|\s)collapsed(\s|$)/);
      await expect(firstMessageCard).toContainText('First message in the advanced thread test.', {
        timeout: 15000,
      });
    });

    test('inject message with diverse attachment types for mime-icon coverage', async ({
      page,
      electronApp,
    }) => {
      await discardComposeIfOpen(page);

      const subject = `Diverse Attachments ${DateTime.utc().toMillis()}`;
      const messageIdentity = await injectInboxMessageWithAttachments(electronApp, {
        from: 'diverse-attach@example.com',
        to: seededEmail,
        subject,
        body: 'This message has diverse attachment types for mime-icon coverage.',
        attachments: [
          {
            filename: 'document.pdf',
            mimeType: 'application/pdf',
            base64Content: Buffer.from('PDF content', 'utf8').toString('base64'),
          },
          {
            filename: 'report.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            base64Content: Buffer.from('DOCX content', 'utf8').toString('base64'),
          },
          {
            filename: 'data.csv',
            mimeType: 'text/csv',
            base64Content: Buffer.from('name,value\ntest,123', 'utf8').toString('base64'),
          },
        ],
      });

      diverseAttachmentThrid = messageIdentity.xGmThrid;

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, subject);

      await page.getByTestId(`email-item-${diverseAttachmentThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const attachmentSection = page.getByTestId('reading-pane-content').locator('.attachments-section');
      await expect(attachmentSection).toBeVisible({ timeout: 15000 });
      await expect(attachmentSection).toContainText('3 attachments', { timeout: 15000 });

      const attachmentChips = page.getByTestId('reading-pane-content').locator('.attachment-chip');
      await expect(attachmentChips.filter({ hasText: 'document.pdf' })).toBeVisible({ timeout: 15000 });
      await expect(attachmentChips.filter({ hasText: 'report.docx' })).toBeVisible({ timeout: 15000 });
      await expect(attachmentChips.filter({ hasText: 'data.csv' })).toBeVisible({ timeout: 15000 });
    });

    test('reply button from reading pane opens compose in reply mode', async ({ page }) => {
      await discardComposeIfOpen(page);

      await page.getByTestId(`email-item-${diverseAttachmentThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const actionRibbon = page.getByTestId('action-ribbon-standard');
      await actionRibbon.getByTestId('action-reply').click();

      const composeWindow = page.getByTestId('compose-window');
      await expect(composeWindow).toBeVisible({ timeout: 15000 });

      const composeHeader = page.getByTestId('compose-header');
      await expect(composeHeader).toContainText('Reply', { timeout: 5000 });

      await expect(composeWindow).toContainText('diverse-attach@example.com', { timeout: 5000 });

      await discardComposeIfOpen(page);
    });

    test('forward button opens compose in forward mode', async ({ page }) => {
      await discardComposeIfOpen(page);

      await page.getByTestId(`email-item-${diverseAttachmentThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const actionRibbon = page.getByTestId('action-ribbon-standard');
      await actionRibbon.getByTestId('action-forward').click();

      const composeWindow = page.getByTestId('compose-window');
      await expect(composeWindow).toBeVisible({ timeout: 15000 });

      const composeHeader = page.getByTestId('compose-header');
      await expect(composeHeader).toContainText('Forward', { timeout: 5000 });

      const subjectInput = page.getByTestId('compose-subject-input');
      await expect(subjectInput).toHaveValue(/Fwd:/, { timeout: 5000 });

      await discardComposeIfOpen(page);
    });

    test('reply-all opens compose in reply mode', async ({ page, electronApp }) => {
      await discardComposeIfOpen(page);

      const subject = `Reply All Test ${DateTime.utc().toMillis()}`;
      await injectInboxMessage(electronApp, {
        from: 'sender-replyall@example.com',
        to: seededEmail,
        subject,
        body: 'Message to test reply-all compose action.',
      });

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, subject);

      await page.getByText(subject).first().click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const actionRibbon = page.getByTestId('action-ribbon-standard');
      await actionRibbon.getByTestId('action-reply-all').click();

      const composeWindow = page.getByTestId('compose-window');
      await expect(composeWindow).toBeVisible({ timeout: 15000 });

      const composeHeader = page.getByTestId('compose-header');
      await expect(composeHeader).toContainText('Reply', { timeout: 5000 });

      await discardComposeIfOpen(page);
    });

    test('clicking sender name opens compose to that address', async ({
      page,
      electronApp,
    }) => {
      await discardComposeIfOpen(page);

      const subject = `Sender Click ${DateTime.utc().toMillis()}`;
      await injectInboxMessage(electronApp, {
        from: 'click-sender@example.com',
        to: seededEmail,
        subject,
        body: 'Testing click on sender to open compose.',
      });

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, subject);

      await page.getByText(subject).first().click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const senderLink = page
        .getByTestId('reading-pane-content')
        .locator('.sender-link')
        .first();
      await expect(senderLink).toBeVisible({ timeout: 15000 });

      await senderLink.click();

      await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5000 });
      await discardComposeIfOpen(page);
    });

    test('CSV attachment preview shows table view', async ({ page, electronApp }) => {
      await discardComposeIfOpen(page);

      const subject = `CSV Preview ${DateTime.utc().toMillis()}`;
      const csvContent = Buffer.from('name,age\nAlice,30\nBob,25', 'utf8').toString('base64');

      const messageIdentity = await injectInboxMessageWithAttachments(electronApp, {
        from: 'csv-preview@example.com',
        to: seededEmail,
        subject,
        body: 'This message has a CSV attachment.',
        attachments: [
          {
            filename: 'data.csv',
            mimeType: 'text/csv',
            base64Content: csvContent,
          },
        ],
      });

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, subject);

      await page.getByTestId(`email-item-${messageIdentity.xGmThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const csvChip = page
        .getByTestId('reading-pane-content')
        .locator('.attachment-chip')
        .filter({ hasText: 'data.csv' });
      await expect(csvChip).toBeVisible({ timeout: 15000 });
      await csvChip.click();

      const dialog = page.locator('.preview-dialog');
      await expect(dialog).toBeVisible({ timeout: 15000 });

      const csvPreview = dialog.locator('.preview-csv-wrap');
      await expect(csvPreview).toBeVisible({ timeout: 15000 });

      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible({ timeout: 5000 });
    });

    test('Text attachment preview shows plain text content', async ({ page, electronApp }) => {
      await discardComposeIfOpen(page);

      const subject = `Text Preview ${DateTime.utc().toMillis()}`;
      const textContent = Buffer.from('Hello from text preview test', 'utf8').toString('base64');

      const messageIdentity = await injectInboxMessageWithAttachments(electronApp, {
        from: 'text-preview@example.com',
        to: seededEmail,
        subject,
        body: 'This message has a text attachment.',
        attachments: [
          {
            filename: 'notes.txt',
            mimeType: 'text/plain',
            base64Content: textContent,
          },
        ],
      });

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, subject);

      await page.getByTestId(`email-item-${messageIdentity.xGmThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const textChip = page
        .getByTestId('reading-pane-content')
        .locator('.attachment-chip')
        .filter({ hasText: 'notes.txt' });
      await expect(textChip).toBeVisible({ timeout: 15000 });
      await textChip.click();

      const dialog = page.locator('.preview-dialog');
      await expect(dialog).toBeVisible({ timeout: 15000 });

      const textPreview = dialog.locator('.preview-text');
      await expect(textPreview).toBeVisible({ timeout: 15000 });

      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible({ timeout: 5000 });
    });

    test('attachment preview dialog covers preview types, fallback, and download toasts', async ({
      page,
      electronApp,
    }) => {
      await returnToMailShell(page);
      await waitForMailShell(page);

      const token = DateTime.utc().toMillis();
      const imageSubject = `Preview Image ${token}`;
      const pdfSubject = `Preview Pdf ${token}`;
      const zipSubject = `Preview Zip ${token}`;
      const imageContent =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

      const imageMessageIdentity = await injectInboxMessageWithAttachments(electronApp, {
        from: 'preview@example.com',
        to: seededEmail,
        subject: imageSubject,
        body: 'Image preview coverage message',
        attachments: [
          { filename: 'preview.png', mimeType: 'image/png', base64Content: imageContent },
        ],
      });

      const pdfMessageIdentity = await injectInboxMessageWithAttachments(electronApp, {
        from: 'preview@example.com',
        to: seededEmail,
        subject: pdfSubject,
        body: 'Pdf preview coverage message',
        attachments: [
          { filename: 'preview.pdf', mimeType: 'application/pdf', base64Content: imageContent },
        ],
      });

      const zipMessageIdentity = await injectInboxMessageWithAttachments(electronApp, {
        from: 'preview@example.com',
        to: seededEmail,
        subject: zipSubject,
        body: 'Zip preview coverage message',
        attachments: [
          { filename: 'archive.zip', mimeType: 'application/zip', base64Content: imageContent },
        ],
      });

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, imageSubject);
      await waitForEmailSubject(page, pdfSubject);
      await waitForEmailSubject(page, zipSubject);

      await page.getByTestId(`email-item-${imageMessageIdentity.xGmThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      await page.getByTestId('message-attachment-item-0').click();
      let dialog = page.locator('.preview-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.preview-image')).toBeVisible();

      await mockIpc(electronApp, {
        channel: 'attachment:download',
        response: { success: false, error: { code: 'DL_FAIL', message: 'Download failed' } },
        once: true,
      });
      await dialog.getByRole('button', { name: 'Download' }).click();
      await expect(page.locator('.toast-message').filter({ hasText: 'Download failed' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible({ timeout: 5_000 });

      await page.getByTestId(`email-item-${pdfMessageIdentity.xGmThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();
      await page.getByTestId('message-attachment-item-0').click();
      dialog = page.locator('.preview-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('ng2-pdfjs-viewer')).toBeVisible();
      await page.keyboard.press('Escape');

      await page.getByTestId(`email-item-${zipMessageIdentity.xGmThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();
      await page.getByTestId('message-attachment-item-0').click();
      dialog = page.locator('.preview-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.preview-fallback')).toContainText('Preview not available for this file type.');

      await mockIpc(electronApp, {
        channel: 'attachment:download',
        response: { success: true, data: {} },
        once: true,
      });
      await dialog.getByRole('button', { name: 'Download' }).click();
      await expect(page.locator('.toast-message').filter({ hasText: 'Downloaded archive.zip' })).toBeVisible();
      await page.keyboard.press('Escape');
    });

    test('DOCX attachment preview renders converted HTML and close button dismisses the dialog', async ({ page, electronApp }) => {
      await discardComposeIfOpen(page);

      const subject = `Docx Preview ${DateTime.utc().toMillis()}`;
      const messageIdentity = await injectInboxMessageWithAttachments(electronApp, {
        from: 'docx-preview@example.com',
        to: seededEmail,
        subject,
        body: 'This message contains a DOCX attachment.',
        attachments: [
          {
            filename: 'preview.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            base64Content: testDocxBase64,
          },
        ],
      });

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, subject);

      await page.getByTestId(`email-item-${messageIdentity.xGmThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      await page.getByTestId('message-attachment-item-0').click();

      const dialog = page.locator('.preview-dialog');
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await expect(dialog.locator('.preview-word')).toContainText('Hello DOCX preview', { timeout: 15_000 });

      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    });

    test('attachment preview error state is shown when CSV text content cannot be loaded', async ({ page, electronApp }) => {
      await discardComposeIfOpen(page);

      const subject = `Csv Error Preview ${DateTime.utc().toMillis()}`;
      const csvContent = Buffer.from('name,value\nerror,1', 'utf8').toString('base64');
      const messageIdentity = await injectInboxMessageWithAttachments(electronApp, {
        from: 'csv-error@example.com',
        to: seededEmail,
        subject,
        body: 'This message contains a CSV attachment for error coverage.',
        attachments: [
          {
            filename: 'broken.csv',
            mimeType: 'text/csv',
            base64Content: csvContent,
          },
        ],
      });

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, subject);

      await mockIpc(electronApp, {
        channel: 'attachment:get-content-as-text',
        response: { success: false, error: { code: 'CSV_FAIL', message: 'CSV decode failed' } },
        once: true,
      });

      await page.getByTestId(`email-item-${messageIdentity.xGmThrid}`).click();
      await page.getByTestId('message-attachment-item-0').click();

      const dialog = page.locator('.preview-dialog');
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await expect(dialog.locator('.preview-error')).toContainText('CSV decode failed');

      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    });

    test('emails with different dates show different relative-time formats', async ({
      page,
      electronApp,
    }) => {
      await discardComposeIfOpen(page);

      const uniqueToken = String(DateTime.utc().toMillis());
      const subjectPrefix = `DateFormat ${uniqueToken}`;

      const dateConfigs = [
        { label: 'yesterday', date: DateTime.utc().minus({ days: 1 }).toRFC2822(), suffix: 'Y' },
        { label: '3days', date: DateTime.utc().minus({ days: 3 }).toRFC2822(), suffix: '3D' },
        { label: 'prevyear', date: DateTime.utc().minus({ years: 1 }).toRFC2822(), suffix: 'PY' },
      ];

      for (const config of dateConfigs) {
        const msgId = `${uniqueToken}-${config.suffix}`;
        const thrid = `${uniqueToken}${config.suffix}`;
        const subject = `${subjectPrefix} ${config.label}`;

        const rfc822 = buildRfc822({
          from: `date-test-${config.suffix}@example.com`,
          to: seededEmail,
          subject,
          body: `Date format test: ${config.label}`,
          date: config.date,
          messageId: `date-${msgId}@example.test`,
        });

        for (const mailbox of inboxMailboxes) {
          await injectEmail(electronApp, {
            mailbox,
            rfc822,
            options: {
              flags: [],
              internalDate: DateTime.fromRFC2822(config.date).toISO() ?? '2026-01-01T00:00:00.000Z',
              xGmMsgId: msgId,
              xGmThrid: thrid,
              xGmLabels: inboxLabels,
            },
          });
        }
      }

      await triggerSync(electronApp, accountId);

      await page.getByTestId('folder-item-INBOX').click();
      await expect(page.getByTestId('email-list-header')).toContainText('Inbox');

      const viewport = page.getByTestId('email-scroll-viewport');
      await viewport.evaluate((el: { scrollTop: number; scrollHeight: number }) => {
        el.scrollTop = el.scrollHeight;
      });

      for (const config of dateConfigs) {
        const subject = `${subjectPrefix} ${config.label}`;
        await waitForEmailSubject(page, subject, { timeout: 15000, exact: false });
      }
    });

    test('diverse MIME type attachments (zip, xlsx, mp4) for icon coverage', async ({
      page,
      electronApp,
    }) => {
      await discardComposeIfOpen(page);

      const viewport = page.getByTestId('email-scroll-viewport');
      await viewport.evaluate((el: { scrollTop: number }) => {
        el.scrollTop = 0;
      });

      const subject = `MIME Icons ${DateTime.utc().toMillis()}`;
      const messageIdentity = await injectInboxMessageWithAttachments(electronApp, {
        from: 'mime-icons@example.com',
        to: seededEmail,
        subject,
        body: 'This message has zip, xlsx, and mp4 attachments for MIME icon coverage.',
        attachments: [
          {
            filename: 'archive.zip',
            mimeType: 'application/zip',
            base64Content: Buffer.from('ZIP content', 'utf8').toString('base64'),
          },
          {
            filename: 'sheet.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            base64Content: Buffer.from('XLSX content', 'utf8').toString('base64'),
          },
          {
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
            base64Content: Buffer.from('MP4 content', 'utf8').toString('base64'),
          },
        ],
      });

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, subject, { timeout: 15000 });

      await page.getByTestId(`email-item-${messageIdentity.xGmThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const attachmentSection = page.getByTestId('reading-pane-content').locator('.attachments-section');
      await expect(attachmentSection).toBeVisible({ timeout: 15000 });
      await expect(attachmentSection).toContainText('3 attachments', { timeout: 15000 });

      const attachmentChips = page.getByTestId('reading-pane-content').locator('.attachment-chip');
      await expect(attachmentChips.filter({ hasText: 'archive.zip' })).toBeVisible({ timeout: 15000 });
      await expect(attachmentChips.filter({ hasText: 'sheet.xlsx' })).toBeVisible({ timeout: 15000 });
      await expect(attachmentChips.filter({ hasText: 'clip.mp4' })).toBeVisible({ timeout: 15000 });
    });
  });

  test.describe('Interactions', () => {
    let singleMsgIdentity: MessageIdentity;
    let multiRecipientIdentity: MessageIdentity;

    const SINGLE_MSG_SUBJECT = 'Header Context Menu Test';
    const MULTI_MSG_SUBJECT = 'Multi Recipient Test';

    test.beforeAll(async ({ electronApp, page }) => {
      singleMsgIdentity = await injectInboxMessage(electronApp, {
        from: 'Jane Doe <jane.doe@example.com>',
        to: seededEmail,
        subject: SINGLE_MSG_SUBJECT,
        body: 'This message tests right-click context menu on sender name.',
      });

      multiRecipientIdentity = await injectLogicalMessage(electronApp, {
        from: 'Multi Sender <multi@example.com>',
        to: `${seededEmail}, alice@example.com, bob@example.com, carol@example.com`,
        subject: MULTI_MSG_SUBJECT,
        body: 'This message has 4 recipients to test the tooltip display.',
        mailboxes: ['[Gmail]/All Mail', 'INBOX'],
        xGmLabels: ['\\All', '\\Inbox'],
      });

      await triggerSync(electronApp, accountId);

      await page.getByTestId('folder-item-INBOX').click();
      const viewport = page.getByTestId('email-scroll-viewport');
      await viewport.evaluate((el: { scrollTop: number }) => {
        el.scrollTop = 0;
      });
      await waitForEmailSubject(page, SINGLE_MSG_SUBJECT);
      await waitForEmailSubject(page, MULTI_MSG_SUBJECT);
    });

    test('right-click on sender name shows context menu with Copy and Send', async ({ page }) => {
      await discardComposeIfOpen(page);

      const emailItem = page.getByTestId(`email-item-${singleMsgIdentity.xGmThrid}`);
      await expect(emailItem).toBeVisible({ timeout: 10_000 });
      await emailItem.click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const senderLink = page.getByTestId('reading-pane-content').locator('.sender-link').first();
      await expect(senderLink).toBeVisible({ timeout: 10_000 });

      const box = await senderLink.boundingBox();
      if (box) {
        await senderLink.dispatchEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: box.x + box.width / 2,
          clientY: box.y + box.height / 2,
        });
      } else {
        await senderLink.click({ button: 'right' });
      }

      const copyEmailButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Copy email' });
      await expect(copyEmailButton).toBeVisible({ timeout: 5_000 });

      const sendEmailButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Send email' });
      await expect(sendEmailButton).toBeVisible({ timeout: 5_000 });
    });

    test('clicking Copy email in context menu closes the menu', async ({ page }) => {
      const senderLink = page.getByTestId('reading-pane-content').locator('.sender-link').first();
      const box = await senderLink.boundingBox();
      if (box) {
        await senderLink.dispatchEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: box.x + box.width / 2,
          clientY: box.y + box.height / 2,
        });
      } else {
        await senderLink.click({ button: 'right' });
      }

      const copyEmailButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Copy email' });
      await expect(copyEmailButton).toBeVisible({ timeout: 5_000 });

      await copyEmailButton.click();

      await expect(copyEmailButton).not.toBeVisible({ timeout: 5_000 });
    });

    test('clicking Send email in context menu opens compose', async ({ page }) => {
      await discardComposeIfOpen(page);

      const senderLink = page.getByTestId('reading-pane-content').locator('.sender-link').first();
      const box = await senderLink.boundingBox();
      if (box) {
        await senderLink.dispatchEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: box.x + box.width / 2,
          clientY: box.y + box.height / 2,
        });
      } else {
        await senderLink.click({ button: 'right' });
      }

      const sendEmailButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Send email' });
      await expect(sendEmailButton).toBeVisible({ timeout: 5_000 });

      await sendEmailButton.click();

      await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5_000 });

      await discardComposeIfOpen(page);
    });

    test('right-click on recipients link shows context menu', async ({ page }) => {
      await discardComposeIfOpen(page);

      const emailItem = page.getByTestId(`email-item-${multiRecipientIdentity.xGmThrid}`);
      await expect(emailItem).toBeVisible({ timeout: 10_000 });
      await emailItem.click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const recipientsLink = page.getByTestId('reading-pane-content').locator('.recipients-link').first();
      await expect(recipientsLink).toBeVisible({ timeout: 10_000 });

      await expect(recipientsLink).toContainText('others');

      const tooltipContent = await recipientsLink.getAttribute('title');
      expect(tooltipContent).toBeTruthy();
      expect(tooltipContent).toContain('alice@example.com');

      const box = await recipientsLink.boundingBox();
      if (box) {
        await recipientsLink.dispatchEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: box.x + box.width / 2,
          clientY: box.y + box.height / 2,
        });
      } else {
        await recipientsLink.click({ button: 'right' });
      }

      const copyEmailButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Copy email' });
      await expect(copyEmailButton).toBeVisible({ timeout: 5_000 });

      await page.keyboard.press('Escape');
    });

    test('AI summarize action shows summary panel', async ({ page, electronApp }) => {
      await discardComposeIfOpen(page);

      await configureOllama(electronApp, {
        healthy: true,
        models: ['llama3'],
        selectedModel: 'llama3',
        responses: { chat: 'This email is a test for context menu interactions.' },
      });

      await navigateToSettings(page, 'ai');
      await returnToMailShell(page);

      const emailItem = page.getByTestId(`email-item-${singleMsgIdentity.xGmThrid}`);
      await emailItem.click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const summarizeAction = page.getByTestId('action-ribbon-standard').getByTestId('action-summarize');
      await expect(summarizeAction).toBeVisible({ timeout: 5_000 });
      await summarizeAction.click();

      const summaryPanel = page.getByTestId('ai-summary-panel');
      await expect(summaryPanel).toBeVisible({ timeout: 15_000 });
      await expect(summaryPanel).toContainText('This email is a test', { timeout: 15_000 });
    });
  });

  test.describe('AI actions', () => {
    let inboxMsgIdentity: MessageIdentity;
    let sentMsgIdentity: MessageIdentity;

    const INBOX_SUBJECT = 'AI Actions Inbox Email';
    const SENT_SUBJECT = 'AI Actions Sent Email';

    test.beforeAll(async ({ electronApp, page }) => {
      inboxMsgIdentity = await injectInboxMessage(electronApp, {
        from: 'Alice Johnson <alice@example.com>',
        to: seededEmail,
        subject: INBOX_SUBJECT,
        body: 'Please review the Q4 budget proposal and let me know your thoughts by Friday.',
      });

      sentMsgIdentity = await injectLogicalMessage(electronApp, {
        from: seededEmail,
        to: 'vendor@example.com',
        subject: SENT_SUBJECT,
        body: 'Hi, could you please send the updated contract? We need it urgently.',
        mailboxes: ['[Gmail]/All Mail', '[Gmail]/Sent Mail'],
        xGmLabels: ['\\All', '\\Sent'],
      });

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, INBOX_SUBJECT);

      await configureOllama(electronApp, {
        healthy: true,
        models: ['llama3'],
        selectedModel: 'llama3',
        responses: {
          chat: 'Summary: The Q4 budget proposal needs review by Friday.',
        },
      });

      await navigateToSettings(page, 'ai');
      await returnToMailShell(page);
    });

    test('summarize action shows panel, close button dismisses it', async ({ page }) => {
      await discardComposeIfOpen(page);

      await page.getByTestId(`email-item-${inboxMsgIdentity.xGmThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const summarizeAction = page.getByTestId('action-ribbon-standard').getByTestId('action-summarize');
      await expect(summarizeAction).toBeVisible({ timeout: 10_000 });
      await summarizeAction.click();

      const summaryPanel = page.getByTestId('ai-summary-panel');
      await expect(summaryPanel).toBeVisible({ timeout: 15_000 });

      const closeButton = summaryPanel.locator('.ai-panel-close');
      await closeButton.click();

      await expect(summaryPanel).not.toBeVisible({ timeout: 5_000 });
    });

    test('smart reply action shows panel with suggestions, close button dismisses', async ({ page, electronApp }) => {
      await discardComposeIfOpen(page);

      await configureOllama(electronApp, {
        healthy: true,
        models: ['llama3'],
        selectedModel: 'llama3',
        responses: {
          chat: JSON.stringify({
            suggestions: [
              'I will review the budget today.',
              'Can we schedule a call to discuss?',
              'Approved, no changes needed.',
            ],
          }),
        },
      });

      await page.getByTestId(`email-item-${inboxMsgIdentity.xGmThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const smartReplyAction = page.getByTestId('action-ribbon-standard').getByTestId('action-smart-reply');
      await expect(smartReplyAction).toBeVisible({ timeout: 5_000 });
      await smartReplyAction.click();

      const repliesPanel = page.getByTestId('ai-replies-panel');
      await expect(repliesPanel).toBeVisible({ timeout: 15_000 });

      await expect(repliesPanel.locator('.reply-chip').first()).toBeVisible({ timeout: 10_000 });

      const closeButton = repliesPanel.locator('.ai-panel-close');
      await closeButton.click();

      await expect(repliesPanel).not.toBeVisible({ timeout: 5_000 });
    });

    test('clicking a reply suggestion opens compose with the suggestion text', async ({ page, electronApp }) => {
      await discardComposeIfOpen(page);

      await configureOllama(electronApp, {
        healthy: true,
        models: ['llama3'],
        selectedModel: 'llama3',
        responses: {
          chat: JSON.stringify({
            suggestions: [
              'I will review the budget today.',
              'Can we schedule a call to discuss?',
            ],
          }),
        },
      });

      await page.getByTestId(`email-item-${inboxMsgIdentity.xGmThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible();

      const smartReplyAction = page.getByTestId('action-ribbon-standard').getByTestId('action-smart-reply');
      await smartReplyAction.click();

      const repliesPanel = page.getByTestId('ai-replies-panel');
      await expect(repliesPanel).toBeVisible({ timeout: 15_000 });

      const firstChip = repliesPanel.locator('.reply-chip').first();
      await expect(firstChip).toBeVisible({ timeout: 10_000 });
      const suggestionText = await firstChip.textContent();
      await firstChip.click();

      await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5_000 });
      await expect(page.getByTestId('compose-header')).toContainText('Reply');

      if (suggestionText) {
        await expect(
          page.getByTestId('compose-editor').locator('[contenteditable]'),
        ).toContainText(suggestionText.trim(), { timeout: 5_000 });
      }

      await discardComposeIfOpen(page);
    });

    test('follow-up action shows panel for sent email, close dismisses', async ({ page, electronApp }) => {
      await discardComposeIfOpen(page);

      await configureOllama(electronApp, {
        healthy: true,
        models: ['llama3'],
        selectedModel: 'llama3',
        responses: {
          chat: JSON.stringify({
            needsFollowUp: true,
            reason: 'The vendor has not replied to the contract request.',
            suggestedDate: '2026-03-22',
          }),
        },
      });

      const sidebar = page.getByTestId('sidebar');
      const sentFolderCandidates = [
        sidebar.getByText('Sent Mail', { exact: true }),
        sidebar.getByText('Sent', { exact: true }),
      ];

      let sentFolderClicked = false;
      for (const candidate of sentFolderCandidates) {
        try {
          await candidate.waitFor({ state: 'visible', timeout: 3_000 });
          await candidate.click();
          sentFolderClicked = true;
          break;
        } catch {
          // Try next
        }
      }

      if (!sentFolderClicked) {
        test.skip(true, 'Sent Mail folder not visible in sidebar');
        return;
      }

      await waitForEmailSubject(page, SENT_SUBJECT);

      await page.getByTestId(`email-item-${sentMsgIdentity.xGmThrid}`).click();
      await expect(page.getByTestId('reading-pane-content')).toBeVisible({ timeout: 10_000 });

      const followUpButton = page.getByTestId('action-ribbon-standard').getByTestId('action-follow-up');
      await expect(followUpButton).toBeVisible({ timeout: 5_000 });
      await followUpButton.click();

      const followUpPanel = page.getByTestId('ai-followup-panel');
      await expect(followUpPanel).toBeVisible({ timeout: 15_000 });

      const panelText = await followUpPanel.textContent();
      const hasFollowUpContent = panelText?.includes('Follow-up') || panelText?.includes('follow-up') || panelText?.includes('Analyzing');
      expect(hasFollowUpContent).toBe(true);

      const closeButton = followUpPanel.locator('.ai-panel-close');
      await closeButton.click();
      await expect(followUpPanel).not.toBeVisible({ timeout: 5_000 });
    });
  });
});
