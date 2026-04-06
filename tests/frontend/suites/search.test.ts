import { DateTime } from 'luxon';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  clearMockIpc,
  configureOllama,
  emitRendererEvent,
  extractSeededAccount,
  injectInboxMessage,
  mockIpc,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
} from '../infrastructure/helpers';

function createUniqueToken(): string {
  return String(DateTime.utc().toMillis());
}

test.describe('Search', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  let searchableSubject: string;
  let nonMatchingSubject: string;
  let searchKeyword: string;

  test.afterEach(async ({ electronApp }) => {
    await clearMockIpc(electronApp);
  });

  async function reloadWindowWithFreshState(
    electronApp: import('playwright').ElectronApplication,
    page: import('@playwright/test').Page,
  ): Promise<void> {
    await Promise.all([
      page.waitForEvent('load', { timeout: 60_000 }),
      electronApp.evaluate(() => {
        const testGlobal = globalThis as import('../infrastructure/test-hooks-types').TestHookGlobal;
        return testGlobal.testHooks?.reloadWindow() ?? { success: false };
      }),
    ]);
  }

  async function runKeywordSearch(page: import('@playwright/test').Page): Promise<void> {
    const searchInput = page.getByTestId('search-input');

    await searchInput.click();
    await searchInput.fill(searchKeyword);
    await searchInput.press('Enter');
  }

  async function expectSearchResultsVisible(page: import('@playwright/test').Page): Promise<void> {
    await expect(page.getByTestId('search-result-folder')).toBeVisible();
    await waitForEmailSubject(page, searchableSubject);
    await expect(page.getByText(nonMatchingSubject)).not.toBeVisible();
  }

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    const uniqueToken = createUniqueToken();
    searchableSubject = `Search Match ${uniqueToken}`;
    nonMatchingSubject = `Search Other ${uniqueToken}`;
    searchKeyword = `Needle${uniqueToken}`;

    await injectInboxMessage(electronApp, {
      from: 'search-match@example.com',
      to: seededEmail,
      subject: searchableSubject,
      body: `This email contains the searchable keyword ${searchKeyword}.`,
    });

    await injectInboxMessage(electronApp, {
      from: 'search-other@example.com',
      to: seededEmail,
      subject: nonMatchingSubject,
      body: 'This email exists to ensure search narrows the list.',
    });

    await triggerSync(electronApp, accountId);
    await waitForMailShell(page);
    await waitForEmailSubject(page, searchableSubject);
  });

  test('search bar is visible', async ({ page }) => {
    await expect(page.getByTestId('search-bar')).toBeVisible();
    await expect(page.getByTestId('search-input')).toBeVisible();
  });

  test('typing in search bar and pressing Enter shows results', async ({ page }) => {
    await runKeywordSearch(page);
    await expectSearchResultsVisible(page);
  });

  test('background sync does not replace active search results with inbox', async ({ electronApp, page }) => {
    const searchInput = page.getByTestId('search-input');

    await runKeywordSearch(page);
    await expectSearchResultsVisible(page);

    await emitRendererEvent(electronApp, {
      channel: 'mail:sync',
      payload: {
        accountId: String(accountId),
        progress: 100,
        status: 'done',
      },
    });

    await page.waitForTimeout(300);

    await emitRendererEvent(electronApp, {
      channel: 'mail:folder-updated',
      payload: {
        accountId,
        folders: ['INBOX'],
        reason: 'sync',
        changeType: 'mixed',
      },
    });

    await expect(page.getByTestId('search-result-folder')).toBeVisible();
    await expect(searchInput).toHaveValue(searchKeyword);
    await expectSearchResultsVisible(page);
  });

  test('clearing search returns to folder view', async ({ page }) => {
    const searchInput = page.getByTestId('search-input');
    const dismissSearchButton = page.getByTestId('search-dismiss-button');
    const clearSearchButton = page.getByTestId('search-clear-button');

    await searchInput.click();
    await searchInput.fill(searchKeyword);
    await searchInput.press('Enter');
    await expect(page.getByTestId('search-result-folder')).toBeVisible();

    if (await dismissSearchButton.isVisible().catch(() => false)) {
      await dismissSearchButton.click();
    } else {
      await clearSearchButton.click();
    }

    await expect(page.getByTestId('search-result-folder')).toBeHidden();
    await expect(page.getByTestId('folder-item-INBOX')).toBeVisible();
    await expect(page.getByTestId('email-list-header')).toContainText('Inbox');
  });

  test('search mode toggle buttons are visible', async ({ electronApp, page }) => {
    await configureOllama(electronApp, {
      models: ['llama3', 'nomic-embed-text:latest'],
      selectedModel: 'llama3',
      healthy: true,
      enableAiChat: true,
    });

    await reloadWindowWithFreshState(electronApp, page);
    await waitForMailShell(page);

    const keywordModeButton = page.getByTestId('search-mode-keyword');
    const semanticModeButton = page.getByTestId('search-mode-semantic');

    await expect(keywordModeButton).toBeVisible({ timeout: 10_000 });
    await expect(semanticModeButton).toBeVisible({ timeout: 10_000 });
  });

  test('semantic search adopts an early batch token and shows partial results', async ({ electronApp, page }) => {
    await configureOllama(electronApp, {
      models: ['llama3', 'nomic-embed-text:latest'],
      selectedModel: 'llama3',
      healthy: true,
      enableAiChat: true,
    });

    await reloadWindowWithFreshState(electronApp, page);
    await waitForMailShell(page);

    const semanticModeButton = page.getByTestId('search-mode-semantic');
    await expect(semanticModeButton).toBeVisible({ timeout: 10_000 });
    await semanticModeButton.click();

    await mockIpc(electronApp, {
      channel: 'ai:search',
      response: { success: true, data: { searchToken: 'semantic-token-1' } },
      once: true,
    });

    await mockIpc(electronApp, {
      channel: 'mail:search-by-msgids',
      response: {
        success: true,
        data: [
          {
            id: 501,
            accountId,
            xGmThrid: 'semantic-search-thread-1',
            subject: searchableSubject,
            fromAddress: 'search-match@example.com',
            fromName: 'Search Match',
            snippet: `This email contains the searchable keyword ${searchKeyword}.`,
            lastMessageDate: DateTime.utc().toISO(),
            isRead: false,
            isStarred: false,
            hasAttachments: false,
            folder: 'Search Results',
            folders: ['INBOX'],
            messageCount: 1,
          },
        ],
      },
      once: true,
    });

    const searchInput = page.getByTestId('search-input');
    await searchInput.fill(searchKeyword);

    const searchPromise = searchInput.press('Enter');
    await searchPromise;

    await emitRendererEvent(electronApp, {
      channel: 'ai:search:batch',
      payload: {
        searchToken: 'semantic-token-1',
        msgIds: ['semantic-search-message-1'],
        phase: 'imap',
      },
    });

    await expect(page.locator('.search-stream-count')).toContainText('1 result', { timeout: 10_000 });

    await emitRendererEvent(electronApp, {
      channel: 'ai:search:complete',
      payload: {
        searchToken: 'semantic-token-1',
        status: 'partial',
        totalResults: 1,
      },
    });

    await expect(page.getByTestId('search-result-folder')).toBeVisible({ timeout: 5_000 });
    await waitForEmailSubject(page, searchableSubject);
  });
});
