/**
 * email-body-truncation.test.ts — E2E tests for large HTML truncation and Gmail web link
 * in the IMAP body-fetch path (MailParserWorkerService + ImapService).
 */

import { expect } from 'chai';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import { getDatabase, seedTestAccount, triggerSyncAndWait } from '../infrastructure/test-helpers';
import { imapStateInspector } from '../test-main';
import { DatabaseService } from '../../../electron/services/database-service';
import { BodyPrefetchService } from '../../../electron/services/body-prefetch-service';
import { EMAIL_BODY_HTML_MAX_DISPLAY_CHARS } from '../../../electron/utils/email-body-limits';
import { buildGmailThreadWebUrl } from '../../../electron/utils/gmail-thread-web-url';
import { MailParserWorkerService } from '../../../electron/services/mail-parser-worker-service';
import { coerceToBuffer } from '../../../electron/utils/coerce-buffer';

function buildHtmlOnlyEml(innerHtml: string, subject: string): Buffer {
  const eml =
    'From: sender@example.com\r\n' +
    'To: recipient@example.com\r\n' +
    `Subject: ${subject}\r\n` +
    `Message-ID: <${subject.replace(/\s+/g, '-')}@truncation.test>\r\n` +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: text/html; charset=UTF-8\r\n' +
    '\r\n' +
    innerHtml;
  return Buffer.from(eml, 'utf8');
}

function buildMultipartPlainHtmlEml(plain: string, innerHtml: string, subject: string): Buffer {
  const boundary = 'boundary_trunc_001';
  const eml =
    'From: sender@example.com\r\n' +
    'To: recipient@example.com\r\n' +
    `Subject: ${subject}\r\n` +
    `Message-ID: <multipart-${subject.replace(/\s+/g, '-')}@truncation.test>\r\n` +
    'MIME-Version: 1.0\r\n' +
    `Content-Type: multipart/alternative; boundary="${boundary}"\r\n` +
    '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: text/plain; charset=UTF-8\r\n' +
    '\r\n' +
    `${plain}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: text/html; charset=UTF-8\r\n' +
    '\r\n' +
    `${innerHtml}\r\n` +
    `--${boundary}--\r\n`;
  return Buffer.from(eml, 'utf8');
}

describe('Email body truncation and Gmail link', () => {
  it('stores truncated HTML and appends Gmail link after body fetch when HTML exceeds display cap', async function () {
    this.timeout(60_000);

    await quiesceAndRestore();

    const seeded = seedTestAccount({
      email: 'body-trunc-huge@example.com',
      displayName: 'Body Trunc Huge',
    });
    const accountId = seeded.accountId;
    const suiteEmail = seeded.email;

    imapStateInspector.reset();
    imapStateInspector.getServer().addAllowedAccount(suiteEmail);

    const xGmMsgId = '9300000000000999';
    const xGmThrid = '9876543210987654321';
    const paddingLength = 600_000;
    const innerHtml = `<!DOCTYPE html><html><body><p>x</p>${'a'.repeat(paddingLength)}<p>y</p></body></html>`;
    const raw = buildHtmlOnlyEml(innerHtml, 'Huge HTML');

    imapStateInspector.injectMessage('[Gmail]/All Mail', raw, {
      xGmMsgId,
      xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });
    imapStateInspector.injectMessage('INBOX', raw, {
      xGmMsgId,
      xGmThrid,
      xGmLabels: ['\\Inbox'],
    });

    await triggerSyncAndWait(accountId, { timeout: 45_000 });

    const db = DatabaseService.getInstance();
    const needing = db.getEmailsNeedingBodies(accountId, 20);
    expect(needing.some((row) => String(row['xGmMsgId']) === xGmMsgId)).to.equal(
      true,
      'expected huge-html message to need body fetch',
    );

    await BodyPrefetchService.getInstance().fetchAndStoreBodies(accountId, needing);

    const rawDb = getDatabase().getDatabase();
    const row = rawDb
      .prepare(
        'SELECT html_body, text_body FROM emails WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId',
      )
      .get({ accountId, xGmMsgId }) as { html_body: string; text_body: string } | undefined;

    expect(row).to.exist;
    const htmlBody = row!.html_body || '';
    const textBody = row!.text_body || '';

    expect(htmlBody.length).to.be.at.most(
      EMAIL_BODY_HTML_MAX_DISPLAY_CHARS + 500,
      'stored HTML should be truncated plus small footer',
    );
    expect(htmlBody).to.include('View entire message in Gmail');
    const expectedUrl = buildGmailThreadWebUrl(xGmThrid, { authUserEmail: suiteEmail });
    expect(expectedUrl).to.be.a('string');
    expect(htmlBody).to.include(expectedUrl!);
    expect(textBody).to.include('View entire message in Gmail');
    expect(textBody).to.include(expectedUrl!);
  });

  it('derives text from HTML for HTML-only messages after skipHtmlToText path', async function () {
    this.timeout(60_000);

    await quiesceAndRestore();

    const seeded = seedTestAccount({
      email: 'body-trunc-htmlonly@example.com',
      displayName: 'Body Trunc HTML only',
    });
    const accountId = seeded.accountId;
    const suiteEmail = seeded.email;

    imapStateInspector.reset();
    imapStateInspector.getServer().addAllowedAccount(suiteEmail);

    const xGmMsgId = '9300000000000888';
    const xGmThrid = '8765432109876543210';
    const marker = 'UNIQUE_HTML_ONLY_MARKER_XYZ';
    const raw = buildHtmlOnlyEml(`<html><body><p>${marker}</p></body></html>`, 'Small HTML only');

    imapStateInspector.injectMessage('[Gmail]/All Mail', raw, {
      xGmMsgId,
      xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });
    imapStateInspector.injectMessage('INBOX', raw, {
      xGmMsgId,
      xGmThrid,
      xGmLabels: ['\\Inbox'],
    });

    await triggerSyncAndWait(accountId, { timeout: 45_000 });

    const db = DatabaseService.getInstance();
    const needing = db.getEmailsNeedingBodies(accountId, 20);
    await BodyPrefetchService.getInstance().fetchAndStoreBodies(accountId, needing);

    const rawDb = getDatabase().getDatabase();
    const row = rawDb
      .prepare(
        'SELECT html_body, text_body FROM emails WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId',
      )
      .get({ accountId, xGmMsgId }) as { html_body: string; text_body: string } | undefined;

    expect(row).to.exist;
    expect(row!.html_body || '').to.include(marker);
    expect(row!.text_body || '').to.include(marker);
  });

  it('parseTextOnlyMode truncates HTML but does not append Gmail footer (crawl / index path)', async function () {
    this.timeout(30_000);

    await quiesceAndRestore();

    const paddingLength = 600_000;
    const innerHtml = `<html><body>${'b'.repeat(paddingLength)}</body></html>`;
    const raw = buildHtmlOnlyEml(innerHtml, 'Crawl truncation');

    const parsed = await MailParserWorkerService.getInstance().parseTextOnlyMode(coerceToBuffer(raw));

    expect(parsed.bodyTruncated).to.equal(true);
    expect((parsed.htmlBody || '').length).to.be.at.most(EMAIL_BODY_HTML_MAX_DISPLAY_CHARS);
    expect(parsed.htmlBody || '').to.not.include('View entire message in Gmail');
    expect(parsed.textBody || '').to.not.include('View entire message in Gmail');
  });

  it('multipart alternative keeps plain text as textBody when plain part is present', async function () {
    this.timeout(30_000);

    await quiesceAndRestore();

    const plainMarker = 'PLAIN_PART_MARKER_ABC';
    const htmlMarker = 'HTML_PART_SHOULD_NOT_DOMINATE';
    const innerHtml = `<p>${htmlMarker}</p>`;
    const raw = buildMultipartPlainHtmlEml(plainMarker, innerHtml, 'Multipart plain html');

    const parsed = await MailParserWorkerService.getInstance().parseTextOnlyMode(coerceToBuffer(raw));

    expect(parsed.bodyTruncated).to.equal(false);
    expect(parsed.textBody || '').to.include(plainMarker);
    expect(parsed.textBody || '').to.not.include(htmlMarker);
  });
});
