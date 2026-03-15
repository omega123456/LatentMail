import { test, expect } from '../infrastructure/electron-fixture';
import {
  configureOllama,
  extractSeededAccount,
  navigateToSettings,
  returnToMailShell,
  waitForMailShell,
} from '../infrastructure/helpers';

test.describe('Settings advanced', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let email: string;

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email } = extractSeededAccount(result));
    await waitForMailShell(page);
  });

  // --- General Settings: Layout radio persistence ---

  test('layout radio persists after navigation', async ({ page }) => {
    await navigateToSettings(page, 'general');

    await page.getByTestId('setting-layout').getByText('Bottom preview').click();
    await returnToMailShell(page);
    await navigateToSettings(page, 'general');

    const bottomRadio = page
      .getByTestId('setting-layout')
      .locator('mat-radio-button', { hasText: 'Bottom preview' });
    await expect(bottomRadio).toHaveClass(/mat-mdc-radio-checked/);
  });

  // --- General Settings: Density radio persistence ---

  test('density radio persists after navigation', async ({ page }) => {
    await navigateToSettings(page, 'general');

    await page.getByTestId('setting-density').getByText('Spacious').click();
    await returnToMailShell(page);
    await navigateToSettings(page, 'general');

    const spaciousRadio = page
      .getByTestId('setting-density')
      .locator('mat-radio-button', { hasText: 'Spacious' });
    await expect(spaciousRadio).toHaveClass(/mat-mdc-radio-checked/);
  });

  // --- General Settings: Desktop notifications toggle ---

  test('desktop notifications toggle changes state', async ({ page }) => {
    await navigateToSettings(page, 'general');

    const toggle = page.getByTestId('setting-notifications');
    const toggleButton = toggle.locator('button');
    const before = await toggleButton.getAttribute('aria-checked');
    const expectedAfter = before === 'true' ? 'false' : 'true';

    await toggle.click();

    await expect(toggleButton).toHaveAttribute('aria-checked', expectedAfter);
  });

  // --- General Settings: Show sender avatars toggle ---

  test('sender avatars toggle changes state', async ({ page }) => {
    await navigateToSettings(page, 'general');

    const toggle = page.getByTestId('setting-avatars');
    const toggleButton = toggle.locator('button');
    const before = await toggleButton.getAttribute('aria-checked');
    const expectedAfter = before === 'true' ? 'false' : 'true';

    await toggle.click();

    await expect(toggleButton).toHaveAttribute('aria-checked', expectedAfter);
  });

  // --- General Settings: Sync interval dropdown ---

  test('sync interval dropdown allows selection', async ({ page }) => {
    await navigateToSettings(page, 'general');

    const syncSelect = page
      .locator('section')
      .filter({ has: page.locator('h3', { hasText: 'Sync' }) })
      .locator('mat-select');

    await syncSelect.click();
    await page.locator('mat-option').filter({ hasText: 'Every 10 minutes' }).click();

    await expect(syncSelect).toContainText('Every 10 minutes');
  });

  // --- AI Settings: Disconnected status ---

  test('AI shows disconnected status when Ollama is not configured', async ({ page, electronApp }) => {
    await configureOllama(electronApp, { healthy: false, models: [] });
    await navigateToSettings(page, 'ai');

    await expect(page.getByTestId('ai-status-indicator')).toContainText('Disconnected', {
      timeout: 10_000,
    });
  });

  // --- AI Settings: Connected status ---

  test('AI shows connected status after configuring Ollama', async ({ page, electronApp }) => {
    await returnToMailShell(page);

    await configureOllama(electronApp, {
      healthy: true,
      models: ['llama3', 'mistral'],
      selectedModel: 'llama3',
    });

    await navigateToSettings(page, 'ai');

    await expect(page.getByTestId('ai-status-indicator')).toContainText('Connected', {
      timeout: 10_000,
    });
  });

  // --- AI Settings: Model list renders ---

  test('AI model list renders model cards', async ({ page }) => {
    const modelSelect = page.getByTestId('ai-model-select');

    await expect(modelSelect).toBeVisible();
    await expect(modelSelect.locator('.model-card').first()).toBeVisible();
  });

  // --- AI Settings: Select model ---

  test('clicking a model card marks it as selected', async ({ page }) => {
    const modelSelect = page.getByTestId('ai-model-select');
    const firstCard = modelSelect.locator('.model-card').first();

    await firstCard.click();

    await expect(firstCard).toHaveClass(/selected/);
  });

  // --- AI Settings: Available Features section ---

  test('AI settings shows available features', async ({ page }) => {
    const content = page.getByTestId('settings-content');

    const hasFeature = await Promise.any([
      content.getByText('Thread Summary').isVisible().then((v) => v),
      content.getByText('Smart Reply').isVisible().then((v) => v),
      content.getByText('AI Compose').isVisible().then((v) => v),
    ]).catch(() => false);

    expect(hasFeature).toBe(true);
  });

  // --- Account Settings: Account card shows email ---

  test('account card displays the seeded email', async ({ page }) => {
    await navigateToSettings(page, 'accounts');

    const accountCard = page.getByTestId(`account-card-${accountId}`);
    await expect(accountCard).toContainText(email);
  });

  // --- Account Settings: Remove account → Cancel ---

  test('remove account cancel keeps the account card', async ({ page }) => {
    await navigateToSettings(page, 'accounts');

    await page.getByTestId(`remove-account-button-${accountId}`).click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();

    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).not.toBeVisible();

    await expect(page.getByTestId(`account-card-${accountId}`)).toBeVisible();
  });

  // --- Account Settings: Add account button visible ---

  test('add account button is visible', async ({ page }) => {
    await navigateToSettings(page, 'accounts');

    await expect(page.getByTestId('add-account-button')).toBeVisible();
  });

  // --- Phase H: Keyboard settings - edit and reset keybinding ---

  test('keyboard settings renders shortcut list with commands', async ({ page }) => {
    await navigateToSettings(page, 'keyboard');

    const shortcutList = page.locator('[data-testid="keyboard-shortcut-list"]');
    await expect(shortcutList).toBeVisible();

    const commandRows = shortcutList.locator('.command-row');
    await expect(commandRows.first()).toBeVisible();

    const rowCount = await commandRows.count();
    expect(rowCount).toBeGreaterThan(5);

    await expect(commandRows.first().locator('.key-badge')).toBeVisible();
  });

  // --- Phase H: Logger settings - change log level ---

  test('logger settings - change log level', async ({ page }) => {
    await navigateToSettings(page, 'logger');

    const logLevelSelect = page.locator('[data-testid="log-level-select"]');
    await expect(logLevelSelect).toBeVisible();

    await logLevelSelect.click();
    await page.locator('mat-option').filter({ hasText: 'Debug' }).click();

    await expect(logLevelSelect).toContainText('Debug');
  });
});
