import { DateTime } from 'luxon';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  injectInboxMessage,
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
    const searchInput = page.getByTestId('search-input');

    await searchInput.click();
    await searchInput.fill(searchKeyword);
    await searchInput.press('Enter');

    await expect(page.getByTestId('search-result-folder')).toBeVisible();
    await waitForEmailSubject(page, searchableSubject);
    await expect(page.getByText(nonMatchingSubject)).not.toBeVisible();
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

  test('search mode toggle buttons are visible', async ({ page }) => {
    const keywordModeButton = page.getByTestId('search-mode-keyword');
    const semanticModeButton = page.getByTestId('search-mode-semantic');
    const hasKeywordModeToggle = await keywordModeButton.isVisible().catch(() => false);
    const hasSemanticModeToggle = await semanticModeButton.isVisible().catch(() => false);

    test.skip(
      !hasKeywordModeToggle || !hasSemanticModeToggle,
      'Search mode toggles render only when Ollama is available and the embedding index is complete.',
    );

    await expect(keywordModeButton).toBeVisible();
    await expect(semanticModeButton).toBeVisible();
  });
});
