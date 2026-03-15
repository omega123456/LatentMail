import { expect, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { DateTime } from 'luxon';

import type {
  ConfigureOllamaPayload,
  EmitRendererEventPayload,
  FrontendTestHooks,
  InjectEmailPayload,
  MockIpcPayload,
  SeedQueuePayload,
  SmtpCapturedResponse,
  TestHookGlobal,
  TestHookResponse,
  TriggerSyncPayload,
} from './test-hooks-types';

export interface Rfc822MessageOptions {
  from: string;
  to: string;
  subject: string;
  body: string;
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string | string[];
}

// Reserved for upcoming threaded-conversation frontend suites.
export interface ThreadedMessageOptions {
  from: string;
  to: string;
  subject: string;
  body: string;
}

export interface MessageIdentity {
  messageId: string;
  xGmMsgId: string;
  xGmThrid: string;
}

export interface LogicalMessageOptions {
  from: string;
  to: string;
  subject: string;
  body: string;
  mailboxes: string[];
  xGmLabels: string[];
  flags?: string[];
}

export interface SeededAppContext {
  accountId: number;
  email: string;
}

type FrontendTestHookName = keyof FrontendTestHooks;

export const GMAIL_INBOX_LABELS = ['\\All', '\\Inbox'] as const;
export const GMAIL_ALL_MAIL_MAILBOXES = ['[Gmail]/All Mail', 'INBOX'] as const;

type SettingsSection = 'general' | 'accounts' | 'ai' | 'keyboard' | 'filters' | 'queue' | 'logger';

let messageSequence = 0;

function sanitizeHeaderValue(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

function normalizeBody(body: string): string {
  return body.replace(/\r?\n/g, '\r\n');
}

function ensureMessageId(messageId: string): string {
  if (messageId.startsWith('<') && messageId.endsWith('>')) {
    return messageId;
  }

  return `<${messageId}>`;
}

function buildDefaultMessageId(): string {
  const timestamp = DateTime.utc().toMillis();
  return `<latentmail-test-${timestamp}@example.test>`;
}

export async function waitForMailShell(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('email-list-container')).toBeVisible();
}

export async function waitForEmailSubject(page: Page, subject: string): Promise<void> {
  await expect(
    page.getByTestId('email-list-container').getByText(subject, { exact: true }),
  ).toBeVisible();
}

export async function openCompose(page: Page): Promise<void> {
  await page.getByTestId('compose-button').click();
  await expect(page.getByTestId('compose-window')).toBeVisible();
}

export async function discardComposeIfOpen(page: Page): Promise<void> {
  const composeWindow = page.getByTestId('compose-window');

  if (await composeWindow.isVisible()) {
    await page.getByTestId('compose-discard-button').click();

    const confirmDialog = page.getByTestId('confirm-dialog');
    if (await confirmDialog.isVisible({ timeout: 500 }).catch(() => false)) {
      await page.getByTestId('confirm-dialog-ok').click();
    }

    await expect(composeWindow).not.toBeVisible({ timeout: 5000 });
  }
}

export function getComposeEditor(page: Page) {
  return page.getByTestId('compose-editor').locator('[contenteditable]');
}

export async function waitForComposeEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('compose-window')).toBeVisible();
  await expect(getComposeEditor(page)).toBeVisible({ timeout: 10_000 });
}

// Reserved for Phase 8 keyboard/theme tests.
export async function getPlatform(electronApp: ElectronApplication): Promise<NodeJS.Platform> {
  return await electronApp.evaluate(() => {
    return process.platform;
  });
}

export async function getShortcutModifier(electronApp: ElectronApplication): Promise<'Control' | 'Meta'> {
  const platform = await getPlatform(electronApp);
  return platform === 'darwin' ? 'Meta' : 'Control';
}

export async function focusMailShell(page: Page): Promise<void> {
  await page.getByTestId('email-list-container').click({ position: { x: 10, y: 10 }, force: true }).catch(() => {});
}

export async function openCommandPalette(page: Page, modifier: 'Control' | 'Meta'): Promise<void> {
  await page.keyboard.press(`${modifier}+k`);
  await expect(page.getByTestId('command-palette')).toBeVisible();
}

export async function closeCommandPaletteIfOpen(page: Page): Promise<void> {
  const palette = page.getByTestId('command-palette');

  if (await palette.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible({ timeout: 3000 });
  }
}

export function extractSeededAccount(result: { accountId?: number; email?: string }): SeededAppContext {
  if (result.accountId === undefined || result.email === undefined) {
    throw new Error('resetApp({ seedAccount: true }) did not return account information.');
  }

  return { accountId: result.accountId, email: result.email };
}

function createMessageIdentity(prefix: string): MessageIdentity {
  messageSequence += 1;

  const nowMillis = DateTime.utc().toMillis();
  const safePrefix = prefix.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const sequenceToken = String(messageSequence).padStart(4, '0');
  const token = `${safePrefix}-${nowMillis}-${sequenceToken}`;

  return {
    messageId: `${token}@example.test`,
    xGmMsgId: `${nowMillis}${sequenceToken}01`,
    xGmThrid: `${nowMillis}${sequenceToken}02`,
  };
}

async function invokeFrontendTestHook<TResult>(
  electronApp: ElectronApplication,
  hookName: FrontendTestHookName,
  payload?: unknown,
): Promise<TResult> {
  return await electronApp.evaluate(
    async (_electronApp, evaluatedCall: { hookName: FrontendTestHookName; payload?: unknown }) => {
      const testGlobal = globalThis as TestHookGlobal;
      if (testGlobal.testHooks === undefined) {
        throw new Error('global.testHooks is not available in the Electron main process.');
      }

      const hook = testGlobal.testHooks[evaluatedCall.hookName] as ((value?: unknown) => unknown) | undefined;
      if (hook === undefined) {
        throw new Error(`test hook ${evaluatedCall.hookName} is not available.`);
      }

      return await hook(evaluatedCall.payload);
    },
    { hookName, payload },
  ) as TResult;
}

function assertTestHookSuccess(response: TestHookResponse, hookName: FrontendTestHookName): void {
  if (!response.success) {
    throw new Error(`${hookName} test hook reported failure.`);
  }
}

export async function injectEmail(
  electronApp: ElectronApplication,
  payload: InjectEmailPayload,
): Promise<void> {
  const response = await invokeFrontendTestHook<TestHookResponse>(electronApp, 'injectEmail', payload);
  assertTestHookSuccess(response, 'injectEmail');
}

export async function triggerSync(
  electronApp: ElectronApplication,
  accountId: number,
): Promise<void> {
  const response = await invokeFrontendTestHook<TestHookResponse>(
    electronApp,
    'triggerSync',
    { accountId } satisfies TriggerSyncPayload,
  );
  assertTestHookSuccess(response, 'triggerSync');
}

export function buildRfc822(options: Rfc822MessageOptions): string {
  const messageDate = options.date ?? DateTime.utc().toRFC2822();
  const messageId = options.messageId !== undefined ? ensureMessageId(options.messageId) : buildDefaultMessageId();
  const referencesHeader = Array.isArray(options.references)
    ? options.references.map((reference) => ensureMessageId(reference)).join(' ')
    : options.references !== undefined
      ? ensureMessageId(options.references)
      : undefined;

  const headerLines = [
    `From: ${sanitizeHeaderValue(options.from)}`,
    `To: ${sanitizeHeaderValue(options.to)}`,
    `Subject: ${sanitizeHeaderValue(options.subject)}`,
    `Date: ${sanitizeHeaderValue(messageDate)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];

  if (options.inReplyTo !== undefined) {
    headerLines.push(`In-Reply-To: ${ensureMessageId(options.inReplyTo)}`);
  }

  if (referencesHeader !== undefined) {
    headerLines.push(`References: ${referencesHeader}`);
  }

  const rfc822Message = `${headerLines.join('\r\n')}\r\n\r\n${normalizeBody(options.body)}\r\n`;
  return Buffer.from(rfc822Message, 'utf8').toString('base64');
}

// Reserved for upcoming threaded-conversation frontend suites.
export function buildThreadedRfc822(
  messages: ThreadedMessageOptions[],
  threadId?: string,
): string[] {
  const resolvedThreadId = sanitizeHeaderValue(threadId ?? `thread-${DateTime.utc().toMillis()}`);
  const messageIds = messages.map((_, index) => {
    return `<${resolvedThreadId}-${index + 1}@example.test>`;
  });

  return messages.map((message, index) => {
    const priorMessageIds = messageIds.slice(0, index);

    return buildRfc822({
      ...message,
      date: DateTime.utc().plus({ minutes: index }).toRFC2822(),
      messageId: messageIds[index],
      inReplyTo: index > 0 ? messageIds[index - 1] : undefined,
      references: priorMessageIds.length > 0 ? priorMessageIds : undefined,
    });
  });
}

export async function injectLogicalMessage(
  electronApp: ElectronApplication,
  options: LogicalMessageOptions,
): Promise<MessageIdentity> {
  const messageIdentity = createMessageIdentity(options.subject);
  const internalDate = DateTime.utc().toISO() ?? '2026-01-01T00:00:00.000Z';
  const rfc822 = buildRfc822({
    from: options.from,
    to: options.to,
    subject: options.subject,
    body: options.body,
    messageId: messageIdentity.messageId,
  });

  for (const mailbox of options.mailboxes) {
    await injectEmail(electronApp, {
      mailbox,
      rfc822,
      options: {
        flags: options.flags ?? [],
        internalDate,
        xGmMsgId: messageIdentity.xGmMsgId,
        xGmThrid: messageIdentity.xGmThrid,
        xGmLabels: options.xGmLabels,
      },
    });
  }

  return messageIdentity;
}

export async function injectInboxMessage(
  electronApp: ElectronApplication,
  options: { from: string; to: string; subject: string; body: string; flags?: string[] },
): Promise<MessageIdentity> {
  return injectLogicalMessage(electronApp, {
    ...options,
    mailboxes: [...GMAIL_ALL_MAIL_MAILBOXES],
    xGmLabels: [...GMAIL_INBOX_LABELS],
  });
}

export async function navigateToSettings(page: Page, section: SettingsSection = 'general'): Promise<void> {
  const settingsNav = page.getByTestId('settings-nav');

  if (!(await settingsNav.isVisible().catch(() => false))) {
    await page.getByTestId('settings-link').click();
  }

  await expect(settingsNav).toBeVisible();
  await page.getByTestId(`settings-nav-${section}`).click();
  await expect(page.getByTestId('settings-content')).toBeVisible();
}

export async function ensureOllamaModelSelected(page: Page, modelName = 'llama3'): Promise<void> {
  const modelSelect = page.getByTestId('ai-model-select');

  await expect(page.getByTestId('ai-status-indicator')).toContainText('Connected', { timeout: 10_000 });
  await expect(modelSelect).toBeVisible({ timeout: 10_000 });

  await modelSelect.getByText(modelName, { exact: true }).click();
  await expect(modelSelect.locator('.model-card.selected')).toContainText(modelName);
}

export async function waitForSemanticSearchReady(page: Page): Promise<void> {
  await expect(page.getByTestId('ai-status-indicator')).toContainText('Connected', { timeout: 10_000 });
  await expect(page.getByTestId('ai-index-status')).toContainText('Complete', { timeout: 10_000 });
}

export async function returnToMailShell(page: Page): Promise<void> {
  const backLink = page.getByTestId('settings-back-link');

  if (await backLink.isVisible().catch(() => false)) {
    await backLink.click();
  }

  await expect(page.getByTestId('sidebar')).toBeVisible();
}

export async function getAppliedTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const browserGlobal = globalThis as {
      document?: {
        documentElement?: {
          getAttribute(name: string): string | null;
        };
      };
    };

    return browserGlobal.document?.documentElement?.getAttribute('data-theme') ?? null;
  });
}

export async function configureOllama(
  electronApp: ElectronApplication,
  config: ConfigureOllamaPayload,
): Promise<void> {
  const response = await invokeFrontendTestHook<TestHookResponse>(electronApp, 'configureOllama', config);
  assertTestHookSuccess(response, 'configureOllama');
}

export async function mockIpc(
  electronApp: ElectronApplication,
  payload: MockIpcPayload,
): Promise<void> {
  const response = await invokeFrontendTestHook<TestHookResponse>(electronApp, 'mockIpc', payload);
  assertTestHookSuccess(response, 'mockIpc');
}

export async function clearMockIpc(
  electronApp: ElectronApplication,
  channel?: string,
): Promise<void> {
  const response = await invokeFrontendTestHook<TestHookResponse>(electronApp, 'clearMockIpc', channel);
  assertTestHookSuccess(response, 'clearMockIpc');
}

export async function emitRendererEvent(
  electronApp: ElectronApplication,
  payload: EmitRendererEventPayload,
): Promise<void> {
  const response = await invokeFrontendTestHook<TestHookResponse>(electronApp, 'emitRendererEvent', payload);
  assertTestHookSuccess(response, 'emitRendererEvent');
}

export async function seedQueueState(
  electronApp: ElectronApplication,
  payload: SeedQueuePayload,
): Promise<void> {
  const response = await invokeFrontendTestHook<TestHookResponse>(electronApp, 'seedQueue', payload);
  assertTestHookSuccess(response, 'seedQueue');
}

export const TEST_PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export const TEST_TEXT_FILE_CONTENT = 'Hello from test attachment';

export interface HtmlRfc822MessageOptions {
  from: string;
  to: string;
  subject: string;
  htmlBody: string;
  date?: string;
  messageId?: string;
}

export interface AttachmentPart {
  filename: string;
  mimeType: string;
  base64Content: string;
}

export interface MultipartRfc822MessageOptions {
  from: string;
  to: string;
  subject: string;
  body: string;
  attachments: AttachmentPart[];
  date?: string;
  messageId?: string;
}

export function buildHtmlRfc822(options: HtmlRfc822MessageOptions): string {
  const messageDate = options.date ?? DateTime.utc().toRFC2822();
  const messageId = options.messageId !== undefined ? ensureMessageId(options.messageId) : buildDefaultMessageId();

  const headerLines = [
    `From: ${sanitizeHeaderValue(options.from)}`,
    `To: ${sanitizeHeaderValue(options.to)}`,
    `Subject: ${sanitizeHeaderValue(options.subject)}`,
    `Date: ${sanitizeHeaderValue(messageDate)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];

  const rfc822Message = `${headerLines.join('\r\n')}\r\n\r\n${normalizeBody(options.htmlBody)}\r\n`;
  return Buffer.from(rfc822Message, 'utf8').toString('base64');
}

export function buildMultipartRfc822(options: MultipartRfc822MessageOptions): string {
  const messageDate = options.date ?? DateTime.utc().toRFC2822();
  const messageId = options.messageId !== undefined ? ensureMessageId(options.messageId) : buildDefaultMessageId();
  const boundary = `----=_LatentMailTestBoundary_${DateTime.utc().toMillis()}_${messageSequence++}`;

  const headerLines = [
    `From: ${sanitizeHeaderValue(options.from)}`,
    `To: ${sanitizeHeaderValue(options.to)}`,
    `Subject: ${sanitizeHeaderValue(options.subject)}`,
    `Date: ${sanitizeHeaderValue(messageDate)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  const textPart = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalizeBody(options.body),
  ].join('\r\n');

  const attachmentParts = options.attachments.map((attachment) => {
    return [
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      attachment.base64Content,
    ].join('\r\n');
  });

  const mimeBody = [textPart, ...attachmentParts, `--${boundary}--`].join('\r\n');
  const rfc822Message = `${headerLines.join('\r\n')}\r\n\r\n${mimeBody}\r\n`;
  return Buffer.from(rfc822Message, 'utf8').toString('base64');
}

export async function injectInboxMessageWithAttachments(
  electronApp: ElectronApplication,
  options: {
    from: string;
    to: string;
    subject: string;
    body: string;
    attachments: AttachmentPart[];
  },
): Promise<MessageIdentity> {
  const messageIdentity = createMessageIdentity(options.subject);
  const internalDate = DateTime.utc().toISO() ?? '2026-01-01T00:00:00.000Z';
  const rfc822 = buildMultipartRfc822({
    from: options.from,
    to: options.to,
    subject: options.subject,
    body: options.body,
    attachments: options.attachments,
    messageId: messageIdentity.messageId,
  });

  for (const mailbox of GMAIL_ALL_MAIL_MAILBOXES) {
    await injectEmail(electronApp, {
      mailbox,
      rfc822,
      options: {
        flags: [],
        internalDate,
        xGmMsgId: messageIdentity.xGmMsgId,
        xGmThrid: messageIdentity.xGmThrid,
        xGmLabels: [...GMAIL_INBOX_LABELS],
      },
    });
  }

  return messageIdentity;
}

export async function getSmtpCaptured(
  electronApp: ElectronApplication,
): Promise<SmtpCapturedResponse> {
  const response = await invokeFrontendTestHook<SmtpCapturedResponse>(electronApp, 'getSmtpCaptured');
  assertTestHookSuccess(response, 'getSmtpCaptured');

  return response;
}
