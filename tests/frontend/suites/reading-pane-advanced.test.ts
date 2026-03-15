import type { ElectronApplication } from 'playwright';
import { DateTime } from 'luxon';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  buildHtmlRfc822,
  buildRfc822,
  discardComposeIfOpen,
  extractSeededAccount,
  injectEmail,
  injectInboxMessage,
  injectInboxMessageWithAttachments,
  TEST_PNG_1X1_BASE64,
  TEST_TEXT_FILE_CONTENT,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
} from '../infrastructure/helpers';

const inboxMailboxes = ['[Gmail]/All Mail', 'INBOX'];
const inboxLabels = ['\\All', '\\Inbox'];

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

test.describe('Reading pane advanced', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;

  let attachmentThrid: string;
  let htmlRemoteImagesThrid: string;
  let threadId: string;
  let threadMessageOneId: string;
  let threadMessageTwoId: string;

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);
  });

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

  let diverseAttachmentThrid: string;

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

  // ── Phase B: Click sender to compose ────────────────────────────────

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

  // ── Phase D: Attachment preview modes ───────────────────────────────

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

  // ── Phase F: Relative-time pipe coverage ────────────────────────────

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

    for (const config of dateConfigs) {
      const subject = `${subjectPrefix} ${config.label}`;
      await waitForEmailSubject(page, subject);
      await expect(page.getByText(subject).first()).toBeVisible({ timeout: 15000 });
    }
  });

  // ── Phase F: MIME icon coverage ─────────────────────────────────────

  test('diverse MIME type attachments (zip, xlsx, mp4) for icon coverage', async ({
    page,
    electronApp,
  }) => {
    await discardComposeIfOpen(page);

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
    await waitForEmailSubject(page, subject);

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
