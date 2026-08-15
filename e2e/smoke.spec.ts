import { expect, test } from '@playwright/test';
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
