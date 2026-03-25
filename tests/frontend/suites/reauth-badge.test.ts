import { test, expect } from '../infrastructure/electron-fixture';
import { extractSeededAccount, waitForMailShell, setAccountReauth, getTrayReauthState } from '../infrastructure/helpers';

test.describe('Reauth Badge Indicator', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId } = extractSeededAccount(result));
    await waitForMailShell(page);
  });

  test('TrayService reflects needsReauth true when an account needs re-authentication', async ({ electronApp }) => {
    await setAccountReauth(electronApp, { accountId, needsReauth: true });

    const needsReauth = await getTrayReauthState(electronApp);
    expect(needsReauth).toBe(true);
  });

  test('TrayService clears needsReauth when reauth state is resolved', async ({ electronApp }) => {
    await setAccountReauth(electronApp, { accountId, needsReauth: false });

    const needsReauth = await getTrayReauthState(electronApp);
    expect(needsReauth).toBe(false);
  });
});
