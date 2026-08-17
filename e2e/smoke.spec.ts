import { expect, test, type Locator } from '@playwright/test';
import { installPlaywrightIpc } from './helpers';
import { playwrightMailAccount } from '@/tests/playwright-fixtures';

test('renders the sign-in screen', async ({ page }) => {
  await installPlaywrightIpc(page);
  await page.goto('/');
  await expect(page.getByTestId('sign-in-screen')).toBeVisible();
});


test('the whole conversation row opens it, except the star', async ({ page }) => {
  await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
  await page.goto('/');
  const row = page.getByTestId('conversation-row').nth(1);
  await row.waitFor();
  const box = (await row.boundingBox())!;
  await page.mouse.click(box.x + box.width - 60, box.y + box.height - 4);
  await expect(row).toHaveAttribute('data-active', 'true');

  const other = page.getByTestId('conversation-row').nth(2);
  await other.getByRole('button', { name: /^Star / }).click();
  await expect(other).not.toHaveAttribute('data-active', 'true');
});


const userSelectOf = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).userSelect);

test('text selection is off by default and on for message content', async ({ page }) => {
  await installPlaywrightIpc(page, { list_accounts: [playwrightMailAccount] });
  await page.goto('/');
  expect(await userSelectOf(page.locator('body'))).toBe('none');

  const row = page.getByLabel('Open Q3 Marketing Strategy Review');
  await row.click();
  expect(await userSelectOf(row)).toBe('none');

  const reader = page.getByTestId('reading-pane');
  expect(await userSelectOf(reader.getByRole('heading', { level: 1 }))).toBe('text');
  expect(await userSelectOf(reader.locator('header').first())).toBe('text');
});

test('text selection is on throughout the compose window', async ({ page }) => {
  await installPlaywrightIpc(
    page,
    { list_accounts: [playwrightMailAccount] },
    undefined,
    undefined,
    [],
    [],
    {
      id: 'compose-selection',
      mode: 'new',
      accountId: 'mail-account',
      from: 'you@example.com',
      recipients: { to: [], cc: [], bcc: [] },
      subject: '',
      html: '',
    },
  );
  await page.goto('/');
  const compose = page.getByTestId('compose-overlay');
  await compose.waitFor();

  expect(await userSelectOf(compose)).toBe('text');
  expect(await userSelectOf(compose.getByLabel('Subject'))).toBe('text');
});
