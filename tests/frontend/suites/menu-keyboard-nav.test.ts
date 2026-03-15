import { test, expect } from '../infrastructure/electron-fixture';
import type { Locator, Page } from '@playwright/test';
import {
  extractSeededAccount,
  injectInboxMessage,
  triggerSync,
  waitForMailShell,
  waitForEmailSubject,
} from '../infrastructure/helpers';

test.describe('Menu keyboard navigation', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    // Inject 2 emails for menu interaction testing
    await injectInboxMessage(electronApp, {
      from: 'keyboard-nav-1@example.com',
      to: seededEmail,
      subject: 'Keyboard Nav Email One',
      body: 'First email for keyboard navigation testing.',
    });

    await injectInboxMessage(electronApp, {
      from: 'keyboard-nav-2@example.com',
      to: seededEmail,
      subject: 'Keyboard Nav Email Two',
      body: 'Second email for keyboard navigation testing.',
    });

    await triggerSync(electronApp, accountId);
    await waitForMailShell(page);
    await waitForEmailSubject(page, 'Keyboard Nav Email One');
    await waitForEmailSubject(page, 'Keyboard Nav Email Two');

    // Create 2 user labels via sidebar UI (needed for labels-menu keyboard tests)
    await page.getByTestId('create-label-button').click();
    let addForm = page.locator('.add-form');
    await expect(addForm).toBeVisible();
    await addForm.locator('input').first().fill('NavLabel1');
    await addForm.locator('.preset-swatch').first().click();
    await addForm.getByText('Create').click();
    await expect(page.getByTestId('labels-section').getByText('NavLabel1')).toBeVisible();

    await page.getByTestId('create-label-button').click();
    addForm = page.locator('.add-form');
    await expect(addForm).toBeVisible();
    await addForm.locator('input').first().fill('NavLabel2');
    await addForm.locator('.preset-swatch').first().click();
    await addForm.getByText('Create').click();
    await expect(page.getByTestId('labels-section').getByText('NavLabel2')).toBeVisible();

    // Ensure we're viewing INBOX
    await page.getByTestId('folder-item-INBOX').click();
  });

  // ================================================================
  // Helper: select the email and ensure the reading pane is visible.
  // ================================================================

  async function ensureEmailSelected(page: Page): Promise<void> {
    await page.getByTestId('email-list-container')
      .getByText('Keyboard Nav Email One', { exact: true }).click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();
  }

  // ================================================================
  // Helper: dispatch a non-bubbling KeyboardEvent on a CDK overlay
  // element. This triggers Angular's (keydown) handler on the element
  // but prevents the event from reaching the document-level
  // KeyboardService listener, which would otherwise intercept
  // ArrowDown/ArrowUp and navigate the email list (destroying the
  // overlay in the process).
  // ================================================================

  async function pressKeyOnMenu(menuLocator: Locator, key: string): Promise<void> {
    await menuLocator.evaluate((element, keyArg) => {
      element.dispatchEvent(
        new (globalThis as /* eslint-disable-line @typescript-eslint/no-explicit-any */ any).KeyboardEvent('keydown', {
          key: keyArg,
          code: keyArg,
          bubbles: false,
          cancelable: true,
        })
      );
    }, key);
  }

  // ================================================================
  // Helper: close a CDK overlay menu by clicking its trigger button
  // (toggle). This avoids pressing Escape which also fires the global
  // keyboard shortcut that deselects the email.
  // ================================================================

  async function closeMenuByTrigger(
    page: Page,
    triggerTestId: string,
    menuTestId: string
  ): Promise<void> {
    const menu = page.locator(`[data-testid="${menuTestId}"]`);
    const isVisible = await menu.isVisible();
    if (isVisible) {
      await page.getByTestId('action-ribbon-standard').getByTestId(triggerTestId).click();
      await expect(menu).not.toBeVisible();
    }
  }

  // ================================================================
  // Search bar keyboard tests
  // ================================================================

  test('search: type query then Escape clears the input value', async ({ page }) => {
    const searchInput = page.getByTestId('search-input');
    await searchInput.click();
    await searchInput.fill('test query');
    await expect(searchInput).toHaveValue('test query');

    await page.keyboard.press('Escape');
    await expect(searchInput).toHaveValue('');
  });

  test('search: type query then click clear button clears the input', async ({ page }) => {
    const searchInput = page.getByTestId('search-input');
    await searchInput.click();
    await searchInput.fill('another query');
    await expect(searchInput).toHaveValue('another query');

    await page.getByTestId('search-clear-button').click();
    await expect(searchInput).toHaveValue('');
  });

  test('search: Escape on empty focused input blurs it', async ({ page }) => {
    const searchInput = page.getByTestId('search-input');
    await searchInput.click();
    await expect(searchInput).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(searchInput).not.toBeFocused();
  });

  // ================================================================
  // Labels menu keyboard tests
  //
  // Keyboard events on CDK overlay menus are dispatched via a helper
  // that creates non-bubbling KeyboardEvents. This ensures the event
  // is processed by Angular's (keydown) handler on the dropdown but
  // does NOT propagate to the document-level KeyboardService, which
  // would intercept ArrowDown/ArrowUp as "nav-next"/"nav-prev" email
  // list navigation commands — causing the selected thread to change
  // and the CDK overlay to be destroyed.
  //
  // The first test selects an email; subsequent tests reuse it.
  // Menus are closed via trigger-button toggle (not Escape) to avoid
  // the global Escape shortcut deselecting the email.
  // ================================================================

  test('labels menu: opens when action button is clicked', async ({ page }) => {
    // Select an email so the action ribbon buttons become enabled
    await ensureEmailSelected(page);

    // Open labels menu via the action ribbon trigger
    await page.getByTestId('action-ribbon-standard').getByTestId('action-labels').click();

    const labelsMenu = page.locator('[data-testid="labels-menu"]');
    await expect(labelsMenu).toBeVisible();

    // Close the menu via toggle so next test starts clean
    await closeMenuByTrigger(page, 'action-labels', 'labels-menu');
  });

  test('labels menu: ArrowDown focuses the first label item', async ({ page }) => {
    // Open labels menu — email is already selected from previous test
    await page.getByTestId('action-ribbon-standard').getByTestId('action-labels').click();

    const labelsMenu = page.locator('[data-testid="labels-menu"]');
    await expect(labelsMenu).toBeVisible({ timeout: 3_000 });
    await expect(labelsMenu.locator('.label-item').first()).toBeVisible({ timeout: 5_000 });

    // Dispatch a non-bubbling ArrowDown to the dropdown
    await pressKeyOnMenu(labelsMenu, 'ArrowDown');

    const firstItem = labelsMenu.locator('.label-item').first();
    await expect(firstItem).toHaveClass(/focused/, { timeout: 3_000 });

    // Close the menu via toggle
    await closeMenuByTrigger(page, 'action-labels', 'labels-menu');
  });

  test('labels menu: second ArrowDown moves focus to the next item', async ({ page }) => {
    await page.getByTestId('action-ribbon-standard').getByTestId('action-labels').click();

    const labelsMenu = page.locator('[data-testid="labels-menu"]');
    await expect(labelsMenu).toBeVisible({ timeout: 3_000 });
    await expect(labelsMenu.locator('.label-item').first()).toBeVisible({ timeout: 5_000 });

    await pressKeyOnMenu(labelsMenu, 'ArrowDown');
    await expect(labelsMenu.locator('.label-item').first()).toHaveClass(/focused/);

    await pressKeyOnMenu(labelsMenu, 'ArrowDown');

    const secondItem = labelsMenu.locator('.label-item').nth(1);
    await expect(secondItem).toHaveClass(/focused/);

    // First item should no longer be focused
    const firstItem = labelsMenu.locator('.label-item').first();
    await expect(firstItem).not.toHaveClass(/focused/);

    // Close the menu via toggle
    await closeMenuByTrigger(page, 'action-labels', 'labels-menu');
  });

  test('labels menu: ArrowUp moves focus back to the previous item', async ({ page }) => {
    await page.getByTestId('action-ribbon-standard').getByTestId('action-labels').click();

    const labelsMenu = page.locator('[data-testid="labels-menu"]');
    await expect(labelsMenu).toBeVisible({ timeout: 3_000 });
    await expect(labelsMenu.locator('.label-item').first()).toBeVisible({ timeout: 5_000 });

    // Navigate down to second item, then back up
    await pressKeyOnMenu(labelsMenu, 'ArrowDown');
    await expect(labelsMenu.locator('.label-item').first()).toHaveClass(/focused/);
    await pressKeyOnMenu(labelsMenu, 'ArrowDown');
    await expect(labelsMenu.locator('.label-item').nth(1)).toHaveClass(/focused/);

    await pressKeyOnMenu(labelsMenu, 'ArrowUp');

    const firstItem = labelsMenu.locator('.label-item').first();
    await expect(firstItem).toHaveClass(/focused/);

    // Close the menu via toggle
    await closeMenuByTrigger(page, 'action-labels', 'labels-menu');
  });

  test('labels menu: Enter toggles the checkbox on the focused item', async ({ page }) => {
    await page.getByTestId('action-ribbon-standard').getByTestId('action-labels').click();

    const labelsMenu = page.locator('[data-testid="labels-menu"]');
    await expect(labelsMenu).toBeVisible({ timeout: 3_000 });
    await expect(labelsMenu.locator('.label-item').first()).toBeVisible({ timeout: 5_000 });

    // Move focus to first item
    await pressKeyOnMenu(labelsMenu, 'ArrowDown');

    const firstItem = labelsMenu.locator('.label-item').first();
    await expect(firstItem).toHaveClass(/focused/);

    // Checkbox should initially be unchecked
    const checkbox = firstItem.locator('.label-checkbox');
    await expect(checkbox).not.toHaveClass(/checked/);

    // Press Enter to toggle the label selection
    await pressKeyOnMenu(labelsMenu, 'Enter');

    // Checkbox should now be checked
    await expect(checkbox).toHaveClass(/checked/);

    // Close the menu via toggle
    await closeMenuByTrigger(page, 'action-labels', 'labels-menu');
  });

  test('labels menu: Escape closes the menu', async ({ page }) => {
    await page.getByTestId('action-ribbon-standard').getByTestId('action-labels').click();

    const labelsMenu = page.locator('[data-testid="labels-menu"]');
    await expect(labelsMenu).toBeVisible({ timeout: 3_000 });

    // Use the non-bubbling key dispatch so the global Escape shortcut
    // (which deselects the email) does not fire.
    await pressKeyOnMenu(labelsMenu, 'Escape');
    await expect(labelsMenu).not.toBeVisible();
  });

  // ================================================================
  // Labels menu outside-click test
  // ================================================================

  test('labels menu: clicking outside the overlay closes the menu', async ({ page }) => {
    // Open labels menu
    await page.getByTestId('action-ribbon-standard').getByTestId('action-labels').click();
    const labelsMenu = page.locator('[data-testid="labels-menu"]');
    await expect(labelsMenu).toBeVisible();

    // Click outside the overlay — use the search bar which is always visible and outside the CDK overlay
    await page.getByTestId('search-input').click({ force: true });
    await expect(labelsMenu).not.toBeVisible();
  });

  // ================================================================
  // Move-to menu keyboard tests
  //
  // Same pattern as labels menu tests: non-bubbling key dispatch,
  // trigger-button toggle to close between tests.
  // ================================================================

  test('move-to menu: opens when action button is clicked', async ({ page }) => {
    // Re-select the email (previous test clicked outside which may have
    // changed focus / deselected the email)
    await ensureEmailSelected(page);

    // Open move-to menu via the action ribbon trigger
    await page.getByTestId('action-ribbon-standard').getByTestId('action-move-to').click();

    const moveToMenu = page.locator('[data-testid="move-to-menu"]');
    await expect(moveToMenu).toBeVisible();

    // Close the menu via toggle
    await closeMenuByTrigger(page, 'action-move-to', 'move-to-menu');
  });

  test('move-to menu: ArrowDown focuses the first folder item', async ({ page }) => {
    await page.getByTestId('action-ribbon-standard').getByTestId('action-move-to').click();

    const moveToMenu = page.locator('[data-testid="move-to-menu"]');
    await expect(moveToMenu).toBeVisible({ timeout: 3_000 });
    await expect(moveToMenu.locator('.folder-item').first()).toBeVisible({ timeout: 5_000 });

    await pressKeyOnMenu(moveToMenu, 'ArrowDown');

    const firstItem = moveToMenu.locator('.folder-item').first();
    await expect(firstItem).toHaveClass(/focused/);

    // Close the menu via toggle
    await closeMenuByTrigger(page, 'action-move-to', 'move-to-menu');
  });

  test('move-to menu: ArrowDown then ArrowUp navigates between items', async ({ page }) => {
    await page.getByTestId('action-ribbon-standard').getByTestId('action-move-to').click();

    const moveToMenu = page.locator('[data-testid="move-to-menu"]');
    await expect(moveToMenu).toBeVisible({ timeout: 3_000 });
    await expect(moveToMenu.locator('.folder-item').first()).toBeVisible({ timeout: 5_000 });

    await pressKeyOnMenu(moveToMenu, 'ArrowDown');
    await expect(moveToMenu.locator('.folder-item').first()).toHaveClass(/focused/);
    await pressKeyOnMenu(moveToMenu, 'ArrowDown');
    const secondItem = moveToMenu.locator('.folder-item').nth(1);
    await expect(secondItem).toHaveClass(/focused/);

    // Move back up to the first item
    await pressKeyOnMenu(moveToMenu, 'ArrowUp');
    const firstItem = moveToMenu.locator('.folder-item').first();
    await expect(firstItem).toHaveClass(/focused/);

    // Close the menu via toggle
    await closeMenuByTrigger(page, 'action-move-to', 'move-to-menu');
  });

  test('move-to menu: Escape closes the menu', async ({ page }) => {
    await page.getByTestId('action-ribbon-standard').getByTestId('action-move-to').click();

    const moveToMenu = page.locator('[data-testid="move-to-menu"]');
    await expect(moveToMenu).toBeVisible({ timeout: 3_000 });

    await pressKeyOnMenu(moveToMenu, 'Escape');
    await expect(moveToMenu).not.toBeVisible();
  });

  test('move-to menu: clicking outside the overlay closes the menu', async ({ page }) => {
    // Re-select email since previous test may not have clicked it
    await ensureEmailSelected(page);

    await page.getByTestId('action-ribbon-standard').getByTestId('action-move-to').click();

    const moveToMenu = page.locator('[data-testid="move-to-menu"]');
    await expect(moveToMenu).toBeVisible();

    // Click outside the overlay — use the search bar which is always visible and outside the CDK overlay
    await page.getByTestId('search-input').click({ force: true });
    await expect(moveToMenu).not.toBeVisible();
  });
});
