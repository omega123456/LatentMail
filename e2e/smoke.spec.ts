import { expect, test, type Locator } from '@playwright/test';
import { installPlaywrightIpc } from './helpers';
import { playwrightMailAccount } from '@/tests/playwright-fixtures';

test('renders the sign-in screen', async ({ page }) => {
  await installPlaywrightIpc(page);
  await page.goto('/');
  await expect(page.getByTestId('sign-in-screen')).toBeVisible();
});

// The row's open control covers the whole row via a stretched `after:inset-0`
// overlay, and the star escapes it with `z-10` — both are real-layout facts
// jsdom can't see, so they're asserted here rather than in Vitest.
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

// The selection policy is a chain — a Tailwind class in index.html, the
// generated utility, and inheritance through portalled overlays — and only a
// real browser resolves it. jsdom loads no stylesheet at all, so Vitest can
// see the class names but never the computed effect.
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
  // The composer is portalled onto `body`, so it inherits the app-wide
  // `select-none` unless it opts out — as do the fields nested inside it.
  expect(await userSelectOf(compose)).toBe('text');
  expect(await userSelectOf(compose.getByLabel('Subject'))).toBe('text');
});
