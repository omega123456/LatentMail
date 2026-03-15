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
  discardComposeIfOpen,
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

const inboxMailboxes = ['[Gmail]/All Mail', 'INBOX'];
const inboxLabels = ['\\All', '\\Inbox'];
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

    await page.getByTestId(`email-item-${messageFixtures.primaryThreadId}`).click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();
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
});
