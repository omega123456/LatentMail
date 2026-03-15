import { test, expect } from '../infrastructure/electron-fixture';
import {
  configureOllama,
  discardComposeIfOpen,
  extractSeededAccount,
  getComposeEditor,
  getSmtpCaptured,
  navigateToSettings,
  openCompose,
  returnToMailShell,
  waitForComposeEditor,
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

test.describe('Status bar and settings', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));
    await waitForMailShell(page);
  });

  // --- Status bar: visibility ---

  test('status bar is visible', async ({ page }) => {
    await expect(page.getByTestId('status-bar')).toBeVisible();
  });

  // --- Status bar: sync trigger ---

  test('clicking sync status indicator triggers a sync', async ({ page }) => {
    const syncButton = page.getByTestId('sync-status-indicator');
    await expect(syncButton).toBeVisible();

    // Capture the state BEFORE the click to avoid false positives
    const textBefore = await syncButton.innerText();

    // Click the sync button to trigger a manual sync
    await syncButton.click();

    // Wait for something to change — either a "Syncing" state appears or the text updates
    await expect.poll(async () => {
      const currentText = await syncButton.innerText();
      const hasSyncingState = await syncButton.evaluate(
        (element) => element.classList.contains('syncing') || (element.textContent?.includes('Syncing') ?? false),
      );
      return currentText !== textBefore || hasSyncingState;
    }, { timeout: 15_000 }).toBeTruthy();
  });

  // --- Status bar: queue link navigates to queue settings ---

  test('clicking queue link navigates to queue settings', async ({ page }) => {
    const queueLink = page.getByTestId('status-bar-queue-link');
    await expect(queueLink).toBeVisible();

    await queueLink.click();

    await expect(page.getByTestId('settings-content')).toBeVisible({ timeout: 10_000 });

    // Return to mail shell for subsequent tests
    await returnToMailShell(page);
    await expect(page.getByTestId('sidebar')).toBeVisible();
  });

  // --- AI settings: configure and select embedding model ---

  test('AI embedding model list renders after configuring Ollama', async ({ page, electronApp }) => {
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3', 'nomic-embed-text:latest'],
      selectedModel: 'llama3',
    });

    await navigateToSettings(page, 'ai');

    await expect(page.getByTestId('ai-status-indicator')).toContainText('Connected', {
      timeout: 10_000,
    });

    const embeddingModelSelect = page.getByTestId('ai-embedding-model-select');
    await expect(embeddingModelSelect).toBeVisible({ timeout: 10_000 });

    // Select the embedding model
    const embeddingModelCard = embeddingModelSelect.locator('.model-card').first();
    await expect(embeddingModelCard).toBeVisible();
    await embeddingModelCard.click();
  });

  // --- AI settings: rebuild all index → cancel ---

  test('rebuild all index shows confirmation and cancel dismisses it', async ({ page }) => {
    // The "Rebuild all index" button is in the index-actions section
    const rebuildButton = page.locator('button', { hasText: 'Rebuild all index' });
    await expect(rebuildButton).toBeVisible({ timeout: 10_000 });

    await rebuildButton.click();

    // The inline confirmation warning should appear
    const warningBlock = page.locator('.model-switch-warning');
    await expect(warningBlock).toBeVisible({ timeout: 5_000 });
    await expect(warningBlock).toContainText('delete all existing index data');

    // Click the Cancel button within the warning
    const cancelButton = warningBlock.locator('button', { hasText: 'Cancel' });
    await expect(cancelButton).toBeVisible();
    await cancelButton.click();

    // The confirmation should be dismissed
    await expect(warningBlock).not.toBeVisible({ timeout: 5_000 });
  });

  // --- AI settings: model cards display size text (formatSize) ---

  test('model cards display formatted size text', async ({ page }) => {
    const modelSelect = page.getByTestId('ai-model-select');
    await expect(modelSelect).toBeVisible();

    // Model cards should have a .model-size element with MB or GB text
    const firstModelSize = modelSelect.locator('.model-card .model-size').first();
    await expect(firstModelSize).toBeVisible();
    await expect(firstModelSize).toHaveText(/\d+\s*(MB|GB)/);
  });

  // --- Queue settings: send email then clear completed ---

  test('send email, navigate to queue, and clear completed items', async ({ page, electronApp }) => {
    await returnToMailShell(page);
    await discardComposeIfOpen(page);

    // Open compose and fill in the email
    await openCompose(page);
    await waitForComposeEditor(page);

    const recipientAddress = 'queue-test-recipient@example.com';
    const subject = 'Queue clear completed test';
    const body = 'This email is sent to test queue clear completed.';

    const toField = page.getByTestId('recipient-input-field-to');
    await toField.fill(recipientAddress);
    await toField.press('Tab');
    await expect(page.getByTestId('recipient-input-to')).toContainText(recipientAddress);

    await page.getByTestId('compose-subject-input').fill(subject);

    const editor = getComposeEditor(page);
    await editor.click();
    await page.keyboard.type(body);

    // Click send
    await page.getByTestId('compose-send-button').click();
    await expect(page.getByTestId('compose-window')).not.toBeVisible({ timeout: 10_000 });

    // Wait for the SMTP server to capture the sent email
    await expect.poll(async () => {
      const captured = await getSmtpCaptured(electronApp);
      const emails = captured.emails as CapturedEmail[];
      return emails.some((capturedEmail) => capturedEmail.subject === subject);
    }, { timeout: 30_000 }).toBeTruthy();

    // Navigate to queue settings
    await navigateToSettings(page, 'queue');

    // Wait for the clear completed button to appear (it only shows when there are completed items)
    const clearCompletedButton = page.getByTestId('queue-clear-completed-button');
    await expect(clearCompletedButton).toBeVisible({ timeout: 15_000 });

    // Click clear completed
    await clearCompletedButton.click();

    // After clearing, the button should disappear (no more completed items)
    await expect(clearCompletedButton).not.toBeVisible({ timeout: 10_000 });
  });
});
