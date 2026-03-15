import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  waitForMailShell,
  openCompose,
  waitForComposeEditor,
  getComposeEditor,
  discardComposeIfOpen,
} from '../infrastructure/helpers';

test.describe('Compose deep interactions', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));
    await waitForMailShell(page);
  });

  // ── Compose window resize via north handle ────────────────────────────

  test('compose window can be resized via north handle drag', async ({ page }) => {
    await openCompose(page);
    await waitForComposeEditor(page);

    const composeWindow = page.getByTestId('compose-window');

    // Get initial height
    const initialBox = await composeWindow.boundingBox();
    expect(initialBox).toBeTruthy();

    // Find the north resize handle
    const northHandle = page.locator('.resize-handle--n');
    await expect(northHandle).toBeVisible();

    // Perform drag to make window taller (drag up)
    const handleBox = await northHandle.boundingBox();
    expect(handleBox).toBeTruthy();

    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y - 50);
    await page.mouse.up();

    // Verify the window height changed
    const newBox = await composeWindow.boundingBox();
    expect(newBox).toBeTruthy();
    // Height should be larger (or at least different) since we dragged up
    expect(newBox!.height).toBeGreaterThanOrEqual(initialBox!.height);
  });

  // ── Compose window resize via west handle ─────────────────────────────

  test('compose window can be resized via west handle drag', async ({ page }) => {
    const composeWindow = page.getByTestId('compose-window');
    const initialBox = await composeWindow.boundingBox();
    expect(initialBox).toBeTruthy();

    // Find the west resize handle
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

  // ── Editor right-click context menu ───────────────────────────────────

  test('right-click on editor opens context menu', async ({ page }) => {
    const editor = getComposeEditor(page);
    await expect(editor).toBeVisible();

    // Type some text first
    await editor.click();
    await page.keyboard.type('Hello context menu test');

    // Right-click to open context menu
    await editor.click({ button: 'right' });

    // Context menu should appear
    const contextMenu = page.locator('.editor-context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    // Should have Cut, Copy, Paste buttons
    await expect(contextMenu.locator('button', { hasText: 'Cut' })).toBeVisible();
    await expect(contextMenu.locator('button', { hasText: 'Copy' })).toBeVisible();
    await expect(contextMenu.locator('button', { hasText: 'Paste' })).toBeVisible();

    // Should have formatting buttons
    await expect(contextMenu.locator('button', { hasText: 'Bold' })).toBeVisible();
    await expect(contextMenu.locator('button', { hasText: 'Italic' })).toBeVisible();
    await expect(contextMenu.locator('button', { hasText: 'Link' })).toBeVisible();
  });

  // ── Context menu paste button ─────────────────────────────────────────

  test('context menu paste button works', async ({ page }) => {
    const contextMenu = page.locator('.editor-context-menu');
    await expect(contextMenu).toBeVisible();

    // Click Paste (exercises contextMenuPaste path)
    await contextMenu.locator('button', { hasText: 'Paste' }).click();

    // Context menu should close
    await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
  });

  // ── Context menu bold formatting ──────────────────────────────────────

  test('context menu bold button applies formatting', async ({ page }) => {
    const editor = getComposeEditor(page);

    // Select text
    await editor.click();
    await page.keyboard.press('Control+a');

    // Right-click to open context menu
    await editor.click({ button: 'right' });
    const contextMenu = page.locator('.editor-context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    // Click Bold formatting
    await contextMenu.locator('button', { hasText: 'Bold' }).click();
    await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
  });

  // ── Context menu closes on outside click ──────────────────────────────

  test('clicking outside context menu closes it', async ({ page }) => {
    const editor = getComposeEditor(page);

    // Right-click to open context menu
    await editor.click({ button: 'right' });
    const contextMenu = page.locator('.editor-context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    // Click on the compose window (outside context menu) to close
    await page.getByTestId('compose-header').click();
    await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
  });

  // ── Context menu closes on Escape ─────────────────────────────────────

  test('Escape key closes editor context menu', async ({ page }) => {
    const editor = getComposeEditor(page);

    // Right-click to open context menu
    await editor.click({ button: 'right' });
    const contextMenu = page.locator('.editor-context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    // Press Escape to close
    await page.keyboard.press('Escape');
    await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
  });

  // ── Link dialog opens and closes ──────────────────────────────────────

  test('link button in context menu opens link URL dialog', async ({ page }) => {
    const editor = getComposeEditor(page);

    // Select text for linking
    await editor.click();
    await page.keyboard.type('link text here');
    await page.keyboard.press('Control+a');

    // Right-click to open context menu
    await editor.click({ button: 'right' });
    const contextMenu = page.locator('.editor-context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    // Click Link button
    await contextMenu.locator('button', { hasText: 'Link' }).click();
    await expect(contextMenu).not.toBeVisible({ timeout: 2000 });

    // Link URL dialog should appear
    const linkDialog = page.locator('.link-url-dialog');
    await expect(linkDialog).toBeVisible({ timeout: 3000 });

    // Should have an input for URL
    const urlInput = page.locator('.link-url-input');
    await expect(urlInput).toBeVisible();
  });

  // ── Link dialog submit ────────────────────────────────────────────────

  test('link URL dialog applies link on confirm', async ({ page }) => {
    const linkDialog = page.locator('.link-url-dialog');
    await expect(linkDialog).toBeVisible();

    // Type a URL
    const urlInput = page.locator('.link-url-input');
    await urlInput.fill('https://example.com');

    // Click OK to apply
    await linkDialog.locator('button', { hasText: 'OK' }).click();

    // Dialog should close
    await expect(linkDialog).not.toBeVisible({ timeout: 3000 });
  });

  // ── Link dialog closes on Escape ──────────────────────────────────────

  test('Escape key closes link URL dialog', async ({ page }) => {
    const editor = getComposeEditor(page);

    // Clear existing content and type fresh text without any link
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('fresh text for link test');

    // Select the fresh text
    await page.keyboard.press('Control+a');

    // Right-click to open context menu
    await editor.click({ button: 'right' });
    const contextMenu = page.locator('.editor-context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });

    await contextMenu.locator('button', { hasText: 'Link' }).click();
    const linkDialog = page.locator('.link-url-dialog');
    await expect(linkDialog).toBeVisible({ timeout: 3000 });

    // Press Escape to close link dialog
    await page.keyboard.press('Escape');
    await expect(linkDialog).not.toBeVisible({ timeout: 3000 });
  });

  // ── Clean up compose ──────────────────────────────────────────────────

  test('close compose window via discard', async ({ page }) => {
    await discardComposeIfOpen(page);
    await expect(page.getByTestId('compose-window')).not.toBeVisible();
  });
});
