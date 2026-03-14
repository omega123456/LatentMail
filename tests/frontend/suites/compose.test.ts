import { test, expect } from '../infrastructure/electron-fixture';
import {
  discardComposeIfOpen,
  extractSeededAccount,
  getComposeEditor,
  getSmtpCaptured,
  openCompose,
  waitForMailShell,
} from '../infrastructure/helpers';

interface CapturedEmail {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  raw: string;
}

async function closeComposeWindow(page: import('@playwright/test').Page): Promise<void> {
  await discardComposeIfOpen(page);
  await page.waitForTimeout(150);
}

async function openComposeWindow(page: import('@playwright/test').Page): Promise<void> {
  await closeComposeWindow(page);
  await openCompose(page);
  await expect(getComposeEditor(page)).toBeVisible();
}

async function addRecipient(page: import('@playwright/test').Page, emailAddress: string): Promise<void> {
  const toField = page.getByTestId('recipient-input-field-to');

  await toField.fill(emailAddress);
  await toField.press('Tab');

  await expect(page.getByTestId('recipient-input-to')).toContainText(emailAddress);
}

async function typeComposeBody(page: import('@playwright/test').Page, body: string): Promise<void> {
  const editor = getComposeEditor(page);

  await editor.click();
  await page.keyboard.type(body);
  await expect(editor).toContainText(body);
}

test.describe('Compose', () => {
  test.describe.configure({ mode: 'serial' });

  let seededEmail: string;

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ email: seededEmail } = extractSeededAccount(result));

    await waitForMailShell(page);
  });

  test('compose window opens when compose button is clicked', async ({ page }) => {
    await openComposeWindow(page);

    await expect(page.getByTestId('compose-window')).toBeVisible();

    await closeComposeWindow(page);
  });

  test('compose window shows the account email in the From field', async ({ page }) => {
    await openComposeWindow(page);

    await expect(page.getByTestId('compose-from-value')).toContainText(seededEmail);

    await closeComposeWindow(page);
  });

  test('accepts typed recipient address', async ({ page }) => {
    const recipientAddress = 'recipient.playwright@example.com';

    await openComposeWindow(page);
    await addRecipient(page, recipientAddress);

    await closeComposeWindow(page);
  });

  test('accepts subject text', async ({ page }) => {
    const subject = 'Compose subject acceptance test';

    await openComposeWindow(page);

    await page.getByTestId('compose-subject-input').fill(subject);

    await expect(page.getByTestId('compose-subject-input')).toHaveValue(subject);

    await closeComposeWindow(page);
  });

  test('sends an email and SMTP captures it', async ({ page, electronApp }) => {
    const recipientAddress = 'smtp-recipient@example.com';
    const subject = 'Playwright SMTP send verification';
    const body = 'This email body is sent from the frontend Playwright compose suite.';

    await openComposeWindow(page);
    await addRecipient(page, recipientAddress);
    await page.getByTestId('compose-subject-input').fill(subject);
    await typeComposeBody(page, body);

    await page.getByTestId('compose-send-button').click();
    await expect(page.getByTestId('compose-window')).not.toBeVisible();

    await expect.poll(async () => {
      const capturedEmails = (await getSmtpCaptured(electronApp)).emails as CapturedEmail[];
      const matchingEmail = capturedEmails.find((capturedEmail) => {
        return capturedEmail.subject === subject && capturedEmail.to.includes(recipientAddress);
      });

      if (matchingEmail === undefined) {
        return null;
      }

      return {
        subject: matchingEmail.subject,
        to: matchingEmail.to.join(','),
        body: matchingEmail.text ?? matchingEmail.raw,
      };
    }, { timeout: 30_000 }).toEqual({
      subject,
      to: recipientAddress,
      body,
    });
  });

  test('discard button closes compose window', async ({ page }) => {
    await openComposeWindow(page);

    await page.getByTestId('compose-discard-button').click();
    const confirmDialog = page.getByTestId('confirm-dialog');
    if (await confirmDialog.isVisible({ timeout: 500 }).catch(() => false)) {
      await page.getByTestId('confirm-dialog-ok').click();
    }

    await expect(page.getByTestId('compose-window')).not.toBeVisible();
  });

  test('close (X) button closes compose window', async ({ page }) => {
    await openComposeWindow(page);

    await page.getByTestId('compose-close-button').click();

    await expect(page.getByTestId('compose-window')).not.toBeVisible();
  });
});
