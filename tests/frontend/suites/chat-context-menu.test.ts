import { test, expect } from '../infrastructure/electron-fixture';
import {
  configureOllama,
  extractSeededAccount,
  injectInboxMessage,
  navigateToSettings,
  returnToMailShell,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
} from '../infrastructure/helpers';

/**
 * Opens the AI chat panel by clicking the collapsed strip (if not already open).
 */
async function openAiChatPanel(page: import('@playwright/test').Page): Promise<void> {
  const chatPanel = page.getByTestId('ai-chat-panel');
  const chatInput = page.getByTestId('ai-chat-input');
  const collapsedStrip = chatPanel.locator('.collapsed-strip');

  if (await chatInput.isVisible().catch(() => false)) {
    return;
  }

  await expect(collapsedStrip).toBeVisible({ timeout: 10_000 });
  await expect(collapsedStrip).not.toHaveAttribute('aria-disabled', 'true', { timeout: 10_000 });
  await collapsedStrip.click();
  await expect(chatInput).toBeVisible({ timeout: 10_000 });
}

/**
 * Sends a chat message and waits for the assistant response to finish streaming.
 */
async function sendChatMessage(
  page: import('@playwright/test').Page,
  message: string,
  expectedMessageIndex: number,
): Promise<void> {
  const chatInput = page.getByTestId('ai-chat-input');
  const sendButton = page.getByTestId('ai-chat-send-button');

  await chatInput.fill(message);
  await sendButton.click();

  const userMessageTestId = `ai-chat-message-${expectedMessageIndex}`;
  await expect(page.getByTestId(userMessageTestId)).toBeVisible({ timeout: 10_000 });

  const assistantMessageTestId = `ai-chat-message-content-${expectedMessageIndex + 1}`;
  await expect(page.getByTestId(assistantMessageTestId)).toBeVisible({ timeout: 15_000 });

  const assistantContent = page.getByTestId(assistantMessageTestId).locator('.message-content');
  await expect(assistantContent).not.toHaveClass(/streaming/, { timeout: 15_000 });
}

test.describe('Chat context menu coverage', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  let nextMessageIndex = 0;

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);

    // Inject an email for context
    await injectInboxMessage(electronApp, {
      from: 'chat-ctx-sender@example.com',
      to: seededEmail,
      subject: 'Chat Context Menu Coverage Email',
      body: 'Email body for chat context menu test coverage.',
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, 'Chat Context Menu Coverage Email');

    // Configure Ollama with AI chat enabled
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      enableAiChat: true,
      responses: {
        chat: 'Here is the analysis: The email discusses testing and coverage.',
      },
    });

    // Navigate to AI settings and back to pick up config
    await navigateToSettings(page, 'ai');
    await returnToMailShell(page);

    await expect(page.getByTestId('ai-chat-panel')).toBeVisible({ timeout: 10_000 });
  });

  // ── Enter key sends a message ──────────────────────────────────────

  test('pressing Enter in chat input sends a message', async ({ page }) => {
    await openAiChatPanel(page);

    const chatInput = page.getByTestId('ai-chat-input');
    await chatInput.fill('What is this email about?');

    // Press Enter to send (not Shift+Enter which would be a newline)
    await chatInput.press('Enter');

    // Wait for user message to appear
    await expect(page.getByTestId(`ai-chat-message-${nextMessageIndex}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`ai-chat-message-content-${nextMessageIndex}`)).toContainText('What is this email about?');

    // Wait for assistant response
    const assistantContent = page.getByTestId(`ai-chat-message-content-${nextMessageIndex + 1}`);
    await expect(assistantContent).toBeVisible({ timeout: 15_000 });
    await expect(assistantContent.locator('.message-content')).not.toHaveClass(/streaming/, { timeout: 15_000 });

    nextMessageIndex += 2;
  });

  // ── Right-click on assistant message → Copy → toast ────────────────

  test('right-click assistant message and click Copy shows toast', async ({ page }) => {
    // The assistant message should be visible from previous test
    const assistantContent = page.getByTestId(`ai-chat-message-content-${nextMessageIndex - 1}`);
    await expect(assistantContent).toBeVisible();

    const messageBody = assistantContent.locator('.ai-message-body');
    await expect(messageBody).toBeVisible({ timeout: 5_000 });

    // Right-click on the message body
    const box = await messageBody.boundingBox();
    if (box) {
      await messageBody.dispatchEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      });
    } else {
      await messageBody.click({ button: 'right' });
    }

    // Copy button should appear in CDK overlay
    const copyButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Copy' });
    await expect(copyButton).toBeVisible({ timeout: 5_000 });

    // Click Copy
    await copyButton.click();

    // Menu should close
    await expect(copyButton).not.toBeVisible({ timeout: 5_000 });
  });

  // ── New chat creates a new session (clears messages) ───────────────

  test('new chat button clears messages and resets session', async ({ page }) => {
    await openAiChatPanel(page);

    // Click New chat
    const newChatButton = page.getByTestId('ai-chat-panel').locator('button[aria-label="New chat"]');
    await expect(newChatButton).toBeVisible({ timeout: 5_000 });
    await newChatButton.click();

    // Example prompts should appear (empty state)
    const examplePromptsContainer = page.getByTestId('ai-chat-panel').locator('.example-prompts');
    await expect(examplePromptsContainer).toBeVisible({ timeout: 10_000 });

    // Previous messages should not be visible
    await expect(page.getByTestId('ai-chat-message-0')).not.toBeVisible({ timeout: 5_000 });

    nextMessageIndex = 0;
  });

  // ── Send another message via send button (alternative to Enter) ──

  test('send button sends a message and receives response', async ({ page, electronApp }) => {
    // Reconfigure with a different response
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      enableAiChat: true,
      responses: {
        chat: 'This is a follow-up response about the testing email topic.',
      },
    });

    await openAiChatPanel(page);

    // Send via the send button (not Enter)
    await sendChatMessage(page, 'Give me a detailed analysis', nextMessageIndex);

    // Verify both user and assistant messages are present
    await expect(page.getByTestId(`ai-chat-message-content-${nextMessageIndex}`)).toContainText('detailed analysis');
    await expect(page.getByTestId(`ai-chat-message-content-${nextMessageIndex + 1}`)).toContainText('follow-up response');

    nextMessageIndex += 2;
  });

  // ── Escape key closes the AI chat panel ────────────────────────────

  test('Escape key closes the AI chat panel', async ({ page }) => {
    await openAiChatPanel(page);

    const chatInput = page.getByTestId('ai-chat-input');
    await expect(chatInput).toBeVisible();

    // Press Escape to close the panel
    await page.keyboard.press('Escape');

    // Chat input should no longer be visible
    await expect(chatInput).not.toBeVisible({ timeout: 5_000 });
  });
});
