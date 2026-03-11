import { expect } from 'chai';
import { app } from 'electron';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { DateTime } from 'luxon';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import { callIpc, waitForEvent, seedTestAccount } from '../infrastructure/test-helpers';
import { oauthServer } from '../test-main';
import { TestEventBus } from '../infrastructure/test-event-bus';
import { CredentialService } from '../../../electron/services/credential-service';
import { DatabaseService } from '../../../electron/services/database-service';
import { OAuthService } from '../../../electron/services/oauth-service';
import { OAuthLoopbackServer } from '../../../electron/services/oauth-loopback';
import { ImapService } from '../../../electron/services/imap-service';

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface AuthAccount {
  id: number;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

interface AuthEventPayload {
  authUrl: string;
  loopbackPort: number;
  state: string;
}

interface AccountSummary {
  id: number;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  isActive: boolean;
  needsReauth: boolean;
  lastSyncAt: string | null;
}

describe('Auth & Account Lifecycle', () => {
  before(async () => {
    await quiesceAndRestore();
  });

  beforeEach(async () => {
    await quiesceAndRestore();
    oauthServer.reset();
  });

  async function startLoginFlow(): Promise<{
    loginPromise: Promise<IpcResponse<AuthAccount>>;
    authEvent: AuthEventPayload;
  }> {
    const priorEventCount = TestEventBus.getInstance().getHistory('oauth:test-auth-url').length;
    const loginPromise = callIpc('auth:login') as Promise<IpcResponse<AuthAccount>>;
    const eventArgsList = await TestEventBus.getInstance().waitForN(
      'oauth:test-auth-url',
      priorEventCount + 1,
      5_000,
    );
    const authEvent = eventArgsList[eventArgsList.length - 1][0] as AuthEventPayload;
    return { loginPromise, authEvent };
  }

  function getCredentialsFilePath(): string {
    return path.join(app.getPath('userData'), 'credentials.enc');
  }

  async function triggerMismatchedState(loopbackPort: number): Promise<void> {
    const callbackUrl = `http://127.0.0.1:${loopbackPort}/callback?code=test_code&state=wrong_state`;
    await new Promise<void>((resolve, reject) => {
      const request = http.get(callbackUrl, (response) => {
        response.resume();
        response.on('end', () => {
          resolve();
        });
      });
      request.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  it('completes a fresh login flow, creates an account, stores tokens, and schedules refresh', async () => {
    oauthServer.setTokenConfig({
      accessToken: 'login-success-access-token',
      refreshToken: 'login-success-refresh-token',
      expiresIn: 3_600,
    });
    oauthServer.setUserInfo({
      email: 'fresh-login@example.com',
      name: 'Fresh Login User',
    });

    const { loginPromise, authEvent } = await startLoginFlow();
    await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state);
    const response = await loginPromise;

    expect(response.success).to.equal(true);
    expect(response.data).to.exist;
    expect(response.data!.email).to.equal('fresh-login@example.com');
    expect(response.data!.displayName).to.equal('Fresh Login User');

    const database = DatabaseService.getInstance();
    const account = database.getAccountById(response.data!.id);
    expect(account).to.not.be.null;
    expect(account!.email).to.equal('fresh-login@example.com');

    const credentialService = CredentialService.getInstance();
    const storedTokens = credentialService.getTokens(String(response.data!.id));
    expect(storedTokens).to.not.be.null;
    expect(storedTokens!.accessToken).to.equal('login-success-access-token');
    expect(storedTokens!.refreshToken).to.equal('login-success-refresh-token');
    expect(fs.existsSync(getCredentialsFilePath())).to.equal(true);

    const oauthService = OAuthService.getInstance() as unknown as {
      refreshTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    expect(oauthService.refreshTimers.has(String(response.data!.id))).to.equal(true);

    const capturedEndpoints = oauthServer.getCapturedRequests().map((request) => request.endpoint);
    expect(capturedEndpoints).to.include('/o/oauth2/token');
    expect(capturedEndpoints).to.include('/oauth2/v3/userinfo');
  });

  it('updates an existing account on login instead of creating a duplicate', async () => {
    oauthServer.setTokenConfig({
      accessToken: 'existing-account-access-token-1',
      refreshToken: 'existing-account-refresh-token-1',
    });
    oauthServer.setUserInfo({
      email: 'existing@example.com',
      name: 'Original Name',
    });

    const firstLogin = await startLoginFlow();
    await oauthServer.triggerCallback(firstLogin.authEvent.loopbackPort, firstLogin.authEvent.state);
    const firstResponse = await firstLogin.loginPromise;
    expect(firstResponse.success).to.equal(true);

    oauthServer.reset();
    oauthServer.setTokenConfig({
      accessToken: 'existing-account-access-token-2',
      refreshToken: 'existing-account-refresh-token-2',
    });
    oauthServer.setUserInfo({
      email: 'existing@example.com',
      name: 'Updated Name',
    });

    const secondLogin = await startLoginFlow();
    await oauthServer.triggerCallback(secondLogin.authEvent.loopbackPort, secondLogin.authEvent.state);
    const secondResponse = await secondLogin.loginPromise;
    expect(secondResponse.success).to.equal(true);
    expect(secondResponse.data!.id).to.equal(firstResponse.data!.id);

    const countResponse = await callIpc('auth:get-account-count') as IpcResponse<number>;
    expect(countResponse.success).to.equal(true);
    expect(countResponse.data).to.equal(1);

    const accountsResponse = await callIpc('auth:get-accounts') as IpcResponse<AccountSummary[]>;
    expect(accountsResponse.success).to.equal(true);
    expect(accountsResponse.data).to.have.lengthOf(1);
    expect(accountsResponse.data![0].displayName).to.equal('Updated Name');

    const storedTokens = CredentialService.getInstance().getTokens(String(firstResponse.data!.id));
    expect(storedTokens!.accessToken).to.equal('existing-account-access-token-2');
  });

  it('returns AUTH_DENIED when the user denies consent', async () => {
    oauthServer.setUserInfo({ email: 'denied@example.com', name: 'Denied User' });

    const { loginPromise, authEvent } = await startLoginFlow();
    await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state, { error: 'access_denied' });
    const response = await loginPromise;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('AUTH_DENIED');
  });

  it('returns AUTH_TIMEOUT when the loopback flow times out', async function () {
    this.timeout(10_000);

    const originalStart = OAuthLoopbackServer.prototype.start;
    OAuthLoopbackServer.prototype.start = function (expectedState: string): Promise<{ port: number; callbackPromise: Promise<{ code: string; state: string }> }> {
      return originalStart.call(this, expectedState, 50);
    };

    try {
      const response = await callIpc('auth:login') as IpcResponse<AuthAccount>;
      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AUTH_TIMEOUT');
    } finally {
      OAuthLoopbackServer.prototype.start = originalStart;
    }
  });

  it('fails the login when the callback state does not match', async () => {
    oauthServer.setUserInfo({ email: 'state-mismatch@example.com', name: 'State Mismatch User' });

    const { loginPromise, authEvent } = await startLoginFlow();
    await triggerMismatchedState(authEvent.loopbackPort);
    const response = await loginPromise;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('AUTH_LOGIN_FAILED');
    expect(response.error!.message).to.include('OAuth state mismatch');
  });

  it('returns AUTH_LOGIN_FAILED when token exchange fails', async () => {
    oauthServer.setErrorConfig({ tokenError: 'invalid_grant' });

    const { loginPromise, authEvent } = await startLoginFlow();
    await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state);
    const response = await loginPromise;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('AUTH_LOGIN_FAILED');
  });

  it('refreshes an expired token and stores the updated tokens', async () => {
    const seededAccount = seedTestAccount({
      email: 'refresh-success@example.com',
      accessToken: 'stale-access-token',
      refreshToken: 'refresh-success-token',
      expiresAt: DateTime.now().minus({ hours: 1 }).toMillis(),
    });

    oauthServer.setTokenConfig({
      accessToken: 'refreshed-access-token',
      refreshToken: 'refreshed-refresh-token',
      expiresIn: 3_600,
    });

    const refreshedAccessToken = await OAuthService.getInstance().refreshAccessToken(String(seededAccount.accountId));
    expect(refreshedAccessToken).to.equal('refreshed-access-token');

    const storedTokens = CredentialService.getInstance().getTokens(String(seededAccount.accountId));
    expect(storedTokens).to.not.be.null;
    expect(storedTokens!.accessToken).to.equal('refreshed-access-token');
    expect(storedTokens!.refreshToken).to.equal('refreshed-refresh-token');

    const tokenRequest = oauthServer.getCapturedRequests().find((request) => request.endpoint === '/o/oauth2/token');
    expect(tokenRequest).to.exist;
    expect(tokenRequest!.body).to.include('grant_type=refresh_token');
  });

  it('marks an account as needsReauth after repeated invalid_grant refresh failures', async function () {
    this.timeout(10_000);

    const seededAccount = seedTestAccount({
      email: 'invalid-grant@example.com',
      accessToken: 'expired-invalid-grant-token',
      refreshToken: 'refresh-invalid-grant-token',
      expiresAt: DateTime.now().minus({ hours: 1 }).toMillis(),
    });

    oauthServer.setErrorConfig({ tokenError: 'invalid_grant' });

    const originalSetTimeout = global.setTimeout;
    const fastSetTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
      return originalSetTimeout(callback, 0, ...args);
    }) as typeof setTimeout;
    global.setTimeout = fastSetTimeout;

    try {
      let caughtError: Error | null = null;
      try {
        await OAuthService.getInstance().refreshAccessToken(String(seededAccount.accountId));
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).to.not.be.null;
      expect(caughtError!.message).to.include('needs re-authentication');

      const accountsResponse = await callIpc('auth:get-accounts') as IpcResponse<AccountSummary[]>;
      expect(accountsResponse.success).to.equal(true);
      expect(accountsResponse.data).to.have.lengthOf(1);
      expect(accountsResponse.data![0].needsReauth).to.equal(true);
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  it('tracks account count across login and logout', async () => {
    oauthServer.setTokenConfig({
      accessToken: 'count-access-token',
      refreshToken: 'count-refresh-token',
    });
    oauthServer.setUserInfo({
      email: 'count@example.com',
      name: 'Count User',
    });

    const beforeResponse = await callIpc('auth:get-account-count') as IpcResponse<number>;
    expect(beforeResponse.success).to.equal(true);
    expect(beforeResponse.data).to.equal(0);

    const { loginPromise, authEvent } = await startLoginFlow();
    await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state);
    const loginResponse = await loginPromise;
    expect(loginResponse.success).to.equal(true);

    const afterLoginResponse = await callIpc('auth:get-account-count') as IpcResponse<number>;
    expect(afterLoginResponse.success).to.equal(true);
    expect(afterLoginResponse.data).to.equal(1);

    const logoutResponse = await callIpc('auth:logout', String(loginResponse.data!.id)) as IpcResponse<null>;
    expect(logoutResponse.success).to.equal(true);

    const afterLogoutResponse = await callIpc('auth:get-account-count') as IpcResponse<number>;
    expect(afterLogoutResponse.success).to.equal(true);
    expect(afterLogoutResponse.data).to.equal(0);
  });

  it('removes account data, credentials, and IMAP connections on logout', async () => {
    const seededAccount = seedTestAccount({
      email: 'logout-success@example.com',
      accessToken: 'logout-access-token',
      refreshToken: 'logout-refresh-token',
    });

    const imapService = ImapService.getInstance() as unknown as {
      connections: Map<string, unknown>;
      disconnect: (accountId: string) => Promise<void>;
    };
    let disconnectCalled = false;
    const originalDisconnect = imapService.disconnect.bind(imapService);
    imapService.connections.set(String(seededAccount.accountId), { connected: true });
    imapService.disconnect = async (accountId: string): Promise<void> => {
      disconnectCalled = true;
      imapService.connections.delete(accountId);
      await originalDisconnect(accountId);
    };
    expect(imapService.connections.has(String(seededAccount.accountId))).to.equal(true);

    try {
      const response = await callIpc('auth:logout', String(seededAccount.accountId)) as IpcResponse<null>;
      expect(response.success).to.equal(true);
      expect(disconnectCalled).to.equal(true);
      expect(DatabaseService.getInstance().getAccountById(seededAccount.accountId)).to.be.null;
      expect(CredentialService.getInstance().hasTokens(String(seededAccount.accountId))).to.equal(false);
      expect(imapService.connections.has(String(seededAccount.accountId))).to.equal(false);
    } finally {
      imapService.disconnect = originalDisconnect;
    }
  });

  it('continues logout cleanup even if revoke and IMAP disconnect fail', async () => {
    const seededAccount = seedTestAccount({
      email: 'logout-failure-tolerance@example.com',
      accessToken: 'logout-failure-access-token',
      refreshToken: 'logout-failure-refresh-token',
    });

    oauthServer.setErrorConfig({ revokeError: 'revoke_failed' });

    const imapService = ImapService.getInstance();
    const originalDisconnect = imapService.disconnect.bind(imapService);
    imapService.disconnect = async (): Promise<void> => {
      throw new Error('forced disconnect failure');
    };

    try {
      const response = await callIpc('auth:logout', String(seededAccount.accountId)) as IpcResponse<null>;
      expect(response.success).to.equal(true);
      expect(DatabaseService.getInstance().getAccountById(seededAccount.accountId)).to.be.null;
      expect(CredentialService.getInstance().hasTokens(String(seededAccount.accountId))).to.equal(false);
    } finally {
      imapService.disconnect = originalDisconnect;
    }
  });

  it('keeps multiple accounts isolated from each other', async () => {
    const firstAccount = seedTestAccount({
      email: 'multi-one@example.com',
      accessToken: 'multi-one-access-token',
      refreshToken: 'multi-one-refresh-token',
    });
    const secondAccount = seedTestAccount({
      email: 'multi-two@example.com',
      accessToken: 'multi-two-access-token',
      refreshToken: 'multi-two-refresh-token',
    });

    const accountsBeforeLogout = await callIpc('auth:get-accounts') as IpcResponse<AccountSummary[]>;
    expect(accountsBeforeLogout.success).to.equal(true);
    expect(accountsBeforeLogout.data).to.have.lengthOf(2);

    const logoutResponse = await callIpc('auth:logout', String(firstAccount.accountId)) as IpcResponse<null>;
    expect(logoutResponse.success).to.equal(true);

    expect(DatabaseService.getInstance().getAccountById(firstAccount.accountId)).to.be.null;
    expect(DatabaseService.getInstance().getAccountById(secondAccount.accountId)).to.not.be.null;
    expect(CredentialService.getInstance().hasTokens(String(firstAccount.accountId))).to.equal(false);
    expect(CredentialService.getInstance().hasTokens(String(secondAccount.accountId))).to.equal(true);

    const remainingAccounts = await callIpc('auth:get-accounts') as IpcResponse<AccountSummary[]>;
    expect(remainingAccounts.success).to.equal(true);
    expect(remainingAccounts.data).to.have.lengthOf(1);
    expect(remainingAccounts.data![0].email).to.equal('multi-two@example.com');
  });
});
