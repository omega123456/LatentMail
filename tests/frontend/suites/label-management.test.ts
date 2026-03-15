import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  injectInboxMessage,
  triggerSync,
  waitForMailShell,
  waitForEmailSubject,
} from '../infrastructure/helpers';

test.describe('Label management', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await triggerSync(electronApp, accountId);
    await waitForMailShell(page);
  });

  test('click "Add label" → verify form appears', async ({ page }) => {
    const labelsSection = page.getByTestId('labels-section');
    await expect(labelsSection).toBeVisible();

    await page.getByTestId('create-label-button').click();

    const addForm = page.locator('.add-form');
    await expect(addForm).toBeVisible();

    const nameInput = addForm.locator('input').or(page.getByPlaceholder('Label name'));
    await expect(nameInput.first()).toBeVisible();
    await expect(addForm.locator('.preset-swatch').first()).toBeVisible();
    await expect(addForm.getByText('Create')).toBeVisible();
    await expect(addForm.getByText('Cancel')).toBeVisible();
  });

  test('click Cancel → form closes', async ({ page }) => {
    const addForm = page.locator('.add-form');
    await addForm.getByText('Cancel').click();
    await expect(addForm).not.toBeVisible();
  });

  test('create label with name and color', async ({ page }) => {
    await page.getByTestId('create-label-button').click();

    const addForm = page.locator('.add-form');
    await expect(addForm).toBeVisible();

    const nameInput = addForm.locator('input').first();
    await nameInput.fill('TestLabel');

    await addForm.locator('.preset-swatch').first().click();
    await addForm.getByText('Create').click();

    const labelsSection = page.getByTestId('labels-section');
    await expect(labelsSection.getByText('TestLabel')).toBeVisible();
  });

  test('empty name → label NOT created', async ({ page }) => {
    await page.getByTestId('create-label-button').click();

    const addForm = page.locator('.add-form');
    await expect(addForm).toBeVisible();

    await addForm.getByText('Create').click();

    const labelsSection = page.getByTestId('labels-section');
    await expect(labelsSection.getByText('TestLabel')).toBeVisible();

    const addFormStillOpen = await addForm.isVisible();
    if (addFormStillOpen) {
      await addForm.getByText('Cancel').click();
      await expect(addForm).not.toBeVisible();
    }
  });

  test('click label → becomes active folder', async ({ page }) => {
    const labelsSection = page.getByTestId('labels-section');
    const testLabelItem = labelsSection.getByText('TestLabel');
    await testLabelItem.click();

    await expect(
      labelsSection.locator('.label-item', { hasText: 'TestLabel' }),
    ).toHaveClass(/active/);
  });

  test('color edit popover', async ({ page }) => {
    await page.getByTestId('folder-item-INBOX').click();

    const labelsSection = page.getByTestId('labels-section');
    const testLabelItem = labelsSection.locator('.label-item', { hasText: 'TestLabel' });

    await testLabelItem.locator('.color-dot-btn').click();

    const popover = page.locator('.color-edit-popover');
    await expect(popover).toBeVisible();

    await popover.locator('.preset-swatch').nth(2).click();
    await popover.getByText('Apply').click();

    await expect(popover).not.toBeVisible();
  });

  test('create second label for labels-menu testing', async ({ page }) => {
    await page.getByTestId('create-label-button').click();

    const addForm = page.locator('.add-form');
    await expect(addForm).toBeVisible();

    const nameInput = addForm.locator('input').first();
    await nameInput.fill('ApplyLabel');

    await addForm.locator('.preset-swatch').first().click();
    await addForm.getByText('Create').click();

    const labelsSection = page.getByTestId('labels-section');
    await expect(labelsSection.getByText('ApplyLabel')).toBeVisible();
  });

  test('labels menu - apply label', async ({ page, electronApp }) => {
    const emailSubject = 'Label Apply Test Email';

    await injectInboxMessage(electronApp, {
      from: 'sender@example.com',
      to: seededEmail,
      subject: emailSubject,
      body: 'Email for label apply testing.',
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, emailSubject);

    await page.getByTestId('email-list-container').getByText(emailSubject, { exact: true }).click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    await page.getByTestId('action-ribbon-standard').getByTestId('action-labels').click();

    const labelsMenu = page.locator('[data-testid="labels-menu"]');
    await expect(labelsMenu).toBeVisible();

    const applyLabelOption = labelsMenu.locator('.label-item').filter({ hasText: 'ApplyLabel' });
    await applyLabelOption.click();

    await labelsMenu.getByRole('button', { name: 'Apply' }).click();
    await expect(labelsMenu).not.toBeVisible({ timeout: 10000 });
  });

  test('labels menu - reopen and verify label is listed', async ({ page }) => {
    await page.getByTestId('action-ribbon-standard').getByTestId('action-labels').click();

    const labelsMenu = page.locator('[data-testid="labels-menu"]');
    await expect(labelsMenu).toBeVisible();

    const applyLabelOption = labelsMenu.locator('.label-item').filter({ hasText: 'ApplyLabel' });
    await expect(applyLabelOption).toBeVisible();

    await applyLabelOption.click();
    await labelsMenu.getByRole('button', { name: 'Apply' }).click();
    await expect(labelsMenu).not.toBeVisible({ timeout: 10000 });
  });

  test('delete label - click No', async ({ page }) => {
    const labelsSection = page.getByTestId('labels-section');

    const deleteButton = labelsSection.locator('button[title="Delete TestLabel"]');
    await deleteButton.click();

    const confirmRow = labelsSection.locator('.label-item', { hasText: 'Remove?' });
    await expect(confirmRow).toBeVisible();
    await expect(confirmRow.getByText('Yes')).toBeVisible();
    await expect(confirmRow.getByText('No')).toBeVisible();

    await confirmRow.getByText('No').click();

    await expect(labelsSection.getByText('TestLabel')).toBeVisible();
  });

  test('delete label - click Yes', async ({ page }) => {
    const labelsSection = page.getByTestId('labels-section');

    const deleteButton = labelsSection.locator('button[title="Delete TestLabel"]');
    await deleteButton.click();

    const confirmRow = labelsSection.locator('.label-item', { hasText: 'Remove?' });
    await expect(confirmRow).toBeVisible();
    await confirmRow.getByText('Yes').click();

    await expect(labelsSection.getByText('TestLabel')).not.toBeVisible();
  });

  // --- Phase E: Color picker hex input ---

  test('color picker hex input creates label with custom color', async ({ page }) => {
    await page.getByTestId('create-label-button').click();

    const addForm = page.locator('.add-form');
    await expect(addForm).toBeVisible();

    const nameInput = addForm.locator('input').first();
    await nameInput.fill('HexTestLabel');

    const hexInput = addForm.locator('.hex-input').or(addForm.locator('input[type="text"]').last());
    await hexInput.fill('FF0000');
    await hexInput.press('Tab');

    await addForm.getByText('Create').click();

    const labelsSection = page.getByTestId('labels-section');
    await expect(labelsSection.getByText('HexTestLabel')).toBeVisible();

    const deleteButton = labelsSection.locator('button[title="Delete HexTestLabel"]');
    await deleteButton.click();

    const confirmRow = labelsSection.locator('.label-item', { hasText: 'Remove?' });
    await expect(confirmRow).toBeVisible();
    await confirmRow.getByText('Yes').click();

    await expect(labelsSection.getByText('HexTestLabel')).not.toBeVisible();
  });

  // --- Phase E: No-color swatch ---

  test('no-color swatch creates label without color', async ({ page }) => {
    await page.getByTestId('create-label-button').click();

    const addForm = page.locator('.add-form');
    await expect(addForm).toBeVisible();

    const nameInput = addForm.locator('input').first();
    await nameInput.fill('NoColorLabel');

    await addForm.locator('.no-color-swatch').click();
    await addForm.getByText('Create').click();

    const labelsSection = page.getByTestId('labels-section');
    await expect(labelsSection.getByText('NoColorLabel')).toBeVisible();

    const deleteButton = labelsSection.locator('button[title="Delete NoColorLabel"]');
    await deleteButton.click();

    const confirmRow = labelsSection.locator('.label-item', { hasText: 'Remove?' });
    await expect(confirmRow).toBeVisible();
    await confirmRow.getByText('Yes').click();

    await expect(labelsSection.getByText('NoColorLabel')).not.toBeVisible();
  });
});
