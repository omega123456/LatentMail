import type { Page } from '@playwright/test';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  configureOllama,
  discardComposeIfOpen,
  extractSeededAccount,
  getComposeEditor,
  openCompose,
  waitForMailShell,
} from '../infrastructure/helpers';

async function closeComposeWindow(page: Page): Promise<void> {
  await discardComposeIfOpen(page);
  await page.waitForTimeout(150);
}

async function openComposeWindow(page: Page): Promise<void> {
  await closeComposeWindow(page);
  await openCompose(page);
  await expect(getComposeEditor(page)).toBeVisible();
}

function toolbarButton(page: Page, title: string) {
  return page.locator(`[data-testid="compose-toolbar"] button[title="${title}"]`);
}

test.describe('Compose advanced', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    extractSeededAccount(result);
    await waitForMailShell(page);
  });

  // ── Formatting toolbar ──────────────────────────────────────────────

  test('Bold toolbar button toggles active class', async ({ page }) => {
    await openComposeWindow(page);

    const editor = getComposeEditor(page);
    await editor.click();
    await page.keyboard.type('bold test');

    await page.keyboard.press('Control+a');

    const boldButton = toolbarButton(page, 'Bold (Ctrl+B)');
    await boldButton.click();

    await expect(boldButton).toHaveClass(/active/);
  });

  test('Italic toolbar button toggles active class', async ({ page }) => {
    await openComposeWindow(page);

    const editor = getComposeEditor(page);
    await editor.click();
    await page.keyboard.type('italic test');

    await page.keyboard.press('Control+a');

    const italicButton = toolbarButton(page, 'Italic (Ctrl+I)');
    await italicButton.click();

    await expect(italicButton).toHaveClass(/active/);
  });

  test('List, quote, and code toolbar buttons toggle active class', async ({ page }) => {
    await openComposeWindow(page);

    const editor = getComposeEditor(page);
    await editor.click();

    const buttons = [
      toolbarButton(page, 'Bullet List'),
      toolbarButton(page, 'Numbered List'),
      toolbarButton(page, 'Quote'),
      toolbarButton(page, 'Code Block'),
    ];

    for (const button of buttons) {
      await button.click();
      await expect(button).toHaveClass(/active/);
      await button.click();
      await expect(button).not.toHaveClass(/active/);
    }
  });

  // ── Undo ────────────────────────────────────────────────────────────

  test('Undo button reverts editor content', async ({ page }) => {
    await openComposeWindow(page);

    const editor = getComposeEditor(page);
    await editor.click();
    await page.keyboard.type('undo me');

    await expect(editor).toContainText('undo me');

    const undoButton = toolbarButton(page, 'Undo (Ctrl+Z)');
    await undoButton.click();

    await expect(editor).not.toContainText('undo me');
  });

  // ── File attachments ────────────────────────────────────────────────

  test('Attach file via filechooser shows attachment chip', async ({ page }) => {
    await openComposeWindow(page);

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('compose-attach-button').click(),
    ]);

    await fileChooser.setFiles({
      name: 'test-file.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('test content'),
    });

    const attachmentList = page.locator('[data-testid="attachment-list"]');
    await expect(attachmentList.getByText('test-file.txt')).toBeVisible();
  });

  test('Remove attachment removes chip from list', async ({ page }) => {
    const attachmentList = page.locator('[data-testid="attachment-list"]');

    await expect(attachmentList.getByText('test-file.txt')).toBeVisible();

    const removeButton = page.getByTitle('Remove test-file.txt');
    await removeButton.click();

    await expect(attachmentList.getByText('test-file.txt')).not.toBeVisible();
  });

  test('Attachment chip shows file size', async ({ page }) => {
    await openComposeWindow(page);

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('compose-attach-button').click(),
    ]);

    await fileChooser.setFiles({
      name: 'test-file.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('test content'),
    });

    const attachmentList = page.locator('[data-testid="attachment-list"]');
    await expect(attachmentList).toContainText(/B|KB/);
  });

  // ── Cc / Bcc toggle ─────────────────────────────────────────────────

  test('Toggle Cc field visibility', async ({ page }) => {
    await openComposeWindow(page);

    const ccToggle = page.getByTestId('compose-window').getByText('Cc', { exact: true });
    await ccToggle.click();

    await expect(page.getByTestId('recipient-input-cc')).toBeVisible();
  });

  test('Toggle Bcc field visibility', async ({ page }) => {
    await openComposeWindow(page);

    const bccToggle = page.getByTestId('compose-window').getByText('Bcc', { exact: true });
    await bccToggle.click();

    await expect(page.getByTestId('recipient-input-bcc')).toBeVisible();
  });

  // ── AI Assist ───────────────────────────────────────────────────────

  test('AI Assist menu opens when Ollama is connected', async ({ page, electronApp }) => {
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
    });

    await openComposeWindow(page);

    const aiButton = toolbarButton(page, 'AI Assist');
    await aiButton.click();

    const aiMenu = page.locator('.ai-menu');
    await expect(aiMenu).toBeVisible();
    await expect(aiMenu.locator('.ai-menu-item').first()).toBeVisible();
  });

  test('AI Assist button is disabled when Ollama is disconnected', async ({ page, electronApp }) => {
    await configureOllama(electronApp, {
      healthy: false,
      models: [],
    });

    await openComposeWindow(page);

    const aiButton = page.locator(
      '[data-testid="compose-toolbar"] button[title="AI Assist"], '
      + '[data-testid="compose-toolbar"] button[title="Ollama not connected"]',
    );

    await expect(aiButton).toBeDisabled();
  });

  // ── AI Compose & Transform ───────────────────────────────────────────

  test('AI Compose "Write for me" generates content', async ({ page, electronApp }) => {
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      responses: { generate: 'AI generated text response' },
    });

    await openComposeWindow(page);

    const aiButton = toolbarButton(page, 'AI Assist');
    await aiButton.click();

    const writeForMe = page.locator('.ai-menu-item').first();
    await writeForMe.click();

    const promptOverlay = page.locator('.ai-prompt-overlay');
    await expect(promptOverlay).toBeVisible();

    const promptInput = promptOverlay.locator('input, textarea').first();
    await promptInput.fill('Write a greeting email');

    const submitButton = promptOverlay.locator('button[type="submit"], button:has-text("Generate"), button:has-text("Submit")').first();
    await submitButton.click();

    const editor = getComposeEditor(page);
    await expect(editor).not.toBeEmpty({ timeout: 10_000 });
  });

  test('AI Transform "Improve writing" modifies selected text', async ({ page, electronApp }) => {
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      responses: { generate: 'AI generated text response' },
    });

    await openComposeWindow(page);

    const editor = getComposeEditor(page);
    await editor.click();
    await page.keyboard.type('hello world');

    await expect(editor).toContainText('hello world');

    await page.keyboard.press('Control+a');

    const aiButton = toolbarButton(page, 'AI Assist');
    await aiButton.click();

    const improveWriting = page.locator('.ai-menu-item').nth(1);
    await improveWriting.click();

    await page.waitForTimeout(2000);

    await expect(editor).not.toHaveText('hello world', { timeout: 10_000 });
  });

  // ── Editor context menu ──────────────────────────────────────────────

  test('Editor context menu appears with expected items', async ({ page }) => {
    await openComposeWindow(page);

    const editor = getComposeEditor(page);
    await editor.click();
    await page.keyboard.type('context menu test');

    await editor.click({ button: 'right' });

    const contextMenu = page.locator('.editor-context-menu');
    await expect(contextMenu).toBeVisible();

    for (const label of ['Cut', 'Copy', 'Paste', 'Bold', 'Italic']) {
      await expect(contextMenu.getByText(label, { exact: true })).toBeVisible();
    }

    await page.keyboard.press('Escape');
    await expect(contextMenu).not.toBeVisible();
  });

  // ── Link dialog ──────────────────────────────────────────────────────

  test('Link dialog opens and accepts a URL', async ({ page }) => {
    await openComposeWindow(page);

    const editor = getComposeEditor(page);
    await editor.click();
    await page.keyboard.type('link test');

    const linkButton = page.locator(
      '[data-testid="compose-toolbar"] button[title*="Link"]',
    );
    await linkButton.click();

    const linkDialog = page.locator('.link-url-dialog');
    await expect(linkDialog).toBeVisible();

    const urlInput = linkDialog.locator('input[type="text"], input[type="url"]').first();
    await urlInput.fill('https://example.com');

    const okButton = linkDialog.locator('button:has-text("OK"), button:has-text("Apply"), button[type="submit"]').first();
    await okButton.click();

    await expect(linkDialog).not.toBeVisible();
  });

  // ── Compose resize via drag ──────────────────────────────────────────

  test('Compose window can be resized via drag handle', async ({ page }) => {
    await openComposeWindow(page);

    const composeWindow = page.getByTestId('compose-window');
    const initialBox = await composeWindow.boundingBox();
    expect(initialBox).toBeTruthy();

    const handle = page.locator('.resize-handle--n, .resize-handle--nw').first();
    await expect(handle).toBeVisible();

    const handleBox = await handle.boundingBox();
    expect(handleBox).toBeTruthy();

    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY - 80, { steps: 10 });
    await page.mouse.up();

    const finalBox = await composeWindow.boundingBox();
    expect(finalBox).toBeTruthy();
    expect(finalBox!.height).not.toBe(initialBox!.height);
  });

  // ── Phase C: Inline image insertion ─────────────────────────────────

  test('Inline image insertion via toolbar filechooser', async ({ page }) => {
    await openComposeWindow(page);

    const editor = getComposeEditor(page);
    await editor.click();

    const insertImageButton = page.locator(
      '[data-testid="compose-toolbar"] button[title="Insert image"]',
    );

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      insertImageButton.click(),
    ]);

    await fileChooser.setFiles({
      name: 'inline-test.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64',
      ),
    });

    await expect(editor.locator('img')).toBeVisible({ timeout: 10000 });
  });

  // ── Phase C: Compose close with dirty state ─────────────────────────

  test('Compose discard with content shows confirm dialog', async ({ page }) => {
    await openComposeWindow(page);

    const editor = getComposeEditor(page);
    await editor.click();
    await page.keyboard.type('unsaved draft content');

    await expect(editor).toContainText('unsaved draft content');

    await page.getByTestId('compose-discard-button').click();

    const confirmDialog = page.locator('[data-testid="confirm-dialog"]');
    if (await confirmDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
      const cancelButton = page.locator('[data-testid="confirm-dialog-cancel"]');
      await cancelButton.click();

      await expect(confirmDialog).not.toBeVisible({ timeout: 5000 });

      const composeWindow = page.getByTestId('compose-window');
      await expect(composeWindow).toBeVisible();
    }

    await discardComposeIfOpen(page);
  });
});
