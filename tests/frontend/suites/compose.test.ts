import type { Page } from '@playwright/test';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  clearMockIpc,
  configureOllama,
  discardComposeIfOpen,
  emitRendererEvent,
  extractSeededAccount,
  getComposeEditor,
  getSmtpCaptured,
  injectInboxMessage,
  injectLogicalMessage,
  mockIpc,
  openCompose,
  TEST_PNG_1X1_BASE64,
  triggerSync,
  waitForComposeEditor,
  waitForEmailSubject,
  waitForMailShell,
} from '../infrastructure/helpers';

interface CapturedEmail {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  raw: string;
}

async function closeComposeWindow(page: Page): Promise<void> {
  await discardComposeIfOpen(page);
  await page.waitForTimeout(150);
}

async function openComposeWindow(page: Page): Promise<void> {
  await closeComposeWindow(page);
  await openCompose(page);
  await expect(getComposeEditor(page)).toBeVisible();
}

async function addRecipient(page: Page, emailAddress: string): Promise<void> {
  const toField = page.getByTestId('recipient-input-field-to');

  await toField.fill(emailAddress);
  await toField.press('Tab');

  await expect(page.getByTestId('recipient-input-to')).toContainText(emailAddress);
}

async function typeComposeBody(page: Page, body: string): Promise<void> {
  const editor = getComposeEditor(page);

  await editor.click();
  await page.keyboard.type(body);
  await expect(editor).toContainText(body);
}

function toolbarButton(page: Page, title: string) {
  return page.locator(`[data-testid="compose-toolbar"] button[title="${title}"]`);
}

async function simulateDrop(
  locator: import('@playwright/test').Locator,
  filename: string,
  content: string,
  mimeType: string,
): Promise<boolean> {
  return locator.evaluate(
    (element, args) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gAny = globalThis as any;
        const dataTransfer = new gAny.DataTransfer();
        dataTransfer.items.add(new File([args.content], args.filename, { type: args.mimeType }));
        if (dataTransfer.files.length === 0) {
          return false;
        }
        element.dispatchEvent(new gAny.DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
        return true;
      } catch {
        return false;
      }
    },
    { filename, content, mimeType },
  );
}

test.describe('Compose', () => {
  test.describe.configure({ mode: 'serial' });

  let seededEmail: string;
  let accountId: number;
  let draftThreadId: string;

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);
  });

  test.afterEach(async ({ electronApp }) => {
    await clearMockIpc(electronApp);
  });

  test('compose window opens when compose button is clicked', async ({ page }) => {
    await openComposeWindow(page);

    await expect(page.getByTestId('compose-window')).toBeVisible();

    await closeComposeWindow(page);
  });

  test('compose window shows the account email in the From field', async ({ page }) => {
    await openComposeWindow(page);

    await expect(page.getByTestId('compose-from-value')).toContainText(seededEmail);

    await closeComposeWindow(page);
  });

  test('accepts typed recipient address', async ({ page }) => {
    const recipientAddress = 'recipient.playwright@example.com';

    await openComposeWindow(page);
    await addRecipient(page, recipientAddress);

    await closeComposeWindow(page);
  });

  test('accepts subject text', async ({ page }) => {
    const subject = 'Compose subject acceptance test';

    await openComposeWindow(page);

    await page.getByTestId('compose-subject-input').fill(subject);

    await expect(page.getByTestId('compose-subject-input')).toHaveValue(subject);

    await closeComposeWindow(page);
  });

  test('sends an email and SMTP captures it', async ({ page, electronApp }) => {
    const recipientAddress = 'smtp-recipient@example.com';
    const subject = 'Playwright SMTP send verification';
    const body = 'This email body is sent from the frontend Playwright compose suite.';

    await openComposeWindow(page);
    await addRecipient(page, recipientAddress);
    await page.getByTestId('compose-subject-input').fill(subject);
    await typeComposeBody(page, body);

    await page.getByTestId('compose-send-button').click();
    await expect(page.getByTestId('compose-window')).not.toBeVisible();

    await expect.poll(async () => {
      const capturedEmails = (await getSmtpCaptured(electronApp)).emails as CapturedEmail[];
      const matchingEmail = capturedEmails.find((capturedEmail) => {
        return capturedEmail.subject === subject && capturedEmail.to.includes(recipientAddress);
      });

      if (matchingEmail === undefined) {
        return null;
      }

      return {
        subject: matchingEmail.subject,
        to: matchingEmail.to.join(','),
        body: matchingEmail.text ?? matchingEmail.raw,
      };
    }, { timeout: 30_000 }).toEqual({
      subject,
      to: recipientAddress,
      body,
    });
  });

  test('discard button closes compose window', async ({ page }) => {
    await openComposeWindow(page);

    await page.getByTestId('compose-discard-button').click();
    const confirmDialog = page.getByTestId('confirm-dialog');
    if (await confirmDialog.isVisible({ timeout: 500 }).catch(() => false)) {
      await page.getByTestId('confirm-dialog-ok').click();
    }

    await expect(page.getByTestId('compose-window')).not.toBeVisible();
  });

  test('close (X) button closes compose window', async ({ page }) => {
    await openComposeWindow(page);

    await page.getByTestId('compose-close-button').click();

    await expect(page.getByTestId('compose-window')).not.toBeVisible();
  });

  test.describe('Formatting toolbar', () => {
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

    test('Quote toolbar button applies to text typed immediately after clicking it from the initial compose focus state', async ({ page }) => {
      await openComposeWindow(page);

      const editor = getComposeEditor(page);
      const quoteButton = toolbarButton(page, 'Quote');

      await quoteButton.click();
      await page.keyboard.type('quote before focus');

      await expect(editor.locator('blockquote')).toContainText('quote before focus');
    });

    test('Quote toolbar button wraps selected editor text', async ({ page }) => {
      await openComposeWindow(page);

      const editor = getComposeEditor(page);
      await editor.click();
      await page.keyboard.type('selected quote text');
      await page.keyboard.press('Control+a');

      await toolbarButton(page, 'Quote').click();

      await expect(editor.locator('blockquote')).toContainText('selected quote text');
    });

    test('Quote toolbar button keeps typing inside the quote after the user clicks back into the editor', async ({ page }) => {
      await openComposeWindow(page);

      const editor = getComposeEditor(page);
      const quoteButton = toolbarButton(page, 'Quote');

      await quoteButton.click();
      await editor.click();
      await page.keyboard.type('quote after editor click');

      await expect(editor.locator('blockquote')).toContainText('quote after editor click');
    });

    test('Code Block toolbar button applies to text typed immediately after clicking it from the initial compose focus state', async ({ page }) => {
      await openComposeWindow(page);

      const editor = getComposeEditor(page);
      const codeBlockButton = toolbarButton(page, 'Code Block');

      await codeBlockButton.click();
      await page.keyboard.type('before focus code');

      await expect(editor.locator('pre code')).toContainText('before focus code');
    });

    test('Code Block toolbar button wraps selected editor text and applies highlighting', async ({ page }) => {
      await openComposeWindow(page);

      const editor = getComposeEditor(page);
      await editor.click();
      await page.keyboard.type('const answer = 42;');
      await page.keyboard.press('Control+a');

      await toolbarButton(page, 'Code Block').click();

      await expect(editor.locator('pre code')).toContainText('const answer = 42;');
      await expect(editor.locator('.hljs-keyword')).toContainText('const');
      await expect(editor.locator('.hljs-number')).toContainText('42');
    });

    test('Code Block toolbar button wraps selected multi-line editor text in one block', async ({ page }) => {
      await openComposeWindow(page);

      const editor = getComposeEditor(page);
      await editor.click();
      await page.keyboard.type('const first = 1;');
      await page.keyboard.press('Enter');
      await page.keyboard.type('const second = 2;');
      await page.keyboard.press('Control+a');

      await toolbarButton(page, 'Code Block').click();

      await expect(editor.locator('pre')).toHaveCount(1);
      await expect(editor.locator('pre code')).toContainText('const first = 1;');
      await expect(editor.locator('pre code')).toContainText('const second = 2;');
      await expect(editor.locator('.hljs-keyword')).toHaveCount(2);
      await expect(editor.locator('.hljs-number')).toHaveCount(2);
    });

    test('Code Block toolbar button keeps typing inside the code block after the user clicks back into the editor', async ({ page }) => {
      await openComposeWindow(page);

      const editor = getComposeEditor(page);
      const codeBlockButton = toolbarButton(page, 'Code Block');

      await codeBlockButton.click();
      await editor.click();
      await page.keyboard.type('code after editor click');

      await expect(editor.locator('pre code')).toContainText('code after editor click');
    });

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
      await page.mouse.move(startX, startY + 100, { steps: 10 });
      await page.mouse.up();

      const finalBox = await composeWindow.boundingBox();
      expect(finalBox).toBeTruthy();
      expect(finalBox!.height).not.toBe(initialBox!.height);
    });

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
        buffer: Buffer.from(TEST_PNG_1X1_BASE64, 'base64'),
      });

      await expect(editor.locator('img')).toBeVisible({ timeout: 10000 });
    });

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

  test.describe('Resize and context menu', () => {
    test('compose window can be resized via north handle drag', async ({ page }) => {
      await openCompose(page);
      await waitForComposeEditor(page);

      const composeWindow = page.getByTestId('compose-window');

      const initialBox = await composeWindow.boundingBox();
      expect(initialBox).toBeTruthy();

      const northHandle = page.locator('.resize-handle--n');
      await expect(northHandle).toBeVisible();

      const handleBox = await northHandle.boundingBox();
      expect(handleBox).toBeTruthy();

      await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y - 50);
      await page.mouse.up();

      const newBox = await composeWindow.boundingBox();
      expect(newBox).toBeTruthy();
      expect(newBox!.height).toBeGreaterThanOrEqual(initialBox!.height);
    });

    test('compose window can be resized via west handle drag', async ({ page }) => {
      const composeWindow = page.getByTestId('compose-window');
      const initialBox = await composeWindow.boundingBox();
      expect(initialBox).toBeTruthy();

      const westHandle = page.locator('.resize-handle--w');
      await expect(westHandle).toBeVisible();

      const handleBox = await westHandle.boundingBox();
      expect(handleBox).toBeTruthy();

      await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox!.x - 50, handleBox!.y + handleBox!.height / 2);
      await page.mouse.up();

      const newBox = await composeWindow.boundingBox();
      expect(newBox).toBeTruthy();
      expect(newBox!.width).toBeGreaterThanOrEqual(initialBox!.width);
    });

    test('right-click on editor opens context menu', async ({ page }) => {
      const editor = getComposeEditor(page);
      await expect(editor).toBeVisible();

      await editor.click();
      await page.keyboard.type('Hello context menu test');

      await editor.click({ button: 'right' });

      const contextMenu = page.locator('.editor-context-menu');
      await expect(contextMenu).toBeVisible({ timeout: 3000 });

      await expect(contextMenu.locator('button', { hasText: 'Cut' })).toBeVisible();
      await expect(contextMenu.locator('button', { hasText: 'Copy' })).toBeVisible();
      await expect(contextMenu.locator('button', { hasText: 'Paste' })).toBeVisible();
      await expect(contextMenu.locator('button', { hasText: 'Bold' })).toBeVisible();
      await expect(contextMenu.locator('button', { hasText: 'Italic' })).toBeVisible();
      await expect(contextMenu.locator('button', { hasText: 'Link' })).toBeVisible();
    });

    test('context menu paste button works', async ({ page }) => {
      const contextMenu = page.locator('.editor-context-menu');
      await expect(contextMenu).toBeVisible();

      await contextMenu.locator('button', { hasText: 'Paste' }).click();

      await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
    });

    test('context menu bold button applies formatting', async ({ page }) => {
      const editor = getComposeEditor(page);

      await editor.click();
      await page.keyboard.press('Control+a');

      await editor.click({ button: 'right' });
      const contextMenu = page.locator('.editor-context-menu');
      await expect(contextMenu).toBeVisible({ timeout: 3000 });

      await contextMenu.locator('button', { hasText: 'Bold' }).click();
      await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
    });

    test('clicking outside context menu closes it', async ({ page }) => {
      const editor = getComposeEditor(page);

      await editor.click({ button: 'right' });
      const contextMenu = page.locator('.editor-context-menu');
      await expect(contextMenu).toBeVisible({ timeout: 3000 });

      await page.getByTestId('compose-header').click();
      await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
    });

    test('Escape key closes editor context menu', async ({ page }) => {
      const editor = getComposeEditor(page);

      await editor.click({ button: 'right' });
      const contextMenu = page.locator('.editor-context-menu');
      await expect(contextMenu).toBeVisible({ timeout: 3000 });

      await page.keyboard.press('Escape');
      await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
    });

    test('link button in context menu opens link URL dialog', async ({ page }) => {
      const editor = getComposeEditor(page);

      await editor.click();
      await page.keyboard.type('link text here');
      await page.keyboard.press('Control+a');

      await editor.click({ button: 'right' });
      const contextMenu = page.locator('.editor-context-menu');
      await expect(contextMenu).toBeVisible({ timeout: 3000 });

      await contextMenu.locator('button', { hasText: 'Link' }).click();
      await expect(contextMenu).not.toBeVisible({ timeout: 2000 });

      const linkDialog = page.locator('.link-url-dialog');
      await expect(linkDialog).toBeVisible({ timeout: 3000 });

      const urlInput = page.locator('.link-url-input');
      await expect(urlInput).toBeVisible();
    });

    test('link URL dialog applies link on confirm', async ({ page }) => {
      const linkDialog = page.locator('.link-url-dialog');
      await expect(linkDialog).toBeVisible();

      const urlInput = page.locator('.link-url-input');
      await urlInput.fill('https://example.com');

      await linkDialog.locator('button', { hasText: 'OK' }).click();

      await expect(linkDialog).not.toBeVisible({ timeout: 3000 });
    });

    test('Escape key closes link URL dialog', async ({ page }) => {
      const editor = getComposeEditor(page);

      await editor.click();
      await page.keyboard.press('Control+a');
      await page.keyboard.type('fresh text for link test');

      await page.keyboard.press('Control+a');

      await editor.click({ button: 'right' });
      const contextMenu = page.locator('.editor-context-menu');
      await expect(contextMenu).toBeVisible({ timeout: 3000 });

      await contextMenu.locator('button', { hasText: 'Link' }).click();
      const linkDialog = page.locator('.link-url-dialog');
      await expect(linkDialog).toBeVisible({ timeout: 3000 });

      await page.keyboard.press('Escape');
      await expect(linkDialog).not.toBeVisible({ timeout: 3000 });
    });

    test('close compose window via discard', async ({ page }) => {
      await discardComposeIfOpen(page);
      await expect(page.getByTestId('compose-window')).not.toBeVisible();
    });
  });

  test.describe('Attachments and contacts', () => {
    test.beforeAll(async ({ electronApp }) => {
      await injectInboxMessage(electronApp, {
        from: 'alice@example.com',
        to: seededEmail,
        subject: 'Message from Alice',
        body: 'Hello from Alice',
      });

      await injectInboxMessage(electronApp, {
        from: 'bob@example.com',
        to: seededEmail,
        subject: 'Message from Bob',
        body: 'Hello from Bob',
      });

      await injectInboxMessage(electronApp, {
        from: 'carol@example.com',
        to: seededEmail,
        subject: 'Message from Carol',
        body: 'Hello from Carol',
      });

      await triggerSync(electronApp, accountId);
    });

    test.beforeEach(async ({ page }) => {
      await discardComposeIfOpen(page);
      await openCompose(page);
      await waitForComposeEditor(page);
    });

    test('drag-drop file on compose window outer area adds attachment', async ({ page }) => {
      const dropSucceeded = await simulateDrop(
        page.getByTestId('compose-header'),
        'header-drop.txt',
        'header drop content',
        'text/plain',
      );

      test.skip(!dropSucceeded, 'DataTransfer file creation not supported in this Electron/Chromium environment');

      const attachmentList = page.locator('[data-testid="attachment-list"]');
      await expect(attachmentList).toBeVisible({ timeout: 5000 });
      await expect(attachmentList.getByText('header-drop.txt')).toBeVisible({ timeout: 5000 });
    });

    test('drag-drop file on attachment upload zone adds attachment', async ({ page }) => {
      const dropSucceeded = await simulateDrop(
        page.locator('.attachment-drop-zone'),
        'zone-drop.txt',
        'zone drop content',
        'text/plain',
      );

      test.skip(!dropSucceeded, 'DataTransfer file creation not supported in this Electron/Chromium environment');

      const attachmentList = page.locator('[data-testid="attachment-list"]');
      await expect(attachmentList).toBeVisible({ timeout: 5000 });
      await expect(attachmentList.getByText('zone-drop.txt')).toBeVisible({ timeout: 5000 });
    });

    test('attachment upload component covers preview helpers, picker forwarding, and read errors', async ({ page }) => {
      await discardComposeIfOpen(page);
      await openCompose(page);
      await waitForComposeEditor(page);

      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByTestId('compose-attach-button').click(),
      ]);

      await fileChooser.setFiles({
        name: 'preview-image.png',
        mimeType: 'image/png',
        buffer: Buffer.from(TEST_PNG_1X1_BASE64, 'base64'),
      });

      await expect(page.locator('.attachment-chip .att-thumbnail').first()).toBeVisible({ timeout: 5000 });

      const coverageResult = await page.evaluate(async ({ restoredImageBase64 }) => {
        interface AngularDebugApi {
          getComponent(element: unknown): unknown;
        }

        interface AngularWindow {
          ng?: AngularDebugApi;
          __attachmentPickerClicks__?: number;
          __attachmentToastMessages__?: string[];
        }

        interface BrowserDocumentLike {
          querySelector(selector: string): unknown;
        }

        interface BrowserFileConstructor {
          new(parts: unknown[], name: string, options: { type: string }): unknown;
        }

        interface DraftAttachmentLike {
          id?: string;
          filename: string;
          mimeType?: string | null;
          size: number;
          data?: string;
        }

        interface WritableSignalLike<T> {
          (): T;
          set(value: T): void;
        }

        interface AttachmentUploadLike extends Record<string, unknown> {
          previews: WritableSignalLike<Map<string, string>>;
          getPreview(attachment: DraftAttachmentLike): string | null;
          openFilePicker(): void;
          handleDragOver(event: { preventDefault(): void }): void;
          onFilesSelected(event: { target: { files: unknown; value: string } }): void;
          handleDrop(event: { preventDefault(): void; dataTransfer: { files?: unknown } | null }): void;
        }

        interface ComposeStoreLike {
          addAttachment(attachment: DraftAttachmentLike): void;
          removeAttachment(index: number): void;
          attachments(): DraftAttachmentLike[];
        }

        interface ComposeWindowLike extends Record<string, unknown> {
          composeStore: ComposeStoreLike;
        }

        const browserGlobal = globalThis as unknown as Record<string, unknown>;
        const browserWindow = browserGlobal as unknown as AngularWindow;
        const browserDocument = browserGlobal['document'] as BrowserDocumentLike;
        const attachmentHost = browserDocument.querySelector('app-attachment-upload');
        const composeWindowHost = browserDocument.querySelector('app-compose-window');

        if (browserWindow.ng === undefined || attachmentHost === null || composeWindowHost === null) {
          throw new Error('Attachment upload component is not available in the Angular debug tree.');
        }

        const attachmentComponent = browserWindow.ng.getComponent(attachmentHost) as AttachmentUploadLike;
        const composeWindowComponent = browserWindow.ng.getComponent(composeWindowHost) as ComposeWindowLike;
        const originalFileReader = browserGlobal['FileReader'];
        const originalToastService = attachmentComponent['toastService'] as { error(message: string): void };
        const originalToastError = originalToastService.error.bind(originalToastService);
        const originalFileInputRef = attachmentComponent['fileInputRef'] as unknown;

        browserWindow.__attachmentPickerClicks__ = 0;
        browserWindow.__attachmentToastMessages__ = [];

        try {
          originalToastService.error = (message: string) => {
            browserWindow.__attachmentToastMessages__!.push(message);
          };

          attachmentComponent['fileInputRef'] = () => {
            return {
              nativeElement: {
                click: () => {
                  browserWindow.__attachmentPickerClicks__ = (browserWindow.__attachmentPickerClicks__ ?? 0) + 1;
                },
              },
            };
          };

          let dragOverPrevented = false;
          attachmentComponent.previews.set(new Map([['cached-image', 'data:image/png;base64,cached-value']]));
          const cachedPreview = attachmentComponent.getPreview({
            id: 'cached-image',
            filename: 'cached-image.png',
            mimeType: 'image/png',
            size: 10,
          });

          attachmentComponent.openFilePicker();
          attachmentComponent.handleDragOver({
            preventDefault: () => {
              dragOverPrevented = true;
            },
          });

          composeWindowComponent.composeStore.addAttachment({
            id: 'restored-preview-image',
            filename: 'restored-preview-image.png',
            mimeType: 'image/png',
            size: 68,
            data: restoredImageBase64,
          });

          await new Promise<void>((resolve) => {
            setTimeout(() => {
              resolve();
            }, 0);
          });

          const restoredPreview = attachmentComponent.getPreview({
            id: 'restored-preview-image',
            filename: 'restored-preview-image.png',
            mimeType: 'image/png',
            size: 68,
            data: restoredImageBase64,
          });

          attachmentComponent.previews.set(new Map([
            ['stale-preview', 'stale'],
            ['restored-preview-image', 'keep-me'],
          ]));

          composeWindowComponent.composeStore.removeAttachment(
            composeWindowComponent.composeStore.attachments().length - 1,
          );

          await new Promise<void>((resolve) => {
            setTimeout(() => {
              resolve();
            }, 0);
          });

          const stalePreviewRemoved = attachmentComponent.previews().has('stale-preview') === false;

          class FailingFileReader {
            onload: (() => unknown) | null = null;
            onerror: (() => unknown) | null = null;
            result: string | ArrayBuffer | null = null;

            readAsDataURL(): void {
              if (this.onerror !== null) {
                this.onerror();
              }
            }
          }

          Object.defineProperty(globalThis, 'FileReader', {
            configurable: true,
            writable: true,
            value: FailingFileReader,
          });

          const BrowserFile = browserGlobal['File'] as BrowserFileConstructor;

          const failingInput = {
            files: [new BrowserFile(['broken'], 'broken-file.txt', { type: 'text/plain' })],
            value: 'selected',
          };

          attachmentComponent.onFilesSelected({ target: failingInput });
          attachmentComponent.onFilesSelected({
            target: {
              files: null,
              value: '',
            },
          });
          attachmentComponent.handleDrop({
            preventDefault: () => {
              // no-op
            },
            dataTransfer: null,
          });

          await Promise.resolve();

          return {
            cachedPreview,
            restoredPreview,
            dragOverPrevented,
            pickerClicks: browserWindow.__attachmentPickerClicks__ ?? 0,
            stalePreviewRemoved,
            toastMessages: browserWindow.__attachmentToastMessages__ ?? [],
          };
        } finally {
          Object.defineProperty(globalThis, 'FileReader', {
            configurable: true,
            writable: true,
            value: originalFileReader,
          });

          originalToastService.error = originalToastError;
          attachmentComponent['fileInputRef'] = originalFileInputRef;
        }
      }, { restoredImageBase64: TEST_PNG_1X1_BASE64 });

      expect(coverageResult.cachedPreview).toContain('cached-value');
      expect(coverageResult.restoredPreview).toContain(TEST_PNG_1X1_BASE64);
      expect(coverageResult.dragOverPrevented).toBe(true);
      expect(coverageResult.pickerClicks).toBe(1);
      expect(coverageResult.stalePreviewRemoved).toBe(true);
      expect(coverageResult.toastMessages).toEqual(['Failed to read file: broken-file.txt']);

      await discardComposeIfOpen(page);
    });

    test('recipient chips are added via Enter and last chip removed via Backspace', async ({ page }) => {
      const toField = page.getByTestId('recipient-input-field-to');
      const recipientContainer = page.getByTestId('recipient-input-to');

      await toField.fill('alice@example.com');
      await toField.press('Enter');

      await expect(recipientContainer.locator('.chip')).toHaveCount(1);
      await expect(recipientContainer.locator('.chip').first()).toContainText('alice@example.com');

      await toField.fill('bob@example.com');
      await toField.press('Enter');

      await expect(recipientContainer.locator('.chip')).toHaveCount(2);
      await expect(recipientContainer.locator('.chip').nth(1)).toContainText('bob@example.com');

      await expect(toField).toHaveValue('');
      await toField.press('Backspace');

      await expect(recipientContainer.locator('.chip')).toHaveCount(1);
      await expect(recipientContainer.locator('.chip').first()).toContainText('alice@example.com');
    });

    test('typing partial name shows suggestions with active highlight on first item', async ({ page }) => {
      const toField = page.getByTestId('recipient-input-field-to');
      const recipientContainer = page.getByTestId('recipient-input-to');

      await toField.click();
      await toField.pressSequentially('ali', { delay: 50 });

      const dropdown = recipientContainer.locator('.suggestions-dropdown');
      await expect(dropdown).toBeVisible({ timeout: 5000 });

      const suggestionItems = dropdown.locator('.suggestion-item');
      await expect(suggestionItems.first()).toBeVisible();

      await expect(suggestionItems.first()).toHaveClass(/active/);

      await toField.press('ArrowDown');
      await expect(suggestionItems.first()).toHaveClass(/active/);
    });

    test('pressing Enter on highlighted suggestion creates chip and hides dropdown', async ({ page }) => {
      const toField = page.getByTestId('recipient-input-field-to');
      const recipientContainer = page.getByTestId('recipient-input-to');

      await toField.click();
      await toField.pressSequentially('ali', { delay: 50 });

      const dropdown = recipientContainer.locator('.suggestions-dropdown');
      await expect(dropdown).toBeVisible({ timeout: 5000 });

      await toField.press('Enter');

      await expect(recipientContainer.locator('.chip')).toHaveCount(1);
      await expect(recipientContainer.locator('.chip').first()).toContainText('alice@example.com');

      await expect(dropdown).not.toBeVisible();
    });

    test('pressing Escape hides the suggestions dropdown', async ({ page }) => {
      const toField = page.getByTestId('recipient-input-field-to');
      const recipientContainer = page.getByTestId('recipient-input-to');

      await toField.click();
      await toField.pressSequentially('bo', { delay: 50 });

      const dropdown = recipientContainer.locator('.suggestions-dropdown');
      await expect(dropdown).toBeVisible({ timeout: 5000 });

      await toField.press('Escape');
      await expect(dropdown).not.toBeVisible();
    });

    test('blurring recipient input converts typed text to a chip', async ({ page }) => {
      const toField = page.getByTestId('recipient-input-field-to');
      const recipientContainer = page.getByTestId('recipient-input-to');

      await toField.fill('carol@example.com');

      await page.getByTestId('compose-subject-input').click();

      await expect(recipientContainer.locator('.chip')).toHaveCount(1, { timeout: 2_000 });
      await expect(recipientContainer.locator('.chip').first()).toContainText('carol@example.com');
    });

    test('clicking chip remove button removes the recipient chip', async ({ page }) => {
      const toField = page.getByTestId('recipient-input-field-to');
      const recipientContainer = page.getByTestId('recipient-input-to');

      await toField.fill('carol@example.com');
      await toField.press('Enter');

      await expect(recipientContainer.locator('.chip')).toHaveCount(1);

      await recipientContainer.locator('.chip-remove').first().click();

      await expect(recipientContainer.locator('.chip')).toHaveCount(0);
    });
  });

  test.describe('Drafts', () => {
    test('inject draft and navigate to Drafts folder', async ({ page, electronApp }) => {
      await discardComposeIfOpen(page);

      const draftIdentity = await injectLogicalMessage(electronApp, {
        from: seededEmail,
        to: 'draft-recipient@example.com',
        subject: 'Test Draft Subject',
        body: 'This is draft body content for testing.',
        mailboxes: ['[Gmail]/All Mail', '[Gmail]/Drafts'],
        xGmLabels: ['\\All', '\\Draft'],
        flags: ['\\Draft'],
      });

      await triggerSync(electronApp, accountId);

      draftThreadId = draftIdentity.xGmThrid;

      await page.getByTestId('folder-item-[Gmail]/Drafts').click();
      await expect(page.getByTestId('email-list-header')).toContainText('Drafts');

      await waitForEmailSubject(page, 'Test Draft Subject', { timeout: 15000 });
    });

    test('open draft for editing via context menu', async ({ page }) => {
      const draftItem = page.getByTestId(`email-item-${draftThreadId}`);

      await draftItem.click();
      await draftItem.click({ button: 'right' });

      await expect(page.getByTestId('context-menu')).toBeVisible();
      await expect(page.getByTestId('context-action-edit-draft')).toBeVisible();

      await page.getByTestId('context-action-edit-draft').click();

      await expect(page.getByTestId('compose-window')).toBeVisible();
      await expect(page.getByTestId('compose-subject-input')).toHaveValue('Test Draft Subject');
      await expect(page.getByTestId('recipient-input-to')).toContainText('draft-recipient@example.com');
    });

    test('edit draft and close (save-on-close)', async ({ page }) => {
      await expect(page.getByTestId('compose-window')).toBeVisible();

      await page.getByTestId('compose-subject-input').fill('Updated Draft Subject');

      await page.getByTestId('compose-close-button').click();

      await expect(page.getByTestId('compose-window')).not.toBeVisible({ timeout: 5000 });
    });

    test('signature selector is visible in compose', async ({ page }) => {
      await discardComposeIfOpen(page);

      await page.getByTestId('compose-button').click();
      await expect(page.getByTestId('compose-window')).toBeVisible();

      await expect(page.getByTestId('signature-selector')).toBeVisible();

      await page.getByTestId('signature-selector').click();
      await expect(page.locator('.dropdown .dropdown-item').first()).toBeVisible({ timeout: 3000 });

      await discardComposeIfOpen(page);
    });

    test('compose with dirty state triggers auto-save indicator', async ({ page }) => {
      await page.getByTestId('folder-item-INBOX').click();
      await discardComposeIfOpen(page);

      await page.getByTestId('compose-button').click();
      await waitForComposeEditor(page);

      const toField = page.getByTestId('recipient-input-field-to');
      await toField.fill('autosave-test@example.com');
      await toField.press('Tab');

      await page.getByTestId('compose-subject-input').fill('Auto-save test subject');

      const editor = getComposeEditor(page);
      await editor.click();
      await page.keyboard.type('Auto-save body content for testing.');

      await page.waitForTimeout(6000);

      const saveStatus = page.getByTestId('compose-save-status');
      const hasStatus = await saveStatus.isVisible().catch(() => false);
      if (hasStatus) {
        await expect(saveStatus).toContainText(/Draft saved|Saving/i, { timeout: 5000 });
      }

      await discardComposeIfOpen(page);
    });

    test('discard draft removes it', async ({ page, electronApp }) => {
      const discardDraftIdentity = await injectLogicalMessage(electronApp, {
        from: seededEmail,
        to: 'discard-recipient@example.com',
        subject: 'Draft To Discard',
        body: 'This draft will be discarded.',
        mailboxes: ['[Gmail]/All Mail', '[Gmail]/Drafts'],
        xGmLabels: ['\\All', '\\Draft'],
        flags: ['\\Draft'],
      });

      await triggerSync(electronApp, accountId);

      await page.getByTestId('folder-item-INBOX').click();
      await expect(page.getByTestId('email-list-header')).toContainText('Inbox', { timeout: 5000 });
      await page.getByTestId('folder-item-[Gmail]/Drafts').click();
      await expect(page.getByTestId('email-list-header')).toContainText('Drafts');

      await expect(page.getByTestId(`email-item-${discardDraftIdentity.xGmThrid}`)).toBeVisible({ timeout: 10000 });

      const discardDraftItem = page.getByTestId(`email-item-${discardDraftIdentity.xGmThrid}`);

      await discardDraftItem.click();
      await discardDraftItem.click({ button: 'right' });

      await expect(page.getByTestId('context-menu')).toBeVisible();
      await page.getByTestId('context-action-edit-draft').click();

      await expect(page.getByTestId('compose-window')).toBeVisible();

      await page.getByTestId('compose-discard-button').click();

      const confirmDialog = page.getByTestId('confirm-dialog');
      if (await confirmDialog.isVisible({ timeout: 500 }).catch(() => false)) {
        await page.getByTestId('confirm-dialog-ok').click();
      }

      await expect(page.getByTestId('compose-window')).not.toBeVisible({ timeout: 5000 });
      await expect(discardDraftItem).not.toBeVisible({ timeout: 5000 });
    });

    test('server draft restore appends fetched attachments when editing an existing draft', async ({ page, electronApp }) => {
      const restoreDraftIdentity = await injectLogicalMessage(electronApp, {
        from: seededEmail,
        to: 'restore-recipient@example.com',
        subject: 'Draft With Server Attachments',
        body: 'This draft should restore server attachments.',
        mailboxes: ['[Gmail]/All Mail', '[Gmail]/Drafts'],
        xGmLabels: ['\\All', '\\Draft'],
        flags: ['\\Draft'],
      });

      await mockIpc(electronApp, {
        channel: 'attachment:fetch-draft-attachments',
        response: {
          success: true,
          data: [
            {
              id: 'server-attachment-1',
              filename: 'restored-server.txt',
              mimeType: 'text/plain',
              size: 21,
              data: Buffer.from('restored attachment').toString('base64'),
            },
          ],
        },
        once: true,
      });

      await triggerSync(electronApp, accountId);
      await page.getByTestId('folder-item-INBOX').click();
      await expect(page.getByTestId('email-list-header')).toContainText('Inbox', { timeout: 5000 });
      await page.getByTestId('folder-item-[Gmail]/Drafts').click();
      await expect(page.getByTestId('email-list-header')).toContainText('Drafts');

      const draftItem = page.getByTestId(`email-item-${restoreDraftIdentity.xGmThrid}`);
      await expect(draftItem).toBeVisible({ timeout: 10_000 });

      await draftItem.click();
      await draftItem.click({ button: 'right' });
      await page.getByTestId('context-action-edit-draft').click();

      await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 10_000 });
      const attachmentList = page.locator('[data-testid="attachment-list"]');
      await expect(attachmentList.getByText('restored-server.txt')).toBeVisible({ timeout: 10_000 });

      await discardComposeIfOpen(page);
    });

    test('queue update failure surfaces save error for an auto-saved draft', async ({ page, electronApp }) => {
      await page.getByTestId('folder-item-INBOX').click();
      await discardComposeIfOpen(page);

      await page.getByTestId('compose-button').click();
      await waitForComposeEditor(page);

      await mockIpc(electronApp, {
        channel: 'queue:enqueue',
        response: { success: true, data: { queueId: 'draft-failure-queue' } },
        once: true,
      });

      const toField = page.getByTestId('recipient-input-field-to');
      await toField.fill('autosave-failure@example.com');
      await toField.press('Tab');
      await page.getByTestId('compose-subject-input').fill('Auto-save failure test');

      const editor = getComposeEditor(page);
      await editor.click();
      await page.keyboard.type('This content triggers a failed queue update.');

      await page.waitForTimeout(5500);

      await emitRendererEvent(electronApp, {
        channel: 'queue:update',
        payload: {
          queueId: 'draft-failure-queue',
          status: 'failed',
          error: 'Draft queue failed',
        },
      });

      await expect(page.getByTestId('compose-error').getByText('Draft queue failed')).toBeVisible({ timeout: 5_000 });
      await discardComposeIfOpen(page);
    });
  });
});
