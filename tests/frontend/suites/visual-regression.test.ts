import type { Locator, Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';

import {
  test,
  expect,
  type ResetAppOptions,
  type ResetAppResult,
} from '../infrastructure/electron-fixture';
import {
  closeCommandPaletteIfOpen,
  configureOllama,
  discardComposeIfOpen,
  ensureOllamaModelSelected,
  extractSeededAccount,
  focusMailShell,
  getAppliedTheme,
  getComposeEditor,
  getShortcutModifier,
  injectInboxMessage,
  navigateToSettings,
  openCommandPalette,
  openCompose,
  returnToMailShell,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
} from '../infrastructure/helpers';

type ResetApp = (options?: ResetAppOptions) => Promise<ResetAppResult>;
type ThemeMode = 'light' | 'dark';
type ShortcutModifier = 'Meta' | 'Control';

interface VisualMessageFixtures {
  primaryThreadId: string;
  primarySubject: string;
}

const screenshotDiffRatio = 0.01;

interface StableScreenshotOptions {
  fullPage?: boolean;
  mask?: Locator[];
}

let accountId = 0;
let seededEmail = '';
let shortcutModifier: ShortcutModifier = 'Control';
let messageFixtures: VisualMessageFixtures = {
  primaryThreadId: '',
  primarySubject: '',
};

function themeLabel(themeMode: ThemeMode): string {
  switch (themeMode) {
    case 'light': {
      return 'Light';
    }
    case 'dark': {
      return 'Dark';
    }
  }
}

function updateSeededState(result: ResetAppResult): void {
  ({ accountId, email: seededEmail } = extractSeededAccount(result));
}

async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserGlobal = globalThis as {
      document?: {
        activeElement?: {
          blur?: () => void;
        } | null;
      };
    };

    const activeElement = browserGlobal.document?.activeElement;
    if (typeof activeElement?.blur === 'function') {
      activeElement.blur();
    }
  });
}

async function waitForStableMailShell(page: Page): Promise<void> {
  await waitForMailShell(page);
  await expect(page.getByTestId('email-list-loading')).toBeHidden();
  await expect(page.getByTestId('compose-button')).toBeVisible();
}

async function openGeneralSettings(page: Page): Promise<void> {
  await discardComposeIfOpen(page);
  await closeCommandPaletteIfOpen(page);
  await navigateToSettings(page, 'general');
  await expect(page.getByTestId('setting-theme')).toBeVisible();
  await page.evaluate(() => {
    const browserGlobal = globalThis as {
      scrollTo?: (x: number, y: number) => void;
    };

    browserGlobal.scrollTo?.(0, 0);
  });
}

async function setTheme(page: Page, themeMode: ThemeMode): Promise<void> {
  await openGeneralSettings(page);
  await page.getByTestId('setting-theme').getByRole('radio', { name: themeLabel(themeMode) }).click();
  await expect.poll(async () => {
    return await getAppliedTheme(page);
  }).toBe(themeMode);
  await blurActiveElement(page);
  await returnToMailShell(page);
  await waitForStableMailShell(page);
}

async function ensureLightTheme(page: Page): Promise<void> {
  const appliedTheme = await getAppliedTheme(page);
  if (appliedTheme !== 'light') {
    await setTheme(page, 'light');
    return;
  }

  await discardComposeIfOpen(page);
  await closeCommandPaletteIfOpen(page);
  await returnToMailShell(page);
  await waitForStableMailShell(page);
}

async function addMaskIfPresent(maskedLocators: Locator[], locator: Locator): Promise<void> {
  if (await locator.count() > 0) {
    maskedLocators.push(locator);
  }
}

async function buildMailShellMasks(page: Page): Promise<Locator[]> {
  const maskedLocators: Locator[] = [];

  await addMaskIfPresent(maskedLocators, page.getByTestId('email-list-timestamp'));
  await addMaskIfPresent(maskedLocators, page.getByTestId('sync-status-indicator'));
  await addMaskIfPresent(maskedLocators, page.getByTestId('sender-avatar'));
  await addMaskIfPresent(maskedLocators, page.getByTestId('account-switcher-avatar'));

  return maskedLocators;
}

async function buildReadingPaneMasks(page: Page): Promise<Locator[]> {
  const maskedLocators: Locator[] = [];

  await addMaskIfPresent(maskedLocators, page.getByTestId('email-list-timestamp'));
  await addMaskIfPresent(maskedLocators, page.getByTestId('message-timestamp'));
  await addMaskIfPresent(maskedLocators, page.getByTestId('sync-status-indicator'));

  return maskedLocators;
}

async function buildComposeMasks(page: Page): Promise<Locator[]> {
  const maskedLocators: Locator[] = [];

  await addMaskIfPresent(maskedLocators, page.getByTestId('compose-from-value'));
  await addMaskIfPresent(maskedLocators, page.getByTestId('compose-save-status'));

  return maskedLocators;
}

async function buildFullMailShellMasks(page: Page): Promise<Locator[]> {
  const maskedLocators: Locator[] = [];

  await addMaskIfPresent(maskedLocators, page.getByTestId('email-list-timestamp'));
  await addMaskIfPresent(maskedLocators, page.getByTestId('message-timestamp'));
  await addMaskIfPresent(maskedLocators, page.getByTestId('sync-status-indicator'));
  await addMaskIfPresent(maskedLocators, page.getByTestId('sender-avatar'));
  await addMaskIfPresent(maskedLocators, page.getByTestId('account-switcher-avatar'));

  return maskedLocators;
}

async function buildLoggerMasks(page: Page): Promise<Locator[]> {
  const maskedLocators: Locator[] = [];

  await addMaskIfPresent(maskedLocators, page.getByTestId('logger-entries'));

  return maskedLocators;
}

async function resetToSeededMailShell(resetApp: ResetApp, page: Page): Promise<void> {
  const result = await resetApp({ seedAccount: true });
  updateSeededState(result);
  await waitForStableMailShell(page);
}

async function prepareMailShellWithEmails(
  resetApp: ResetApp,
  page: Page,
  electronApp: ElectronApplication,
): Promise<void> {
  await resetToSeededMailShell(resetApp, page);
  await ensureLightTheme(page);

  const primaryMessage = await injectInboxMessage(electronApp, {
    from: 'alice.visual@example.com',
    to: seededEmail,
    subject: 'Visual Regression Primary Thread',
    body: 'Primary body content for the visual regression reading pane screenshot.',
  });

  await injectInboxMessage(electronApp, {
    from: 'bravo.visual@example.com',
    to: seededEmail,
    subject: 'Visual Regression Secondary Thread',
    body: 'Secondary body content for the visual regression mail list screenshot.',
    flags: ['\\Seen'],
  });

  messageFixtures = {
    primaryThreadId: primaryMessage.xGmThrid,
    primarySubject: 'Visual Regression Primary Thread',
  };

  await triggerSync(electronApp, accountId);
  await waitForEmailSubject(page, messageFixtures.primarySubject);
  await waitForEmailSubject(page, 'Visual Regression Secondary Thread');
  await expect(page.locator('[data-testid^="email-item-"]')).toHaveCount(2);
  await blurActiveElement(page);
}

async function openPrimaryThread(page: Page): Promise<void> {
  await page.getByTestId('email-item-' + messageFixtures.primaryThreadId).click();
  await expect(page.getByTestId('reading-pane-content')).toBeVisible();
}

async function configureOllamaAndReturnToMailShell(
  page: Page,
  electronApp: ElectronApplication,
  ollamaOptions: Parameters<typeof configureOllama>[1],
): Promise<void> {
  await configureOllama(electronApp, ollamaOptions);
  await navigateToSettings(page, 'ai');
  await ensureOllamaModelSelected(page, ollamaOptions.selectedModel!);
  await returnToMailShell(page);
  await waitForStableMailShell(page);
}

async function openCommandPaletteOverlay(page: Page, modifier: ShortcutModifier): Promise<void> {
  await discardComposeIfOpen(page);
  await closeCommandPaletteIfOpen(page);
  await focusMailShell(page);
  await openCommandPalette(page, modifier);
  await expect(page.getByTestId('command-palette-input')).toBeFocused();
}

async function expectStableScreenshot(
  page: Page,
  screenshotName: string,
  options: StableScreenshotOptions = {},
): Promise<void> {
  await expect(page).toHaveScreenshot(screenshotName, {
    fullPage: options.fullPage,
    scale: 'css',
    maxDiffPixelRatio: screenshotDiffRatio,
    mask: options.mask ?? [],
  });
}

test.describe('Visual regression', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    updateSeededState(result);
    await waitForStableMailShell(page);
    shortcutModifier = await getShortcutModifier(electronApp);
  });

  test('auth landing page', async ({ page, resetApp }) => {
    await resetApp({ seedAccount: false });
    await expect(page.getByTestId('auth-login-button')).toBeVisible();
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'auth-landing.png', {
      fullPage: true,
    });

    await resetToSeededMailShell(resetApp, page);
  });

  test('mail shell with email list (light theme)', async ({ page, electronApp, resetApp }) => {
    await prepareMailShellWithEmails(resetApp, page, electronApp);

    await expectStableScreenshot(page, 'mail-shell-light.png', {
      mask: await buildMailShellMasks(page),
    });
  });

  test('mail shell with email list (dark theme)', async ({ page, electronApp, resetApp }) => {
    await prepareMailShellWithEmails(resetApp, page, electronApp);
    await setTheme(page, 'dark');
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'mail-shell-dark.png', {
      mask: await buildMailShellMasks(page),
    });

    await setTheme(page, 'light');
  });

  test('reading pane with selected thread', async ({ page, electronApp, resetApp }) => {
    await prepareMailShellWithEmails(resetApp, page, electronApp);

    await openPrimaryThread(page);
    await expect(page.getByTestId('thread-subject')).toContainText(messageFixtures.primarySubject);
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'reading-pane-thread.png', {
      mask: await buildReadingPaneMasks(page),
    });
  });

  test('compose window (new message)', async ({ page, resetApp }) => {
    await resetToSeededMailShell(resetApp, page);
    await ensureLightTheme(page);
    await discardComposeIfOpen(page);
    await focusMailShell(page);
    await openCompose(page);
    await expect(getComposeEditor(page)).toBeVisible();
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'compose-window.png', {
      mask: await buildComposeMasks(page),
    });

    await discardComposeIfOpen(page);
  });

  test('settings page (general)', async ({ page, resetApp }) => {
    await resetToSeededMailShell(resetApp, page);
    await ensureLightTheme(page);
    await openGeneralSettings(page);
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'settings-general.png');

    await returnToMailShell(page);
    await waitForStableMailShell(page);
  });

  test('command palette overlay', async ({ page, resetApp }) => {
    await resetToSeededMailShell(resetApp, page);
    await ensureLightTheme(page);
    await openCommandPaletteOverlay(page, shortcutModifier);
    await page.getByTestId('command-palette-input').fill('compose');
    await expect(page.getByTestId('command-palette-results')).toBeVisible();
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'command-palette.png');

    await closeCommandPaletteIfOpen(page);
  });

  test('empty inbox state', async ({ page, resetApp }) => {
    await resetToSeededMailShell(resetApp, page);
    await ensureLightTheme(page);
    await expect(page.getByTestId('email-list-empty')).toBeVisible();
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'empty-inbox.png');
  });

  test('settings accounts page', async ({ page, resetApp }) => {
    await resetToSeededMailShell(resetApp, page);
    await ensureLightTheme(page);
    await navigateToSettings(page, 'accounts');
    await page.getByTestId('account-card-' + accountId).waitFor({ state: 'visible' });
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'settings-accounts.png');

    await returnToMailShell(page);
    await waitForStableMailShell(page);
  });

  test('settings AI page (connected)', async ({ page, electronApp, resetApp }) => {
    await resetToSeededMailShell(resetApp, page);
    await ensureLightTheme(page);
    await configureOllama(electronApp, { healthy: true, models: ['llama3'], selectedModel: 'llama3' });
    await navigateToSettings(page, 'ai');
    await expect(page.getByTestId('ai-status-indicator')).toContainText('Connected', { timeout: 10000 });
    await page.getByTestId('ai-model-select').waitFor({ state: 'visible' });
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'settings-ai-connected.png');

    await returnToMailShell(page);
    await waitForStableMailShell(page);
  });

  test('settings keyboard shortcuts page', async ({ page, resetApp }) => {
    await resetToSeededMailShell(resetApp, page);
    await ensureLightTheme(page);
    await navigateToSettings(page, 'keyboard');
    await page.getByTestId('keyboard-shortcut-list').waitFor({ state: 'visible' });
    await page.locator('[data-testid^="shortcut-row-"]').first().waitFor({ state: 'visible' });
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'settings-keyboard.png');

    await returnToMailShell(page);
    await waitForStableMailShell(page);
  });

  test('settings filters page', async ({ page, electronApp, resetApp }) => {
    await resetToSeededMailShell(resetApp, page);
    await ensureLightTheme(page);
    await configureOllama(electronApp, { healthy: false, models: [] });
    await navigateToSettings(page, 'filters');
    await page.getByText('Your Filters').waitFor({ state: 'visible' });
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'settings-filters.png');

    await returnToMailShell(page);
    await waitForStableMailShell(page);
  });

  test('settings queue page', async ({ page, resetApp }) => {
    await resetToSeededMailShell(resetApp, page);
    await ensureLightTheme(page);
    await navigateToSettings(page, 'queue');
    await page.locator('.stats-card').first().waitFor({ state: 'visible', timeout: 10000 });
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'settings-queue.png');

    await returnToMailShell(page);
    await waitForStableMailShell(page);
  });

  test('settings logger page', async ({ page, resetApp }) => {
    await resetToSeededMailShell(resetApp, page);
    await ensureLightTheme(page);
    await navigateToSettings(page, 'logger');
    await page.locator('.log-loading').waitFor({ state: 'hidden' });
    await page.locator('[data-testid="logger-entries"], .log-empty').first().waitFor({ state: 'visible' });
    const masks = await buildLoggerMasks(page);
    await blurActiveElement(page);

    await expectStableScreenshot(page, 'settings-logger.png', { mask: masks });

    await returnToMailShell(page);
    await waitForStableMailShell(page);
  });

  test('compose window (reply)', async ({ page, electronApp, resetApp }) => {
    await prepareMailShellWithEmails(resetApp, page, electronApp);

    await openPrimaryThread(page);
    await page.getByTestId('action-ribbon-standard').getByTestId('action-reply').click();
    await expect(page.getByTestId('compose-header')).toContainText('Reply', { timeout: 10000 });
    await expect(getComposeEditor(page)).toBeVisible();
    await page.locator('.quoted-block-wrapper').waitFor({ state: 'visible' });

    const composeMasks = await buildComposeMasks(page);
    const mailShellMasks = await buildMailShellMasks(page);
    const messageTimestampMask = page.getByTestId('message-timestamp');
    const quotedBlockMask = page.locator('.quoted-block-wrapper');
    const masks = [...composeMasks, ...mailShellMasks, messageTimestampMask, quotedBlockMask];

    await blurActiveElement(page);
    await expectStableScreenshot(page, 'compose-reply.png', { mask: masks });

    await discardComposeIfOpen(page);
  });

  test('sidebar collapsed state', async ({ page, electronApp, resetApp }) => {
    await prepareMailShellWithEmails(resetApp, page, electronApp);

    await page.getByTestId('sidebar-collapse-button').click();
    await expect(page.getByTestId('sidebar')).toHaveClass(/collapsed/, { timeout: 5000 });

    const masks = await buildMailShellMasks(page);

    await blurActiveElement(page);
    await expectStableScreenshot(page, 'sidebar-collapsed.png', { mask: masks });

    await page.getByTestId('sidebar-collapse-button').click();
    await expect(page.getByTestId('sidebar')).not.toHaveClass(/collapsed/, { timeout: 5000 });
  });

  test('AI chat panel (open with example prompts)', async ({ page, electronApp, resetApp }) => {
    await prepareMailShellWithEmails(resetApp, page, electronApp);

    await configureOllamaAndReturnToMailShell(page, electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      enableAiChat: true,
    });

    const chatPanel = page.getByTestId('ai-chat-panel');
    const collapsedStrip = chatPanel.locator('.collapsed-strip');
    await expect(collapsedStrip).toBeVisible({ timeout: 10000 });
    await expect(collapsedStrip).not.toHaveAttribute('aria-disabled', 'true', { timeout: 10000 });
    await collapsedStrip.click();

    await expect(page.getByTestId('ai-chat-input')).toBeVisible({ timeout: 10000 });
    await expect(chatPanel.locator('.example-prompts')).toBeVisible({ timeout: 10000 });

    const masks = await buildMailShellMasks(page);
    await blurActiveElement(page);
    await expectStableScreenshot(page, 'ai-chat-panel-open.png', { mask: masks });

    await chatPanel.locator('.header-btn[aria-label="Close panel"]').click();
    await expect(page.getByTestId('ai-chat-input')).not.toBeVisible({ timeout: 5000 });
  });

  test('AI summary panel in reading pane', async ({ page, electronApp, resetApp }) => {
    await prepareMailShellWithEmails(resetApp, page, electronApp);

    await configureOllamaAndReturnToMailShell(page, electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      responses: {
        chat: 'AI VISUAL SUMMARY RESPONSE',
        generate: 'AI VISUAL SUMMARY RESPONSE',
      },
    });

    await openPrimaryThread(page);
    await page.getByTestId('action-ribbon-standard').getByTestId('action-summarize').waitFor({ state: 'visible' });
    await page.getByTestId('action-ribbon-standard').getByTestId('action-summarize').click();

    const summaryPanel = page.getByTestId('ai-summary-panel');
    await summaryPanel.waitFor({ state: 'visible', timeout: 10000 });
    await expect(summaryPanel).toContainText('AI VISUAL SUMMARY RESPONSE', { timeout: 10000 });

    const masks = await buildFullMailShellMasks(page);
    await blurActiveElement(page);
    await expectStableScreenshot(page, 'ai-summary-panel.png', { mask: masks });

    await summaryPanel.locator('.ai-panel-close').click();
    await expect(summaryPanel).toBeHidden();
  });

  test('AI smart reply panel in reading pane', async ({ page, electronApp, resetApp }) => {
    await prepareMailShellWithEmails(resetApp, page, electronApp);

    await configureOllamaAndReturnToMailShell(page, electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      responses: {
        chat: JSON.stringify({
          suggestions: [
            'Thank you for reaching out.',
            'I will review and get back to you.',
            'Sounds good, let us proceed.',
          ],
        }),
      },
    });

    await openPrimaryThread(page);
    await page.getByTestId('action-ribbon-standard').getByTestId('action-smart-reply').waitFor({ state: 'visible' });
    await page.getByTestId('action-ribbon-standard').getByTestId('action-smart-reply').click();

    const repliesPanel = page.getByTestId('ai-replies-panel');
    await repliesPanel.waitFor({ state: 'visible', timeout: 10000 });
    await expect(repliesPanel.locator('.reply-chip').first()).toBeVisible({ timeout: 10000 });

    const masks = await buildFullMailShellMasks(page);
    await blurActiveElement(page);
    await expectStableScreenshot(page, 'ai-smart-reply-panel.png', { mask: masks });

    await repliesPanel.locator('.ai-panel-close').click();
    await expect(repliesPanel).toBeHidden();
  });
});
