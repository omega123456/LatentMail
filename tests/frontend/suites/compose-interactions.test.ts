import { test, expect } from '../infrastructure/electron-fixture';
import {
  discardComposeIfOpen,
  extractSeededAccount,
  injectInboxMessage,
  openCompose,
  triggerSync,
  waitForComposeEditor,
  waitForMailShell,
} from '../infrastructure/helpers';

/**
 * Dispatches a synthetic drop event with a single file on the given locator.
 * Returns true if the DataTransfer/File API worked, false if the environment doesn't support it.
 */
async function simulateDrop(
  locator: import('@playwright/test').Locator,
  filename: string,
  content: string,
  mimeType: string,
): Promise<boolean> {
  return locator.evaluate(
    (element, args) => {
      try {
        // DataTransfer and DragEvent are browser globals available in the renderer context.
        // We access them via globalThis to avoid TypeScript errors in the Node test tsconfig.
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

test.describe('Compose interactions', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;

  test.beforeAll(async ({ resetApp, page, electronApp }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));
    await waitForMailShell(page);

    // Inject emails from 3 distinct senders to populate the contacts table
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

  // ── Browser drag-and-drop: compose window outer area ───────────────

  test('drag-drop file on compose window outer area adds attachment', async ({ page }) => {
    // Dispatch synthetic drop on the compose header — inside .compose-window but
    // outside the editor container and app-attachment-upload. This causes
    // compose-window's onDrop → handleFileDrop to fire and add as attachment.
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

  // ── Browser drag-and-drop: attachment upload zone ──────────────────

  test('drag-drop file on attachment upload zone adds attachment', async ({ page }) => {
    // Dispatch synthetic drop directly on the .attachment-drop-zone element,
    // which triggers AttachmentUploadComponent.handleDrop().
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

  // ── Recipient input: add chips via Enter, remove last via Backspace ─

  test('recipient chips are added via Enter and last chip removed via Backspace', async ({ page }) => {
    const toField = page.getByTestId('recipient-input-field-to');
    const recipientContainer = page.getByTestId('recipient-input-to');

    // Add first recipient chip
    await toField.fill('alice@example.com');
    await toField.press('Enter');

    await expect(recipientContainer.locator('.chip')).toHaveCount(1);
    await expect(recipientContainer.locator('.chip').first()).toContainText('alice@example.com');

    // Add second recipient chip
    await toField.fill('bob@example.com');
    await toField.press('Enter');

    await expect(recipientContainer.locator('.chip')).toHaveCount(2);
    await expect(recipientContainer.locator('.chip').nth(1)).toContainText('bob@example.com');

    // Input should be empty after Enter; press Backspace to remove the last chip (bob)
    await expect(toField).toHaveValue('');
    await toField.press('Backspace');

    await expect(recipientContainer.locator('.chip')).toHaveCount(1);
    await expect(recipientContainer.locator('.chip').first()).toContainText('alice@example.com');
  });

  // ── Recipient suggestions: dropdown appears with active highlight ──

  test('typing partial name shows suggestions with active highlight on first item', async ({ page }) => {
    const toField = page.getByTestId('recipient-input-field-to');
    const recipientContainer = page.getByTestId('recipient-input-to');

    // Type partial text to trigger contact search (200ms debounce)
    await toField.click();
    await toField.pressSequentially('ali', { delay: 50 });

    // Wait for suggestions dropdown to appear
    const dropdown = recipientContainer.locator('.suggestions-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    // Verify at least one suggestion item exists
    const suggestionItems = dropdown.locator('.suggestion-item');
    await expect(suggestionItems.first()).toBeVisible();

    // First item has .active class (activeSuggestion starts at 0)
    await expect(suggestionItems.first()).toHaveClass(/active/);

    // Press ArrowDown — first item stays active (single match for "ali")
    await toField.press('ArrowDown');
    await expect(suggestionItems.first()).toHaveClass(/active/);
  });

  // ── Recipient suggestions: Enter accepts highlighted suggestion ─────

  test('pressing Enter on highlighted suggestion creates chip and hides dropdown', async ({ page }) => {
    const toField = page.getByTestId('recipient-input-field-to');
    const recipientContainer = page.getByTestId('recipient-input-to');

    await toField.click();
    await toField.pressSequentially('ali', { delay: 50 });

    const dropdown = recipientContainer.locator('.suggestions-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    // Accept the active suggestion via Enter
    await toField.press('Enter');

    // Chip should appear with alice's email
    await expect(recipientContainer.locator('.chip')).toHaveCount(1);
    await expect(recipientContainer.locator('.chip').first()).toContainText('alice@example.com');

    // Dropdown should be hidden after selection
    await expect(dropdown).not.toBeVisible();
  });

  // ── Recipient suggestions: Escape hides dropdown ───────────────────

  test('pressing Escape hides the suggestions dropdown', async ({ page }) => {
    const toField = page.getByTestId('recipient-input-field-to');
    const recipientContainer = page.getByTestId('recipient-input-to');

    await toField.click();
    await toField.pressSequentially('bo', { delay: 50 });

    const dropdown = recipientContainer.locator('.suggestions-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    // Escape dismisses the dropdown
    await toField.press('Escape');
    await expect(dropdown).not.toBeVisible();
  });

  // ── Recipient input: blur converts typed text to chip ──────────────

  test('blurring recipient input converts typed text to a chip', async ({ page }) => {
    const toField = page.getByTestId('recipient-input-field-to');
    const recipientContainer = page.getByTestId('recipient-input-to');

    await toField.fill('carol@example.com');

    // Click the subject input to blur the To field
    await page.getByTestId('compose-subject-input').click();

    // Verify the typed text was converted to a chip (onBlur handler has a 200ms setTimeout;
    // Playwright's toHaveCount retries automatically until the assertion passes)
    await expect(recipientContainer.locator('.chip')).toHaveCount(1, { timeout: 2_000 });
    await expect(recipientContainer.locator('.chip').first()).toContainText('carol@example.com');
  });

  // ── Recipient chip: remove via × button ────────────────────────────

  test('clicking chip remove button removes the recipient chip', async ({ page }) => {
    const toField = page.getByTestId('recipient-input-field-to');
    const recipientContainer = page.getByTestId('recipient-input-to');

    // Add a chip first
    await toField.fill('carol@example.com');
    await toField.press('Enter');

    await expect(recipientContainer.locator('.chip')).toHaveCount(1);

    // Click the × (close) button on the chip
    await recipientContainer.locator('.chip-remove').first().click();

    // Verify chip was removed
    await expect(recipientContainer.locator('.chip')).toHaveCount(0);
  });
});
