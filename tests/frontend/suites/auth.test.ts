import { test, expect } from '../infrastructure/electron-fixture';

test.describe('Auth', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ resetApp }) => {
    await resetApp({ seedAccount: false });
  });

  test('shows auth landing page when no account exists', async ({ page }) => {
    await expect(page.getByTestId('auth-login-button')).toBeVisible();
  });

  test('sign-in button text contains "Sign in with Google"', async ({ page }) => {
    await expect(page.getByTestId('auth-login-button')).toContainText('Sign in with Google');
  });

  test('navigates to mail shell after account is seeded', async ({ page, resetApp }) => {
    await resetApp({ seedAccount: true });

    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('auth-login-button')).not.toBeVisible();
  });
});
