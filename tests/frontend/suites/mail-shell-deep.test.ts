import { DateTime } from 'luxon';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  clearMockIpc,
  discardComposeIfOpen,
  emitRendererEvent,
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
  injectInboxMessage,
  mockIpc,
  returnToMailShell,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
  type MessageIdentity,
} from '../infrastructure/helpers';

test.describe('Mail shell deep', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  const injectedMessages: MessageIdentity[] = [];

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await triggerSync(electronApp, accountId);
    await waitForMailShell(page);

    for (let i = 1; i <= 4; i++) {
      const identity = await injectInboxMessage(electronApp, {
        from: `deep-sender-${i}@example.com`,
        to: seededEmail,
        subject: `Deep Email ${i}`,
        body: `Body content for deep email ${i}.`,
      });
      injectedMessages.push(identity);
    }

    await triggerSync(electronApp, accountId);

    for (let i = 1; i <= 4; i++) {
      await waitForEmailSubject(page, `Deep Email ${i}`);
    }
  });

  test.afterEach(async ({ electronApp }) => {
    await clearMockIpc(electronApp);
  });

  test('multi-select bulk delete via context menu', async ({ page, electronApp }) => {
    const firstMsg = injectedMessages[0];
    const secondMsg = injectedMessages[1];
    const firstItem = page.getByTestId(`email-item-${firstMsg.xGmThrid}`);
    const secondItem = page.getByTestId(`email-item-${secondMsg.xGmThrid}`);

    const modifier = await getShortcutModifier(electronApp);

    await firstItem.click();
    await page.keyboard.down(modifier);
    await secondItem.click();
    await page.keyboard.up(modifier);

    await expect(firstItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    await expect(secondItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);

    await secondItem.click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();

    await page.getByTestId('context-action-delete').click();

    await expect(firstItem).not.toBeVisible({ timeout: 5000 });
    await expect(secondItem).not.toBeVisible({ timeout: 5000 });
  });

  test('multi-select bulk star via context menu', async ({ page, electronApp }) => {
    const msg3 = injectedMessages[2];
    const msg4 = injectedMessages[3];

    const extra1 = await injectInboxMessage(electronApp, {
      from: 'deep-extra-1@example.com',
      to: seededEmail,
      subject: 'Deep Extra Email 1',
      body: 'Extra email 1 for star test.',
    });

    const extra2 = await injectInboxMessage(electronApp, {
      from: 'deep-extra-2@example.com',
      to: seededEmail,
      subject: 'Deep Extra Email 2',
      body: 'Extra email 2 for star test.',
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, 'Deep Extra Email 1');
    await waitForEmailSubject(page, 'Deep Extra Email 2');

    const item3 = page.getByTestId(`email-item-${msg3.xGmThrid}`);
    const item4 = page.getByTestId(`email-item-${msg4.xGmThrid}`);
    const star3 = page.getByTestId(`email-star-${msg3.xGmThrid}`);
    const star4 = page.getByTestId(`email-star-${msg4.xGmThrid}`);

    const modifier = await getShortcutModifier(electronApp);

    await item3.click();
    await page.keyboard.down(modifier);
    await item4.click();
    await page.keyboard.up(modifier);

    await item3.click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();

    await page.getByTestId('context-action-star').click();

    await expect(star3).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
    await expect(star4).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
  });

  test('multi-select Escape clears selection', async ({ page, electronApp }) => {
    const msg3 = injectedMessages[2];
    const msg4 = injectedMessages[3];
    const item3 = page.getByTestId(`email-item-${msg3.xGmThrid}`);
    const item4 = page.getByTestId(`email-item-${msg4.xGmThrid}`);

    const modifier = await getShortcutModifier(electronApp);

    await item3.click();
    await page.keyboard.down(modifier);
    await item4.click();
    await page.keyboard.up(modifier);

    await expect(item3).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    await expect(item4).toHaveClass(/(^|\s)multi-selected(\s|$)/);

    await page.keyboard.press('Escape');

    await expect(item3).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
    await expect(item4).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
  });

  test('keyboard shortcut Shift+R opens reply-all compose', async ({ page, electronApp }) => {
    await discardComposeIfOpen(page);

    const replyAllMessage = await injectInboxMessage(electronApp, {
      from: 'deep-reply-all@example.com',
      to: seededEmail,
      subject: 'Deep Reply All Target',
      body: 'This message tests the Shift+R reply-all shortcut.',
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, 'Deep Reply All Target');

    await page.getByTestId(`email-item-${replyAllMessage.xGmThrid}`).click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    await focusMailShell(page);
    await page.keyboard.press('Shift+r');

    await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('compose-window')).toContainText('Reply');

    await discardComposeIfOpen(page);
  });

  test('search dismiss via X button returns to folder view', async ({ page }) => {
    const searchInput = page.getByTestId('search-input');

    await page.getByTestId('search-bar').click();
    await searchInput.fill('test query');
    await searchInput.press('Enter');

    await expect(
      page.getByTestId('search-result-folder').or(page.getByTestId('search-empty-state')),
    ).toBeVisible({ timeout: 5000 });

    const dismissButton = page.getByTestId('search-dismiss-button');
    const clearButton = page.getByTestId('search-clear-button');

    if (await dismissButton.isVisible().catch(() => false)) {
      await dismissButton.click();
    } else {
      await clearButton.click();
    }

    await expect(page.getByTestId('search-result-folder')).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId('email-list-header')).toContainText('Inbox', { timeout: 5000 });
  });

  test('mail shell and email list cover search streaming, retry, context actions, and notification flows', async ({
    page,
    electronApp,
  }) => {
    await returnToMailShell(page);
    await waitForMailShell(page);

    const subjectOne = `Shell Coverage One ${DateTime.utc().toMillis()}`;
    const subjectTwo = `Shell Coverage Two ${DateTime.utc().plus({ seconds: 1 }).toMillis()}`;

    await injectInboxMessage(electronApp, {
      from: 'shell-one@example.com',
      to: seededEmail,
      subject: subjectOne,
      body: 'First shell coverage message',
    });
    await injectInboxMessage(electronApp, {
      from: 'shell-two@example.com',
      to: seededEmail,
      subject: subjectTwo,
      body: 'Second shell coverage message',
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, subjectOne);
    await waitForEmailSubject(page, subjectTwo);

    await emitRendererEvent(electronApp, {
      channel: 'queue:update',
      payload: {
        queueId: 'queue-failed-send',
        accountId,
        type: 'send',
        status: 'failed',
        createdAt: DateTime.utc().toISO(),
        retryCount: 0,
        error: 'SMTP down',
        description: 'Send test mail',
      },
    });
    await expect(page.locator('.toast-message').filter({ hasText: 'Send test mail failed: SMTP down' })).toBeVisible();

    await emitRendererEvent(electronApp, {
      channel: 'queue:update',
      payload: {
        queueId: 'queue-complete-send',
        accountId,
        type: 'send',
        status: 'completed',
        createdAt: DateTime.utc().toISO(),
        retryCount: 0,
        description: 'Send complete mail',
      },
    });

    await emitRendererEvent(electronApp, {
      channel: 'body-queue:update',
      payload: {
        queueId: 'body-pending',
        accountId,
        type: 'body-fetch',
        status: 'pending',
        createdAt: DateTime.utc().toISO(),
        retryCount: 0,
        description: 'Prefetch body',
      },
    });

    await mockIpc(electronApp, {
      channel: 'ai:search',
      response: { success: true, data: { searchToken: 'stream-token-1' } },
      once: true,
    });
    await page.getByTestId('search-input').fill('stream coverage');
    await page.getByTestId('search-input').press('Enter');
    await expect(page.locator('.search-stream-count')).toContainText('Searching');

    await emitRendererEvent(electronApp, {
      channel: 'ai:search:batch',
      payload: {
        searchToken: 'stream-token-1',
        msgIds: [],
        phase: 'local',
      },
    });
    await emitRendererEvent(electronApp, {
      channel: 'ai:search:complete',
      payload: {
        searchToken: 'stream-token-1',
        status: 'partial',
        totalResults: 0,
      },
    });
    await expect(page.getByTestId('search-result-folder')).toBeVisible();
    await page.getByTestId('search-dismiss-button').click();
    await waitForEmailSubject(page, subjectOne);

    await emitRendererEvent(electronApp, {
      channel: 'mail:fetch-older-done',
      payload: {
        queueId: 'fetch-older-error',
        accountId,
        folderId: 'INBOX',
        error: 'Network issue',
      },
    });
    await expect(page.getByTestId('retry-fetch-button')).toBeVisible();

    await mockIpc(electronApp, {
      channel: 'mail:fetch-older',
      response: { success: true, data: { queueId: 'fetch-older-success' } },
      once: true,
    });
    await page.getByTestId('retry-fetch-button').click();
    await emitRendererEvent(electronApp, {
      channel: 'mail:fetch-older-done',
      payload: {
        queueId: 'fetch-older-success',
        accountId,
        folderId: 'INBOX',
        hasMore: false,
        nextBeforeDate: DateTime.utc().minus({ days: 1 }).toISO(),
        threads: [],
      },
    });

    await returnToMailShell(page);
    await waitForMailShell(page);
    await waitForEmailSubject(page, subjectOne);

    const firstThread = page.locator('[data-testid^="email-item-"]').first();
    await firstThread.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    await page.getByTestId('action-ribbon-standard').getByTestId('action-labels').click();
    const labelsMenu = page.getByTestId('labels-menu');
    await expect(labelsMenu).toBeVisible();
    const firstLabelOption = labelsMenu.locator('.label-item').first();
    if (await firstLabelOption.isVisible().catch(() => false)) {
      await firstLabelOption.click();
    }
    await labelsMenu.getByRole('button', { name: 'Apply' }).click();

    const firstThreadIdAttribute = await firstThread.getAttribute('data-testid');
    const firstThreadId = firstThreadIdAttribute?.replace('email-item-', '') ?? '';

    await emitRendererEvent(electronApp, {
      channel: 'mail:notification-click',
      payload: {
        accountId,
        xGmThrid: firstThreadId,
        folder: 'INBOX',
      },
    });
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();
  });
});
