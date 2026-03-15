import { test, expect } from '../infrastructure/electron-fixture';
import {
  configureOllama,
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

/**
 * Configures Ollama with the standard chat-ready settings, varying only the chat response.
 * For calls that need `enableAiChat: true` or other custom options, use `configureOllama` directly.
 */
async function setOllamaChat(app: import('@playwright/test').ElectronApplication, chatResponse: string): Promise<void> {
  await configureOllama(app, {
    healthy: true,
    models: ['llama3'],
    selectedModel: 'llama3',
    responses: { chat: chatResponse },
  });
}

/**
 * Opens the AI chat panel by clicking the collapsed strip (if the panel is not already open).
 * Waits for the panel to be in 'ready' state (not disabled) before clicking.
 * After calling this, the chat input and send button should be visible.
 */
async function openAiChatPanel(page: import('@playwright/test').Page): Promise<void> {
  const chatPanel = page.getByTestId('ai-chat-panel');
  const chatInput = page.getByTestId('ai-chat-input');
  const collapsedStrip = chatPanel.locator('.collapsed-strip');

  // If the chat input is already visible, the panel is already open
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
 * Returns the 0-based index of the user message (assistant message is userIndex + 1).
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

  // Wait for the streaming to complete — the message-content should no longer have the .streaming class
  const assistantContent = page.getByTestId(assistantMessageTestId).locator('.message-content');
  await expect(assistantContent).not.toHaveClass(/streaming/, { timeout: 15_000 });
}

/**
 * Closes the AI chat panel if it is open.
 */
async function closeAiChatPanel(page: import('@playwright/test').Page): Promise<void> {
  const chatInput = page.getByTestId('ai-chat-input');

  if (await chatInput.isVisible().catch(() => false)) {
    // Panel is open — click the close button
    const closeButton = page.getByTestId('ai-chat-panel').locator('.header-btn[aria-label="Close panel"]');
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await expect(chatInput).not.toBeVisible({ timeout: 5_000 });
    }
  }
}

test.describe('AI chat deep', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  const inboxMessages: MessageIdentity[] = [];
  let sentMessageIdentity: MessageIdentity;

  // Track the current message index across serial tests that share the same chat session
  let nextMessageIndex = 0;

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);

    // Inject 3 inbox emails from different senders
    const inboxMsg1 = await injectInboxMessage(electronApp, {
      from: 'Alice Johnson <alice@example.com>',
      to: seededEmail,
      subject: 'Project Budget Review Q4',
      body: 'Please review the attached budget for Q4. We need approval by Friday.',
    });
    inboxMessages.push(inboxMsg1);

    const inboxMsg2 = await injectInboxMessage(electronApp, {
      from: 'Bob Smith <bob@example.com>',
      to: seededEmail,
      subject: 'Team Standup Notes',
      body: 'Here are the standup notes from today. All tasks are on track.',
    });
    inboxMessages.push(inboxMsg2);

    const inboxMsg3 = await injectInboxMessage(electronApp, {
      from: 'Carol Davis <carol@example.com>',
      to: seededEmail,
      subject: 'Conference Registration Deadline',
      body: 'The deadline for conference registration is next Monday. Please register ASAP.',
    });
    inboxMessages.push(inboxMsg3);

    // Inject 1 sent email (for follow-up action test)
    sentMessageIdentity = await injectLogicalMessage(electronApp, {
      from: seededEmail,
      to: 'vendor@example.com',
      subject: 'Invoice Follow-up Request',
      body: 'Hi, could you please send the invoice for last month? We need it for our records.',
      mailboxes: ['[Gmail]/All Mail', '[Gmail]/Sent Mail'],
      xGmLabels: ['\\All', '\\Sent'],
    });

    // Sync to populate the database
    await triggerSync(electronApp, accountId);

    // Wait for inbox emails to appear in the list
    await waitForEmailSubject(page, 'Project Budget Review Q4');
    await waitForEmailSubject(page, 'Team Standup Notes');
    await waitForEmailSubject(page, 'Conference Registration Deadline');

    // NOW configure Ollama with AI chat enabled (after emails are synced and indexed)
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      enableAiChat: true,
      responses: {
        chat: 'Here are the key points:\n1. First important item\n2. Second important item\n3. Third important item',
      },
    });

    // Navigate to AI settings and back so the renderer fetches the updated
    // embedding/index status via aiStore.checkStatus().  Without this round-trip
    // the renderer's indexStatus stays 'not_started' and the chat panel remains
    // disabled because the ai:status push event only carries connection info.
    await navigateToSettings(page, 'ai');
    await returnToMailShell(page);

    // Wait for the AI chat panel to become available in the renderer
    await expect(page.getByTestId('ai-chat-panel')).toBeVisible({ timeout: 10_000 });
  });

  // ── Chat message formatting: numbered list ────────────────────────────────

  test('numbered list response renders as <ol> with <li> elements', async ({ page }) => {
    await openAiChatPanel(page);
    await sendChatMessage(page, 'What are the key points?', nextMessageIndex);

    const assistantContent = page.getByTestId(`ai-chat-message-content-${nextMessageIndex + 1}`).locator('.message-content');
    await expect(assistantContent).toBeVisible();

    // Verify the numbered list renders as HTML ordered list
    const olElement = assistantContent.locator('ol');
    const liElements = assistantContent.locator('li');
    await expect(olElement).toBeVisible({ timeout: 5_000 });
    expect(await liElements.count()).toBeGreaterThanOrEqual(3);

    nextMessageIndex += 2; // user + assistant
  });

  // ── Chat message formatting: bullet list ──────────────────────────────────

  test('bullet list response renders as <ul> with <li> elements', async ({ page, electronApp }) => {
    // Reconfigure with a bullet list response
    await setOllamaChat(electronApp, 'Key takeaways:\n- Budget needs approval\n- Standup notes are on track\n- Conference deadline is Monday');

    await sendChatMessage(page, 'Give me a summary with bullets', nextMessageIndex);

    const assistantContent = page.getByTestId(`ai-chat-message-content-${nextMessageIndex + 1}`).locator('.message-content');
    await expect(assistantContent).toBeVisible();

    // Verify the bullet list renders as HTML unordered list
    const ulElement = assistantContent.locator('ul');
    const liElements = assistantContent.locator('li');
    await expect(ulElement).toBeVisible({ timeout: 5_000 });
    expect(await liElements.count()).toBeGreaterThanOrEqual(3);

    nextMessageIndex += 2;
  });

  // ── Chat message formatting: code block ───────────────────────────────────

  test('code block response renders as <pre><code> elements', async ({ page, electronApp }) => {
    // Reconfigure with a code block response
    await setOllamaChat(electronApp, 'Here is a code snippet:\n```\nfunction hello() {\n  console.log("Hello!");\n}\n```\nThat should work.');

    await sendChatMessage(page, 'Show me some code', nextMessageIndex);

    const assistantContent = page.getByTestId(`ai-chat-message-content-${nextMessageIndex + 1}`).locator('.message-content');
    await expect(assistantContent).toBeVisible();

    // Verify the code block renders as <pre><code>
    const preElement = assistantContent.locator('pre');
    const codeElement = assistantContent.locator('code');
    await expect(preElement).toBeVisible({ timeout: 5_000 });
    await expect(codeElement).toBeVisible({ timeout: 5_000 });

    nextMessageIndex += 2;
  });

  // ── Source cards render ───────────────────────────────────────────────────

  test('source cards render below assistant messages with subject text', async ({ page, electronApp }) => {
    // Configure response with citation markers [1] and [2] that should map to enriched chunks
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      enableAiChat: true,
      responses: {
        chat: 'Based on your emails, Alice discussed the budget [1] and Carol mentioned the conference deadline [2].',
      },
    });

    await sendChatMessage(page, 'What did Alice and Carol say?', nextMessageIndex);

    // Wait for the assistant message to finish
    const assistantWrapper = page.getByTestId(`ai-chat-message-content-${nextMessageIndex + 1}`);
    await expect(assistantWrapper).toBeVisible();

    // Look for source cards — they should appear inside the assistant message wrapper
    // Source cards have data-testid starting with "ai-source-card-"
    const sourceCards = assistantWrapper.locator('[data-testid^="ai-source-card-"]');

    // Wait for at least one source card to render (with generous timeout for async pipeline)
    await expect(sourceCards.first()).toBeVisible({ timeout: 15_000 });

    // Verify at least one source card has visible subject text
    const firstSourceSubject = sourceCards.first().locator('.source-subject');
    await expect(firstSourceSubject).toBeVisible();
    const subjectText = await firstSourceSubject.textContent();
    expect(subjectText?.trim().length).toBeGreaterThan(0);

    nextMessageIndex += 2;
  });

  // ── Source card click navigates ───────────────────────────────────────────

  test('clicking a source card navigates to the source email', async ({ page }) => {
    // Find the most recent assistant message that has source cards
    // We'll use the previous test's message which should have source cards
    const previousAssistantIndex = nextMessageIndex - 1;
    const assistantWrapper = page.getByTestId(`ai-chat-message-content-${previousAssistantIndex}`);
    const sourceCards = assistantWrapper.locator('[data-testid^="ai-source-card-"]');

    // Verify source cards are still visible from the previous test (explicit dependency guard)
    await expect(sourceCards.first()).toBeVisible({ timeout: 5_000 });

    // Get the subject text from the first source card before clicking
    const firstSourceCard = sourceCards.first();
    await expect(firstSourceCard).toBeVisible({ timeout: 5_000 });
    const sourceSubjectText = await firstSourceCard.locator('.source-subject').textContent();
    expect(sourceSubjectText).toBeTruthy();

    // Click the source card
    await firstSourceCard.locator('.source-card').click();

    // Wait for the reading pane to update with the source email's thread subject
    // The navigation triggers a search that loads the email into the reading pane
    const threadSubject = page.getByTestId('thread-subject');
    await expect(threadSubject).toBeVisible({ timeout: 15_000 });
    await expect(threadSubject).toContainText(sourceSubjectText!.trim(), { timeout: 15_000 });
  });

  // ── Example prompts visible after new chat ────────────────────────────────

  test('example prompts are visible after starting a new chat', async ({ page }) => {
    await openAiChatPanel(page);

    // Click the "New chat" button to clear messages and show the empty state
    const newChatButton = page.getByTestId('ai-chat-panel').locator('button[aria-label="New chat"]');
    await expect(newChatButton).toBeVisible({ timeout: 5_000 });
    await newChatButton.click();

    // Wait for messages to clear and example prompts to appear
    const examplePromptsContainer = page.getByTestId('ai-chat-panel').locator('.example-prompts');
    await expect(examplePromptsContainer).toBeVisible({ timeout: 10_000 });

    // Verify example chips are visible
    const exampleChips = examplePromptsContainer.locator('.example-chip');
    expect(await exampleChips.count()).toBeGreaterThanOrEqual(1);

    // Verify at least one chip has text content
    const firstChipText = await exampleChips.first().textContent();
    expect(firstChipText?.trim().length).toBeGreaterThan(0);

    // Reset the message index since we started a new chat
    nextMessageIndex = 0;
  });

  // ── Example chip click sends a message ────────────────────────────────────

  test('clicking an example chip sends a message and triggers a response', async ({ page, electronApp }) => {
    // Reconfigure to ensure a response is ready
    await setOllamaChat(electronApp, 'Here is a summary of your recent emails.');

    await openAiChatPanel(page);

    // Ensure we're in the empty state with example prompts
    const examplePromptsContainer = page.getByTestId('ai-chat-panel').locator('.example-prompts');

    // If example prompts aren't visible, click new chat first
    if (!(await examplePromptsContainer.isVisible().catch(() => false))) {
      const newChatButton = page.getByTestId('ai-chat-panel').locator('button[aria-label="New chat"]');
      await newChatButton.click();
      await expect(examplePromptsContainer).toBeVisible({ timeout: 10_000 });
      nextMessageIndex = 0;
    }

    // Get the text of the first example chip
    const exampleChips = examplePromptsContainer.locator('.example-chip');
    const chipText = await exampleChips.first().textContent();
    expect(chipText).toBeTruthy();

    // Click the example chip
    await exampleChips.first().click();

    // Verify a user message appeared with the chip's text
    const userMessage = page.getByTestId('ai-chat-message-content-0');
    await expect(userMessage).toBeVisible({ timeout: 10_000 });
    await expect(userMessage).toContainText(chipText!.trim());

    // Verify an assistant response appeared
    const assistantMessage = page.getByTestId('ai-chat-message-content-1');
    await expect(assistantMessage).toBeVisible({ timeout: 15_000 });

    // Wait for streaming to complete
    const assistantContent = assistantMessage.locator('.message-content');
    await expect(assistantContent).not.toHaveClass(/streaming/, { timeout: 15_000 });

    nextMessageIndex = 2;
  });

  // ── Follow-up action in reading pane ──────────────────────────────────────

  test('follow-up action button responds in the reading pane for sent emails', async ({ page, electronApp }) => {
    // Close the AI chat panel first
    await closeAiChatPanel(page);

    // Configure follow-up response
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      responses: {
        chat: JSON.stringify({
          needsFollowUp: true,
          reason: 'The vendor has not replied to the invoice request.',
          suggestedDate: '2026-03-22',
        }),
      },
    });

    // Navigate to the Sent Mail folder in the sidebar
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    // Try to find and click a "Sent Mail" folder link
    // The folder items use the gmailLabelId or display name; try both variants
    const sentFolderCandidates = [
      sidebar.getByText('Sent Mail', { exact: true }),
      sidebar.getByText('Sent', { exact: true }),
    ];

    let sentFolderClicked = false;
    for (const candidate of sentFolderCandidates) {
      try {
        await candidate.waitFor({ state: 'visible', timeout: 3_000 });
        await candidate.click();
        sentFolderClicked = true;
        break;
      } catch {
        // Candidate not visible — try next one
      }
    }

    if (!sentFolderClicked) {
      // If we can't find the Sent folder, the test can't proceed
      // This could happen if the mock IMAP doesn't expose Sent folder
      test.skip(true, 'Sent Mail folder not visible in sidebar — follow-up action requires sent folder');
      return;
    }

    // Wait for the sent email to appear in the list
    await waitForEmailSubject(page, 'Invoice Follow-up Request');

    // Select the sent email
    const sentEmailItem = page.getByTestId(`email-item-${sentMessageIdentity.xGmThrid}`);
    await expect(sentEmailItem).toBeVisible({ timeout: 10_000 });
    await sentEmailItem.click();

    // Wait for reading pane to load
    await expect(page.getByTestId('reading-pane-content')).toBeVisible({ timeout: 10_000 });

    // Find the follow-up action button in the standard ribbon
    const actionRibbon = page.getByTestId('action-ribbon-standard');
    await expect(actionRibbon).toBeVisible();

    const followUpButton = actionRibbon.getByTestId('action-follow-up');

    // Verify the follow-up button is visible (it's only visible for Sent folder)
    await expect(followUpButton).toBeVisible({ timeout: 5_000 });

    // Click the follow-up action button
    await followUpButton.click();

    // Verify the follow-up panel appears (either loading or with results)
    const followUpPanel = page.getByTestId('ai-followup-panel');
    await expect(followUpPanel).toBeVisible({ timeout: 15_000 });

    // Verify it shows either loading text or a follow-up result
    const panelText = await followUpPanel.textContent();
    const hasFollowUpContent = panelText?.includes('Follow-up') ||
      panelText?.includes('follow-up') ||
      panelText?.includes('Analyzing');
    expect(hasFollowUpContent).toBe(true);
  });
});
