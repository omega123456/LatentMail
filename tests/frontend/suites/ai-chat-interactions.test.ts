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
 * Opens the AI chat panel by clicking the collapsed strip (if the panel is not already open).
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
 * Sends a chat message and waits for the assistant response to appear.
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

  // Wait for the user message to appear
  const userMessageTestId = `ai-chat-message-${expectedMessageIndex}`;
  await expect(page.getByTestId(userMessageTestId)).toBeVisible({ timeout: 10_000 });

  // Wait for the assistant response to appear and finish streaming
  const assistantMessageTestId = `ai-chat-message-content-${expectedMessageIndex + 1}`;
  await expect(page.getByTestId(assistantMessageTestId)).toBeVisible({ timeout: 15_000 });

  // Wait for the streaming to complete
  const assistantContent = page.getByTestId(assistantMessageTestId).locator('.message-content');
  await expect(assistantContent).not.toHaveClass(/streaming/, { timeout: 15_000 });
}

test.describe('AI chat interactions', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  let nextMessageIndex = 0;

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);

    // Inject emails first (before enabling AI chat)
    await injectInboxMessage(electronApp, {
      from: 'chat-test-sender@example.com',
      to: seededEmail,
      subject: 'Chat Interactions Test Email',
      body: 'This email is used for AI chat interaction testing.',
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, 'Chat Interactions Test Email');

    // Configure Ollama with AI chat enabled
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      enableAiChat: true,
      responses: {
        chat: 'Here is my analysis of the email. It contains important information about testing.',
      },
    });

    // Navigate to AI settings and back so the renderer picks up the config
    await navigateToSettings(page, 'ai');
    await returnToMailShell(page);

    await expect(page.getByTestId('ai-chat-panel')).toBeVisible({ timeout: 10_000 });
  });

  // ── Open AI chat panel ───────────────────────────────────────────────

  test('collapsed strip click opens the AI chat panel', async ({ page }) => {
    await openAiChatPanel(page);
    await expect(page.getByTestId('ai-chat-input')).toBeVisible();
  });

  // ── Send a message and get a response ────────────────────────────────

  test('sending a message produces an assistant response', async ({ page }) => {
    await openAiChatPanel(page);
    await sendChatMessage(page, 'Tell me about this email', nextMessageIndex);
    nextMessageIndex += 2; // user + assistant
  });

  // ── Right-click on assistant message shows context menu ──────────────

  test('right-click on assistant message shows context menu with Copy', async ({ page }) => {
    // The assistant message should be visible from previous test
    const assistantContent = page.getByTestId(`ai-chat-message-content-${nextMessageIndex - 1}`);
    await expect(assistantContent).toBeVisible();

    // Right-click on the message body — use dispatchEvent to ensure Angular's (contextmenu) handler fires
    const messageBody = assistantContent.locator('.ai-message-body');
    await expect(messageBody).toBeVisible({ timeout: 5_000 });

    // Get the bounding box so we can provide accurate clientX/clientY
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

    // Context menu should appear with Copy option — look in CDK overlay
    const copyButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Copy' });
    await expect(copyButton).toBeVisible({ timeout: 5_000 });
  });

  // ── Copy from chat context menu ──────────────────────────────────────

  test('clicking Copy in context menu closes the menu', async ({ page }) => {
    // Re-open the context menu
    const assistantContent = page.getByTestId(`ai-chat-message-content-${nextMessageIndex - 1}`);
    const messageBody = assistantContent.locator('.ai-message-body');
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

    const copyButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Copy' });
    await expect(copyButton).toBeVisible({ timeout: 5_000 });

    await copyButton.click();

    // After clicking, the context menu should close (handler executed)
    await expect(copyButton).not.toBeVisible({ timeout: 5_000 });
  });

  // ── Right-click on user message also shows context menu ──────────────

  test('right-click on user message shows context menu', async ({ page }) => {
    const userMessage = page.getByTestId(`ai-chat-message-content-${nextMessageIndex - 2}`);
    await expect(userMessage).toBeVisible();

    const messageBubble = userMessage.locator('.message-bubble');
    await expect(messageBubble).toBeVisible({ timeout: 5_000 });

    // Use dispatchEvent to ensure Angular's (contextmenu) handler fires
    const box = await messageBubble.boundingBox();
    if (box) {
      await messageBubble.dispatchEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      });
    } else {
      await messageBubble.click({ button: 'right' });
    }

    const copyButton = page.locator('.cdk-overlay-container button').filter({ hasText: 'Copy' });
    await expect(copyButton).toBeVisible({ timeout: 5_000 });

    // Close the menu
    await page.keyboard.press('Escape');
  });

  // ── New chat resets messages ─────────────────────────────────────────

  test('new chat button clears messages and shows example prompts', async ({ page }) => {
    await openAiChatPanel(page);

    const newChatButton = page.getByTestId('ai-chat-panel').locator('button[aria-label="New chat"]');
    await expect(newChatButton).toBeVisible({ timeout: 5_000 });
    await newChatButton.click();

    // Example prompts should appear (empty state)
    const examplePromptsContainer = page.getByTestId('ai-chat-panel').locator('.example-prompts');
    await expect(examplePromptsContainer).toBeVisible({ timeout: 10_000 });

    // Previous messages should not be visible
    const oldUserMessage = page.getByTestId('ai-chat-message-0');
    await expect(oldUserMessage).not.toBeVisible({ timeout: 5_000 });

    nextMessageIndex = 0;
  });

  // ── ArrowUp/ArrowDown history cycling ────────────────────────────────

  test('ArrowUp/ArrowDown cycles through message history', async ({ page, electronApp }) => {
    await openAiChatPanel(page);

    // Start a new chat if needed
    const examplePromptsContainer = page.getByTestId('ai-chat-panel').locator('.example-prompts');
    if (!(await examplePromptsContainer.isVisible().catch(() => false))) {
      const newChatButton = page.getByTestId('ai-chat-panel').locator('button[aria-label="New chat"]');
      await newChatButton.click();
      await expect(examplePromptsContainer).toBeVisible({ timeout: 10_000 });
      nextMessageIndex = 0;
    }

    // Send two messages to build history
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      enableAiChat: true,
      responses: { chat: 'Response one.' },
    });
    await sendChatMessage(page, 'First history message', nextMessageIndex);
    nextMessageIndex += 2;

    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      enableAiChat: true,
      responses: { chat: 'Response two.' },
    });
    await sendChatMessage(page, 'Second history message', nextMessageIndex);
    nextMessageIndex += 2;

    // Now the input should be empty
    const chatInput = page.getByTestId('ai-chat-input');
    await expect(chatInput).toHaveValue('');

    // Press ArrowUp to get the most recent user message
    await chatInput.focus();
    await page.keyboard.press('ArrowUp');
    await expect(chatInput).toHaveValue('Second history message');

    // Press ArrowUp again to get the previous message
    await page.keyboard.press('ArrowUp');
    await expect(chatInput).toHaveValue('First history message');

    // Press ArrowDown to return to the more recent message
    await page.keyboard.press('ArrowDown');
    await expect(chatInput).toHaveValue('Second history message');

    // Press ArrowDown past the most recent to restore draft
    await page.keyboard.press('ArrowDown');
    await expect(chatInput).toHaveValue('');
  });
});
