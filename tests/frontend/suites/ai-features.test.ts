import { DateTime } from 'luxon';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  configureOllama,
  discardComposeIfOpen,
  extractSeededAccount,
  injectInboxMessage,
  navigateToSettings,
  returnToMailShell,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
} from '../infrastructure/helpers';

async function dismissAiPanels(page: import('@playwright/test').Page): Promise<void> {
  const aiPanels = [
    page.getByTestId('ai-summary-panel'),
    page.getByTestId('ai-replies-panel'),
    page.getByTestId('ai-followup-panel'),
  ];

  for (const aiPanel of aiPanels) {
    if (await aiPanel.isVisible().catch(() => false)) {
      await aiPanel.locator('.ai-panel-close').click();
      await expect(aiPanel).toBeHidden();
    }
  }
}

async function openAiSettings(page: import('@playwright/test').Page): Promise<void> {
  await navigateToSettings(page, 'ai');
  await expect(page.getByTestId('ai-status-indicator')).toBeVisible();
}

async function returnToMail(page: import('@playwright/test').Page): Promise<void> {
  await returnToMailShell(page);
  await waitForMailShell(page);
}

async function ensureOllamaModelSelected(page: import('@playwright/test').Page): Promise<void> {
  const modelSelect = page.getByTestId('ai-model-select');

  await expect(page.getByTestId('ai-status-indicator')).toContainText('Connected', { timeout: 10_000 });
  await expect(modelSelect).toBeVisible({ timeout: 10_000 });

  await modelSelect.getByText('llama3', { exact: true }).click();
  await expect(modelSelect.locator('.model-card.selected')).toContainText('llama3');
}

async function ensureSelectedThread(page: import('@playwright/test').Page, threadId: string): Promise<void> {
  await returnToMail(page);
  await discardComposeIfOpen(page);
  await page.getByTestId(`email-item-${threadId}`).click();
  await expect(page.getByTestId('reading-pane-content')).toBeVisible();
}

async function enableAiChatForCurrentMailbox(
  electronApp: import('playwright').ElectronApplication,
  page: import('@playwright/test').Page,
): Promise<void> {
  await configureOllama(electronApp, {
    enableAiChat: true,
  });

  await openAiSettings(page);
  await returnToMail(page);
}

test.describe('AI features', () => {
  test.describe.configure({ mode: 'serial' });

  const aiSummaryResponse = 'AI TEST SUMMARY RESPONSE';

  let accountId: number;
  let seededEmail: string;
  let threadId: string;
  let subject: string;

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);

    await configureOllama(electronApp, {
      models: ['llama3'],
      healthy: true,
      enableAiChat: true,
      responses: {
        chat: aiSummaryResponse,
        generate: 'AI TEST GENERATE RESPONSE',
      },
    });

    await openAiSettings(page);
    await ensureOllamaModelSelected(page);
    await returnToMail(page);

    subject = `AI Features Thread ${DateTime.utc().toMillis()}`;
    const messageIdentity = await injectInboxMessage(electronApp, {
      from: 'ai-features@example.com',
      to: seededEmail,
      subject,
      body: 'This email is used to exercise LatentMail AI features in Playwright.',
    });

    threadId = messageIdentity.xGmThrid;

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, subject);
    await enableAiChatForCurrentMailbox(electronApp, page);
    await ensureSelectedThread(page, threadId);
  });

  test.beforeEach(async ({ page }) => {
    await ensureSelectedThread(page, threadId);
    await dismissAiPanels(page);
  });

  test('OllamaService connects when configured', async ({ page }) => {
    await openAiSettings(page);

    await expect(page.getByTestId('ai-status-indicator')).toContainText('Connected', { timeout: 10_000 });
    await expect(page.getByTestId('ai-model-select').locator('.model-card.selected')).toContainText('llama3');

    await returnToMail(page);
  });

  test('AI summarize action is visible when connected', async ({ page }) => {
    const summarizeAction = page.getByTestId('action-ribbon-standard').getByTestId('action-summarize');

    await expect(summarizeAction).toBeVisible();
    await expect(summarizeAction).toBeEnabled();
  });

  test('AI summary panel appears when summarize is triggered', async ({ page }) => {
    const summarizeAction = page.getByTestId('action-ribbon-standard').getByTestId('action-summarize');
    const summaryPanel = page.getByTestId('ai-summary-panel');

    await summarizeAction.click();

    await expect(summaryPanel).toBeVisible();
    await expect(summaryPanel).toContainText(aiSummaryResponse, { timeout: 10_000 });
  });

  test('AI reply suggestions panel appears', async ({ page, electronApp }) => {
    await configureOllama(electronApp, {
      models: ['llama3'],
      healthy: true,
      responses: {
        chat: JSON.stringify({
          suggestions: [
            'Thanks, I will take a look.',
            'Sounds good to me.',
            'I will follow up shortly.',
          ],
        }),
      },
    });

    const smartReplyAction = page.getByTestId('action-ribbon-standard').getByTestId('action-smart-reply');
    const repliesPanel = page.getByTestId('ai-replies-panel');

    await smartReplyAction.click();

    await expect(repliesPanel).toBeVisible();
    await expect(repliesPanel.locator('.reply-chip').first()).toContainText('Thanks, I will take a look.');
  });

  test('clicking a reply suggestion opens compose with the suggestion', async ({ page, electronApp }) => {
    await configureOllama(electronApp, {
      models: ['llama3'],
      healthy: true,
      responses: {
        chat: JSON.stringify({
          suggestions: [
            'Thanks, I will take a look.',
            'Sounds good to me.',
            'I will follow up shortly.',
          ],
        }),
      },
    });

    const smartReplyAction = page.getByTestId('action-ribbon-standard').getByTestId('action-smart-reply');
    const repliesPanel = page.getByTestId('ai-replies-panel');

    await smartReplyAction.click();
    await expect(repliesPanel).toBeVisible();

    const firstSuggestion = repliesPanel.locator('.reply-chip').first();
    const suggestionText = (await firstSuggestion.textContent())?.trim();

    if (!suggestionText) {
      throw new Error('Expected a smart reply suggestion to be present.');
    }

    await firstSuggestion.click();

    await expect(page.getByTestId('compose-window')).toBeVisible();
    await expect(page.getByTestId('compose-header')).toContainText('Reply');
    await expect(page.getByTestId('compose-editor').locator('[contenteditable]')).toContainText(suggestionText);

    await discardComposeIfOpen(page);
  });

  test('AI chat panel can receive messages', async ({ page, electronApp }) => {
    await configureOllama(electronApp, {
      models: ['llama3'],
      healthy: true,
      enableAiChat: true,
      responses: {
        chat: aiSummaryResponse,
      },
    });

    const chatPanel = page.getByTestId('ai-chat-panel');
    const chatInput = page.getByTestId('ai-chat-input');
    const collapsedStrip = chatPanel.locator('.collapsed-strip');

    await expect(collapsedStrip).toBeVisible();
    await expect(collapsedStrip).not.toHaveAttribute('aria-disabled', 'true');

    if (!(await chatInput.isVisible())) {
      await collapsedStrip.click();
      await expect(chatInput).toBeVisible();
    }

    await chatInput.fill('What is this email about?');
    await page.getByTestId('ai-chat-send-button').click();

    await expect(page.getByTestId('ai-chat-message-0')).toBeVisible();
    await expect(page.getByTestId('ai-chat-message-content-0')).toContainText('What is this email about?');
    await expect(page.getByTestId('ai-chat-message-content-1')).toContainText(aiSummaryResponse, { timeout: 10_000 });
  });
});
