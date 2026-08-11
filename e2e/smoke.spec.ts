import { expect, test } from '@playwright/test';
import { installPlaywrightIpc } from './helpers';

test('renders the sign-in screen', async ({ page }) => {
  await installPlaywrightIpc(page);
  await page.goto('/');
  await expect(page.getByTestId('sign-in-screen')).toBeVisible();
});
