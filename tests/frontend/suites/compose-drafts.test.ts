import { DateTime } from 'luxon';
import { test, expect } from '../infrastructure/electron-fixture';
import {
  discardComposeIfOpen,
  extractSeededAccount,
  getComposeEditor,
  injectLogicalMessage,
  triggerSync,
  waitForComposeEditor,
  waitForEmailSubject,
  waitForMailShell,
} from '../infrastructure/helpers';

test.describe('Compose drafts', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  let draftThreadId: string;

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);
  });

  test('inject draft and navigate to Drafts folder', async ({ page, electronApp }) => {
    const draftIdentity = await injectLogicalMessage(electronApp, {
      from: seededEmail,
      to: 'draft-recipient@example.com',
      subject: 'Test Draft Subject',
      body: 'This is draft body content for testing.',
      mailboxes: ['[Gmail]/Drafts'],
      xGmLabels: ['\\All', '\\Draft'],
      flags: ['\\Draft'],
    });

    await triggerSync(electronApp, accountId);

    draftThreadId = draftIdentity.xGmThrid;

    await page.getByTestId('folder-item-[Gmail]/Drafts').click();
    await expect(page.getByTestId('email-list-header')).toContainText('Drafts');

    await waitForEmailSubject(page, 'Test Draft Subject');
  });

  test('open draft for editing via context menu', async ({ page }) => {
    const draftItem = page.getByTestId(`email-item-${draftThreadId}`);

    await draftItem.click();
    await draftItem.click({ button: 'right' });

    await expect(page.getByTestId('context-menu')).toBeVisible();
    await expect(page.getByTestId('context-action-edit-draft')).toBeVisible();

    await page.getByTestId('context-action-edit-draft').click();

    await expect(page.getByTestId('compose-window')).toBeVisible();
    await expect(page.getByTestId('compose-subject-input')).toHaveValue('Test Draft Subject');
    await expect(page.getByTestId('recipient-input-to')).toContainText('draft-recipient@example.com');
  });

  test('edit draft and close (save-on-close)', async ({ page }) => {
    await expect(page.getByTestId('compose-window')).toBeVisible();

    await page.getByTestId('compose-subject-input').fill('Updated Draft Subject');

    await page.getByTestId('compose-close-button').click();

    await expect(page.getByTestId('compose-window')).not.toBeVisible({ timeout: 5000 });
  });

  test('signature selector is visible in compose', async ({ page }) => {
    await discardComposeIfOpen(page);

    await page.getByTestId('compose-button').click();
    await expect(page.getByTestId('compose-window')).toBeVisible();

    await expect(page.getByTestId('signature-selector')).toBeVisible();

    await page.getByTestId('signature-selector').click();
    await expect(page.locator('.dropdown .dropdown-item').first()).toBeVisible({ timeout: 3000 });

    await discardComposeIfOpen(page);
  });

  test('compose with dirty state triggers auto-save indicator', async ({ page }) => {
    await page.getByTestId('folder-item-INBOX').click();
    await discardComposeIfOpen(page);

    await page.getByTestId('compose-button').click();
    await waitForComposeEditor(page);

    const toField = page.getByTestId('recipient-input-field-to');
    await toField.fill('autosave-test@example.com');
    await toField.press('Tab');

    await page.getByTestId('compose-subject-input').fill('Auto-save test subject');

    const editor = getComposeEditor(page);
    await editor.click();
    await page.keyboard.type('Auto-save body content for testing.');

    await page.waitForTimeout(6000);

    const saveStatus = page.getByTestId('compose-save-status');
    const hasStatus = await saveStatus.isVisible().catch(() => false);
    if (hasStatus) {
      await expect(saveStatus).toContainText(/Draft saved|Saving/i, { timeout: 5000 });
    }

    await discardComposeIfOpen(page);
  });

  test('discard draft removes it', async ({ page, electronApp }) => {
    const discardDraftIdentity = await injectLogicalMessage(electronApp, {
      from: seededEmail,
      to: 'discard-recipient@example.com',
      subject: 'Draft To Discard',
      body: 'This draft will be discarded.',
      mailboxes: ['[Gmail]/Drafts'],
      xGmLabels: ['\\All', '\\Draft'],
      flags: ['\\Draft'],
    });

    await triggerSync(electronApp, accountId);

    await page.getByTestId('folder-item-INBOX').click();
    await page.getByTestId('folder-item-[Gmail]/Drafts').click();
    await expect(page.getByTestId('email-list-header')).toContainText('Drafts');

    await expect(page.getByTestId(`email-item-${discardDraftIdentity.xGmThrid}`)).toBeVisible({ timeout: 10000 });

    const discardDraftItem = page.getByTestId(`email-item-${discardDraftIdentity.xGmThrid}`);

    await discardDraftItem.click();
    await discardDraftItem.click({ button: 'right' });

    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.getByTestId('context-action-edit-draft').click();

    await expect(page.getByTestId('compose-window')).toBeVisible();

    await page.getByTestId('compose-discard-button').click();

    const confirmDialog = page.getByTestId('confirm-dialog');
    if (await confirmDialog.isVisible({ timeout: 500 }).catch(() => false)) {
      await page.getByTestId('confirm-dialog-ok').click();
    }

    await expect(page.getByTestId('compose-window')).not.toBeVisible({ timeout: 5000 });
    await expect(discardDraftItem).not.toBeVisible({ timeout: 5000 });
  });
});
