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

async function setOllamaChat(app: import('@playwright/test').ElectronApplication, chatResponse: string): Promise<void> {
  await configureOllama(app, {
    healthy: true,
    models: ['llama3'],
    selectedModel: 'llama3',
    responses: { chat: chatResponse },
  });
}

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

async function closeAiChatPanel(page: import('@playwright/test').Page): Promise<void> {
  const chatInput = page.getByTestId('ai-chat-input');

  if (await chatInput.isVisible().catch(() => false)) {
    const closeButton = page.getByTestId('ai-chat-panel').locator('.header-btn[aria-label="Close panel"]');
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await expect(chatInput).not.toBeVisible({ timeout: 5_000 });
    }
  }
}

test.describe('AI chat', () => {
  test.describe.configure({ mode: 'serial' });

  test.describe('Interactions', () => {
    let accountId: number;
    let seededEmail: string;
    let nextMessageIndex = 0;

    test.beforeAll(async ({ resetApp, electronApp, page }) => {
      const result = await resetApp({ seedAccount: true });
      ({ accountId, email: seededEmail } = extractSeededAccount(result));

      await waitForMailShell(page);

      await injectInboxMessage(electronApp, {
        from: 'chat-test-sender@example.com',
        to: seededEmail,
        subject: 'Chat Interactions Test Email',
        body: 'This email is used for AI chat interaction testing.',
      });

      await triggerSync(electronApp, accountId);
      await waitForEmailSubject(page, 'Chat Interactions Test Email');

      await configureOllama(electronApp, {
        healthy: true,
        models: ['llama3'],
        selectedModel: 'llama3',
        enableAiChat: true,
        responses: {
          chat: 'Here is my analysis of the email. It contains important information about testing.',
        },
      });

      await navigateToSettings(page, 'ai');
      await returnToMailShell(page);

      await expect(page.getByTestId('ai-chat-panel')).toBeVisible({ timeout: 10_000 });
    });

    test('collapsed strip click opens the AI chat panel', async ({ page }) => {
      await openAiChatPanel(page);
      await expect(page.getByTestId('ai-chat-input')).toBeVisible();
    });

    test('sending a message produces an assistant response', async ({ page }) => {
      await openAiChatPanel(page);
      await sendChatMessage(page, 'Tell me about this email', nextMessageIndex);
      nextMessageIndex += 2;
    });

    test('right-click on assistant message shows context menu with Copy', async ({ page }) => {
      const assistantContent = page.getByTestId(`ai-chat-message-content-${nextMessageIndex - 1}`);
      await expect(assistantContent).toBeVisible();

      const messageBody = assistantContent.locator('.ai-message-body');
      await expect(messageBody).toBeVisible({ timeout: 5_000 });

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
    });

    test('clicking Copy in context menu closes the menu', async ({ page }) => {
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

      await expect(copyButton).not.toBeVisible({ timeout: 5_000 });
    });

    test('right-click on user message shows context menu', async ({ page }) => {
      const userMessage = page.getByTestId(`ai-chat-message-content-${nextMessageIndex - 2}`);
      await expect(userMessage).toBeVisible();

      const messageBubble = userMessage.locator('.message-bubble');
      await expect(messageBubble).toBeVisible({ timeout: 5_000 });

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

      await page.keyboard.press('Escape');
    });

    test('new chat button clears messages and shows example prompts', async ({ page }) => {
      await openAiChatPanel(page);

      const newChatButton = page.getByTestId('ai-chat-panel').locator('button[aria-label="New chat"]');
      await expect(newChatButton).toBeVisible({ timeout: 5_000 });
      await newChatButton.click();

      const examplePromptsContainer = page.getByTestId('ai-chat-panel').locator('.example-prompts');
      await expect(examplePromptsContainer).toBeVisible({ timeout: 10_000 });

      const oldUserMessage = page.getByTestId('ai-chat-message-0');
      await expect(oldUserMessage).not.toBeVisible({ timeout: 5_000 });

      nextMessageIndex = 0;
    });

    test('ArrowUp/ArrowDown cycles through message history', async ({ page, electronApp }) => {
      await openAiChatPanel(page);

      const examplePromptsContainer = page.getByTestId('ai-chat-panel').locator('.example-prompts');
      if (!(await examplePromptsContainer.isVisible().catch(() => false))) {
        const newChatButton = page.getByTestId('ai-chat-panel').locator('button[aria-label="New chat"]');
        await newChatButton.click();
        await expect(examplePromptsContainer).toBeVisible({ timeout: 10_000 });
        nextMessageIndex = 0;
      }

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

      const chatInput = page.getByTestId('ai-chat-input');
      await expect(chatInput).toHaveValue('');

      await chatInput.focus();
      await page.keyboard.press('ArrowUp');
      await expect(chatInput).toHaveValue('Second history message');

      await page.keyboard.press('ArrowUp');
      await expect(chatInput).toHaveValue('First history message');

      await page.keyboard.press('ArrowDown');
      await expect(chatInput).toHaveValue('Second history message');

      await page.keyboard.press('ArrowDown');
      await expect(chatInput).toHaveValue('');
    });
  });

  test.describe('Deep', () => {
    let accountId: number;
    let seededEmail: string;
    const inboxMessages: MessageIdentity[] = [];
    let sentMessageIdentity: MessageIdentity;
    let nextMessageIndex = 0;

    test.beforeAll(async ({ resetApp, electronApp, page }) => {
      const result = await resetApp({ seedAccount: true });
      ({ accountId, email: seededEmail } = extractSeededAccount(result));

      await waitForMailShell(page);

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

      sentMessageIdentity = await injectLogicalMessage(electronApp, {
        from: seededEmail,
        to: 'vendor@example.com',
        subject: 'Invoice Follow-up Request',
        body: 'Hi, could you please send the invoice for last month? We need it for our records.',
        mailboxes: ['[Gmail]/All Mail', '[Gmail]/Sent Mail'],
        xGmLabels: ['\\All', '\\Sent'],
      });

      await triggerSync(electronApp, accountId);

      await waitForEmailSubject(page, 'Project Budget Review Q4');
      await waitForEmailSubject(page, 'Team Standup Notes');
      await waitForEmailSubject(page, 'Conference Registration Deadline');

      await configureOllama(electronApp, {
        healthy: true,
        models: ['llama3'],
        selectedModel: 'llama3',
        enableAiChat: true,
        responses: {
          chat: 'Here are the key points:\n1. First important item\n2. Second important item\n3. Third important item',
        },
      });

      await navigateToSettings(page, 'ai');
      await returnToMailShell(page);

      await expect(page.getByTestId('ai-chat-panel')).toBeVisible({ timeout: 10_000 });
    });

    test('numbered list response renders as <ol> with <li> elements', async ({ page }) => {
      await openAiChatPanel(page);
      await sendChatMessage(page, 'What are the key points?', nextMessageIndex);

      const assistantContent = page.getByTestId(`ai-chat-message-content-${nextMessageIndex + 1}`).locator('.message-content');
      await expect(assistantContent).toBeVisible();

      const olElement = assistantContent.locator('ol');
      const liElements = assistantContent.locator('li');
      await expect(olElement).toBeVisible({ timeout: 5_000 });
      expect(await liElements.count()).toBeGreaterThanOrEqual(3);

      nextMessageIndex += 2;
    });

    test('bullet list response renders as <ul> with <li> elements', async ({ page, electronApp }) => {
      await setOllamaChat(electronApp, 'Key takeaways:\n- Budget needs approval\n- Standup notes are on track\n- Conference deadline is Monday');

      await sendChatMessage(page, 'Give me a summary with bullets', nextMessageIndex);

      const assistantContent = page.getByTestId(`ai-chat-message-content-${nextMessageIndex + 1}`).locator('.message-content');
      await expect(assistantContent).toBeVisible();

      const ulElement = assistantContent.locator('ul');
      const liElements = assistantContent.locator('li');
      await expect(ulElement).toBeVisible({ timeout: 5_000 });
      expect(await liElements.count()).toBeGreaterThanOrEqual(3);

      nextMessageIndex += 2;
    });

    test('code block response renders as <pre><code> elements', async ({ page, electronApp }) => {
      await setOllamaChat(electronApp, 'Here is a code snippet:\n```\nfunction hello() {\n  console.log("Hello!");\n}\n```\nThat should work.');

      await sendChatMessage(page, 'Show me some code', nextMessageIndex);

      const assistantContent = page.getByTestId(`ai-chat-message-content-${nextMessageIndex + 1}`).locator('.message-content');
      await expect(assistantContent).toBeVisible();

      const preElement = assistantContent.locator('pre');
      const codeElement = assistantContent.locator('code');
      await expect(preElement).toBeVisible({ timeout: 5_000 });
      await expect(codeElement).toBeVisible({ timeout: 5_000 });

      nextMessageIndex += 2;
    });

    test('source cards render below assistant messages with subject text', async ({ page, electronApp }) => {
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

      const assistantWrapper = page.getByTestId(`ai-chat-message-content-${nextMessageIndex + 1}`);
      await expect(assistantWrapper).toBeVisible();

      const sourceCards = assistantWrapper.locator('[data-testid^="ai-source-card-"]');

      await expect(sourceCards.first()).toBeVisible({ timeout: 15_000 });

      const firstSourceSubject = sourceCards.first().locator('.source-subject');
      await expect(firstSourceSubject).toBeVisible();
      const subjectText = await firstSourceSubject.textContent();
      expect(subjectText?.trim().length).toBeGreaterThan(0);

      nextMessageIndex += 2;
    });

    test('clicking a source card navigates to the source email', async ({ page }) => {
      const previousAssistantIndex = nextMessageIndex - 1;
      const assistantWrapper = page.getByTestId(`ai-chat-message-content-${previousAssistantIndex}`);
      const sourceCards = assistantWrapper.locator('[data-testid^="ai-source-card-"]');

      await expect(sourceCards.first()).toBeVisible({ timeout: 5_000 });

      const firstSourceCard = sourceCards.first();
      await expect(firstSourceCard).toBeVisible({ timeout: 5_000 });
      const sourceSubjectText = await firstSourceCard.locator('.source-subject').textContent();
      expect(sourceSubjectText).toBeTruthy();

      await firstSourceCard.locator('.source-card').click();

      const threadSubject = page.getByTestId('thread-subject');
      await expect(threadSubject).toBeVisible({ timeout: 15_000 });
      await expect(threadSubject).toContainText(sourceSubjectText!.trim(), { timeout: 15_000 });
    });

    test('example prompts are visible after starting a new chat', async ({ page }) => {
      await openAiChatPanel(page);

      const newChatButton = page.getByTestId('ai-chat-panel').locator('button[aria-label="New chat"]');
      await expect(newChatButton).toBeVisible({ timeout: 5_000 });
      await newChatButton.click();

      const examplePromptsContainer = page.getByTestId('ai-chat-panel').locator('.example-prompts');
      await expect(examplePromptsContainer).toBeVisible({ timeout: 10_000 });

      const exampleChips = examplePromptsContainer.locator('.example-chip');
      expect(await exampleChips.count()).toBeGreaterThanOrEqual(1);

      const firstChipText = await exampleChips.first().textContent();
      expect(firstChipText?.trim().length).toBeGreaterThan(0);

      nextMessageIndex = 0;
    });

    test('clicking an example chip sends a message and triggers a response', async ({ page, electronApp }) => {
      await setOllamaChat(electronApp, 'Here is a summary of your recent emails.');

      await openAiChatPanel(page);

      const examplePromptsContainer = page.getByTestId('ai-chat-panel').locator('.example-prompts');

      if (!(await examplePromptsContainer.isVisible().catch(() => false))) {
        const newChatButton = page.getByTestId('ai-chat-panel').locator('button[aria-label="New chat"]');
        await newChatButton.click();
        await expect(examplePromptsContainer).toBeVisible({ timeout: 10_000 });
        nextMessageIndex = 0;
      }

      const exampleChips = examplePromptsContainer.locator('.example-chip');
      const chipText = await exampleChips.first().textContent();
      expect(chipText).toBeTruthy();

      await exampleChips.first().click();

      const userMessage = page.getByTestId('ai-chat-message-content-0');
      await expect(userMessage).toBeVisible({ timeout: 10_000 });
      await expect(userMessage).toContainText(chipText!.trim());

      const assistantMessage = page.getByTestId('ai-chat-message-content-1');
      await expect(assistantMessage).toBeVisible({ timeout: 15_000 });

      const assistantContent = assistantMessage.locator('.message-content');
      await expect(assistantContent).not.toHaveClass(/streaming/, { timeout: 15_000 });

      nextMessageIndex = 2;
    });

    test('follow-up action button responds in the reading pane for sent emails', async ({ page, electronApp }) => {
      await closeAiChatPanel(page);

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

      const sidebar = page.getByTestId('sidebar');
      await expect(sidebar).toBeVisible();

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
        test.skip(true, 'Sent Mail folder not visible in sidebar — follow-up action requires sent folder');
        return;
      }

      await waitForEmailSubject(page, 'Invoice Follow-up Request');

      const sentEmailItem = page.getByTestId(`email-item-${sentMessageIdentity.xGmThrid}`);
      await expect(sentEmailItem).toBeVisible({ timeout: 10_000 });
      await sentEmailItem.click();

      await expect(page.getByTestId('reading-pane-content')).toBeVisible({ timeout: 10_000 });

      const actionRibbon = page.getByTestId('action-ribbon-standard');
      await expect(actionRibbon).toBeVisible();

      const followUpButton = actionRibbon.getByTestId('action-follow-up');

      await expect(followUpButton).toBeVisible({ timeout: 5_000 });

      await followUpButton.click();

      const followUpPanel = page.getByTestId('ai-followup-panel');
      await expect(followUpPanel).toBeVisible({ timeout: 15_000 });

      const panelText = await followUpPanel.textContent();
      const hasFollowUpContent = panelText?.includes('Follow-up') ||
        panelText?.includes('follow-up') ||
        panelText?.includes('Analyzing');
      expect(hasFollowUpContent).toBe(true);
    });
  });
});
