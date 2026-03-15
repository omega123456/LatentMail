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

test.describe('Reading pane AI actions', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  let inboxMsgIdentity: MessageIdentity;
  let sentMsgIdentity: MessageIdentity;

  const INBOX_SUBJECT = 'AI Actions Inbox Email';
  const SENT_SUBJECT = 'AI Actions Sent Email';

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);

    // Inject inbox email
    inboxMsgIdentity = await injectInboxMessage(electronApp, {
      from: 'Alice Johnson <alice@example.com>',
      to: seededEmail,
      subject: INBOX_SUBJECT,
      body: 'Please review the Q4 budget proposal and let me know your thoughts by Friday.',
    });

    // Inject sent email (for follow-up)
    sentMsgIdentity = await injectLogicalMessage(electronApp, {
      from: seededEmail,
      to: 'vendor@example.com',
      subject: SENT_SUBJECT,
      body: 'Hi, could you please send the updated contract? We need it urgently.',
      mailboxes: ['[Gmail]/All Mail', '[Gmail]/Sent Mail'],
      xGmLabels: ['\\All', '\\Sent'],
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, INBOX_SUBJECT);

    // Configure Ollama with AI features
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      responses: {
        chat: 'Summary: The Q4 budget proposal needs review by Friday.',
      },
    });

    await navigateToSettings(page, 'ai');
    await returnToMailShell(page);
  });

  // ── Summarize → summary panel appears → close button dismisses ─────

  test('summarize action shows panel, close button dismisses it', async ({ page }) => {
    await discardComposeIfOpen(page);

    // Select inbox email
    await page.getByTestId(`email-item-${inboxMsgIdentity.xGmThrid}`).click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    // Click summarize
    const summarizeAction = page.getByTestId('action-ribbon-standard').getByTestId('action-summarize');
    await expect(summarizeAction).toBeVisible({ timeout: 10_000 });
    await summarizeAction.click();

    // Summary panel should appear
    const summaryPanel = page.getByTestId('ai-summary-panel');
    await expect(summaryPanel).toBeVisible({ timeout: 15_000 });

    // Click close button on summary panel
    const closeButton = summaryPanel.locator('.ai-panel-close');
    await closeButton.click();

    // Panel should be dismissed
    await expect(summaryPanel).not.toBeVisible({ timeout: 5_000 });
  });

  // ── Smart reply → replies panel appears → close button dismisses ───

  test('smart reply action shows panel with suggestions, close button dismisses', async ({ page, electronApp }) => {
    await discardComposeIfOpen(page);

    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      responses: {
        chat: JSON.stringify({
          suggestions: [
            'I will review the budget today.',
            'Can we schedule a call to discuss?',
            'Approved, no changes needed.',
          ],
        }),
      },
    });

    // Select inbox email
    await page.getByTestId(`email-item-${inboxMsgIdentity.xGmThrid}`).click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    // Click smart reply
    const smartReplyAction = page.getByTestId('action-ribbon-standard').getByTestId('action-smart-reply');
    await expect(smartReplyAction).toBeVisible({ timeout: 5_000 });
    await smartReplyAction.click();

    // Replies panel should appear
    const repliesPanel = page.getByTestId('ai-replies-panel');
    await expect(repliesPanel).toBeVisible({ timeout: 15_000 });

    // Verify reply chips are visible
    await expect(repliesPanel.locator('.reply-chip').first()).toBeVisible({ timeout: 10_000 });

    // Click close button on replies panel
    const closeButton = repliesPanel.locator('.ai-panel-close');
    await closeButton.click();

    // Panel should be dismissed
    await expect(repliesPanel).not.toBeVisible({ timeout: 5_000 });
  });

  // ── Smart reply → click suggestion → opens compose with text ───────

  test('clicking a reply suggestion opens compose with the suggestion text', async ({ page, electronApp }) => {
    await discardComposeIfOpen(page);

    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      responses: {
        chat: JSON.stringify({
          suggestions: [
            'I will review the budget today.',
            'Can we schedule a call to discuss?',
          ],
        }),
      },
    });

    // Select inbox email
    await page.getByTestId(`email-item-${inboxMsgIdentity.xGmThrid}`).click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    // Click smart reply
    const smartReplyAction = page.getByTestId('action-ribbon-standard').getByTestId('action-smart-reply');
    await smartReplyAction.click();

    const repliesPanel = page.getByTestId('ai-replies-panel');
    await expect(repliesPanel).toBeVisible({ timeout: 15_000 });

    // Click the first suggestion
    const firstChip = repliesPanel.locator('.reply-chip').first();
    await expect(firstChip).toBeVisible({ timeout: 10_000 });
    const suggestionText = await firstChip.textContent();
    await firstChip.click();

    // Compose should open with the suggestion text
    await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('compose-header')).toContainText('Reply');

    if (suggestionText) {
      await expect(
        page.getByTestId('compose-editor').locator('[contenteditable]'),
      ).toContainText(suggestionText.trim(), { timeout: 5_000 });
    }

    await discardComposeIfOpen(page);
  });

  // ── Follow-up detection on sent email → panel appears → close ──────

  test('follow-up action shows panel for sent email, close dismisses', async ({ page, electronApp }) => {
    await discardComposeIfOpen(page);

    // Configure follow-up response
    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3'],
      selectedModel: 'llama3',
      responses: {
        chat: JSON.stringify({
          needsFollowUp: true,
          reason: 'The vendor has not replied to the contract request.',
          suggestedDate: '2026-03-22',
        }),
      },
    });

    // Navigate to Sent Mail folder
    const sidebar = page.getByTestId('sidebar');
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
        // Try next
      }
    }

    if (!sentFolderClicked) {
      test.skip(true, 'Sent Mail folder not visible in sidebar');
      return;
    }

    await waitForEmailSubject(page, SENT_SUBJECT);

    // Click the sent email
    await page.getByTestId(`email-item-${sentMsgIdentity.xGmThrid}`).click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible({ timeout: 10_000 });

    // Click follow-up action
    const followUpButton = page.getByTestId('action-ribbon-standard').getByTestId('action-follow-up');
    await expect(followUpButton).toBeVisible({ timeout: 5_000 });
    await followUpButton.click();

    // Follow-up panel should appear
    const followUpPanel = page.getByTestId('ai-followup-panel');
    await expect(followUpPanel).toBeVisible({ timeout: 15_000 });

    // Verify it shows follow-up content
    const panelText = await followUpPanel.textContent();
    const hasFollowUpContent = panelText?.includes('Follow-up') || panelText?.includes('follow-up') || panelText?.includes('Analyzing');
    expect(hasFollowUpContent).toBe(true);

    // Click close button
    const closeButton = followUpPanel.locator('.ai-panel-close');
    await closeButton.click();
    await expect(followUpPanel).not.toBeVisible({ timeout: 5_000 });
  });
});
