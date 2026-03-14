import { expect, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { DateTime } from 'luxon';

import type {
  ConfigureOllamaPayload,
  InjectEmailPayload,
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

export async function injectEmail(
  electronApp: ElectronApplication,
  payload: InjectEmailPayload,
): Promise<void> {
  const response = await electronApp.evaluate(
    async (_electronApp, evaluatedPayload: InjectEmailPayload) => {
      const testGlobal = globalThis as TestHookGlobal;
      if (testGlobal.testHooks === undefined) {
        throw new Error('global.testHooks is not available in the Electron main process.');
      }

      return await testGlobal.testHooks.injectEmail(evaluatedPayload);
    },
    payload,
  ) as TestHookResponse;

  if (!response.success) {
    throw new Error('injectEmail test hook reported failure.');
  }
}

export async function triggerSync(
  electronApp: ElectronApplication,
  accountId: number,
): Promise<void> {
  const response = await electronApp.evaluate(
    async (_electronApp, payload: TriggerSyncPayload) => {
      const testGlobal = globalThis as TestHookGlobal;
      if (testGlobal.testHooks === undefined) {
        throw new Error('global.testHooks is not available in the Electron main process.');
      }

      return await testGlobal.testHooks.triggerSync(payload);
    },
    { accountId },
  ) as TestHookResponse;

  if (!response.success) {
    throw new Error('triggerSync test hook reported failure.');
  }
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
  const response = await electronApp.evaluate(
    async (_app, evaluatedConfig: ConfigureOllamaPayload) => {
      const testGlobal = globalThis as TestHookGlobal;
      if (testGlobal.testHooks === undefined) {
        throw new Error('global.testHooks is not available in the Electron main process.');
      }

      return await testGlobal.testHooks.configureOllama(evaluatedConfig);
    },
    config,
  ) as TestHookResponse;

  if (!response.success) {
    throw new Error('configureOllama test hook reported failure.');
  }
}

export async function getSmtpCaptured(
  electronApp: ElectronApplication,
): Promise<SmtpCapturedResponse> {
  const response = await electronApp.evaluate(async () => {
    const testGlobal = globalThis as TestHookGlobal;
    if (testGlobal.testHooks === undefined) {
      throw new Error('global.testHooks is not available in the Electron main process.');
    }

    return await testGlobal.testHooks.getSmtpCaptured();
  }) as SmtpCapturedResponse;

  if (!response.success) {
    throw new Error('getSmtpCaptured test hook reported failure.');
  }

  return response;
}
