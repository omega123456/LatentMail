import { test, expect } from '../infrastructure/electron-fixture';
import {
  configureOllama,
  discardComposeIfOpen,
  extractSeededAccount,
  injectInboxMessage,
  injectLogicalMessage,
  navigateToSettings,
  returnToMailShell,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
  type MessageIdentity,
} from '../infrastructure/helpers';

test.describe('Reading pane interactions', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  let singleMsgIdentity: MessageIdentity;
  let multiRecipientIdentity: MessageIdentity;

  const SINGLE_MSG_SUBJECT = 'Header Context Menu Test';
  const MULTI_MSG_SUBJECT = 'Multi Recipient Test';

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);

    // Inject a simple inbox message from a named sender
    singleMsgIdentity = await injectInboxMessage(electronApp, {
      from: 'Jane Doe <jane.doe@example.com>',
      to: seededEmail,
      subject: SINGLE_MSG_SUBJECT,
      body: 'This message tests right-click context menu on sender name.',
    });

    // Inject a message with multiple recipients (exercises getRecipients/getRecipientsTooltip)
    multiRecipientIdentity = await injectLogicalMessage(electronApp, {
      from: 'Multi Sender <multi@example.com>',
      to: `${seededEmail}, alice@example.com, bob@example.com, carol@example.com`,
      subject: MULTI_MSG_SUBJECT,
      body: 'This message has 4 recipients to test the tooltip display.',
      mailboxes: ['[Gmail]/All Mail', 'INBOX'],
      xGmLabels: ['\\All', '\\Inbox'],
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, SINGLE_MSG_SUBJECT);
    await waitForEmailSubject(page, MULTI_MSG_SUBJECT);
  });

  // ── Right-click sender shows context menu ────────────────────────────

  test('right-click on sender name shows context menu with Copy and Send', async ({ page }) => {
    await discardComposeIfOpen(page);

    // Click the message to open it in reading pane
    const emailItem = page.getByTestId(`email-item-${singleMsgIdentity.xGmThrid}`);
    await expect(emailItem).toBeVisible({ timeout: 10_000 });
    await emailItem.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    // Find the sender link and right-click it
    const senderLink = page.getByTestId('reading-pane-content').locator('.sender-link').first();
    await expect(senderLink).toBeVisible({ timeout: 10_000 });

    // Use dispatchEvent to fire the Angular (contextmenu) handler reliably in Electron
    const box = await senderLink.boundingBox();
    if (box) {
      await senderLink.dispatchEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      });
    } else {
      await senderLink.click({ button: 'right' });
    }

    // The context menu should appear — look for menu items directly in the CDK overlay
    const copyEmailButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Copy email' });
    await expect(copyEmailButton).toBeVisible({ timeout: 5_000 });

    const sendEmailButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Send email' });
    await expect(sendEmailButton).toBeVisible({ timeout: 5_000 });
  });

  // ── Copy email from context menu ─────────────────────────────────────

  test('clicking Copy email in context menu closes the menu', async ({ page }) => {
    // Re-open the context menu since it may have closed between tests
    const senderLink = page.getByTestId('reading-pane-content').locator('.sender-link').first();
    const box = await senderLink.boundingBox();
    if (box) {
      await senderLink.dispatchEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      });
    } else {
      await senderLink.click({ button: 'right' });
    }

    const copyEmailButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Copy email' });
    await expect(copyEmailButton).toBeVisible({ timeout: 5_000 });

    await copyEmailButton.click();

    // After clicking, the context menu should close (handler executed)
    await expect(copyEmailButton).not.toBeVisible({ timeout: 5_000 });
  });

  // ── Send email from context menu opens compose ───────────────────────

  test('clicking Send email in context menu opens compose', async ({ page }) => {
    await discardComposeIfOpen(page);

    // Re-click the sender to open context menu
    const senderLink = page.getByTestId('reading-pane-content').locator('.sender-link').first();
    const box = await senderLink.boundingBox();
    if (box) {
      await senderLink.dispatchEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      });
    } else {
      await senderLink.click({ button: 'right' });
    }

    const sendEmailButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Send email' });
    await expect(sendEmailButton).toBeVisible({ timeout: 5_000 });

    await sendEmailButton.click();

    // Compose window should open
    await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5_000 });

    await discardComposeIfOpen(page);
  });

  // ── Right-click on recipients (to line) shows context menu ───────────

  test('right-click on recipients link shows context menu', async ({ page }) => {
    await discardComposeIfOpen(page);

    // Open the multi-recipient email
    const emailItem = page.getByTestId(`email-item-${multiRecipientIdentity.xGmThrid}`);
    await expect(emailItem).toBeVisible({ timeout: 10_000 });
    await emailItem.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    // Find the recipients link and right-click it
    const recipientsLink = page.getByTestId('reading-pane-content').locator('.recipients-link').first();
    await expect(recipientsLink).toBeVisible({ timeout: 10_000 });

    // Verify multi-recipient display shows truncated form ("and N others")
    await expect(recipientsLink).toContainText('others');

    // The recipients link should have a tooltip with full list
    const tooltipContent = await recipientsLink.getAttribute('title');
    expect(tooltipContent).toBeTruthy();
    expect(tooltipContent).toContain('alice@example.com');

    // Use dispatchEvent to fire the Angular (contextmenu) handler
    const box = await recipientsLink.boundingBox();
    if (box) {
      await recipientsLink.dispatchEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      });
    } else {
      await recipientsLink.click({ button: 'right' });
    }

    const copyEmailButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Copy email' });
    await expect(copyEmailButton).toBeVisible({ timeout: 5_000 });

    // Close the menu by pressing Escape
    await page.keyboard.press('Escape');
  });

  // ── AI summarize action ──────────────────────────────────────────────

  test('AI summarize action shows summary panel', async ({ page, electronApp }) => {
    await discardComposeIfOpen(page);

    // Configure Ollama for summarize
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      responses: { chat: 'This email is a test for context menu interactions.' },
    });

    // Navigate to AI settings to pick up the configuration then return
    await navigateToSettings(page, 'ai');
    await returnToMailShell(page);

    // Select the email
    const emailItem = page.getByTestId(`email-item-${singleMsgIdentity.xGmThrid}`);
    await emailItem.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    // Click summarize action
    const summarizeAction = page.getByTestId('action-ribbon-standard').getByTestId('action-summarize');
    await expect(summarizeAction).toBeVisible({ timeout: 5_000 });
    await summarizeAction.click();

    // Summary panel should appear
    const summaryPanel = page.getByTestId('ai-summary-panel');
    await expect(summaryPanel).toBeVisible({ timeout: 15_000 });
    await expect(summaryPanel).toContainText('This email is a test', { timeout: 15_000 });
  });
});
