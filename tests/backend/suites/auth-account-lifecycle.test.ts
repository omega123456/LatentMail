import { expect } from 'chai';
import { app, safeStorage } from 'electron';
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
import { MailQueueService } from '../../../electron/services/mail-queue-service';

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

  afterEach(() => {
    try {
      const oauthService = OAuthService.getInstance() as unknown as {
        refreshTimers: Map<string, ReturnType<typeof setTimeout>>;
      };
      for (const timer of oauthService.refreshTimers.values()) {
        clearTimeout(timer);
      }
      oauthService.refreshTimers.clear();
    } catch {
      // Non-fatal cleanup for tests only
    }
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

  async function waitForStoredAccessToken(
    accountId: number,
    expectedAccessToken: string,
    timeoutMilliseconds: number = 5_000,
  ): Promise<void> {
    const startedAt = DateTime.utc().toMillis();

    while (DateTime.utc().toMillis() - startedAt < timeoutMilliseconds) {
      const storedTokens = CredentialService.getInstance().getTokens(String(accountId));
      if (storedTokens?.accessToken === expectedAccessToken) {
        return;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }

    throw new Error(`Timed out waiting for refreshed access token for account ${accountId}`);
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

  it('recovers from a malformed credentials file during login and rewrites valid tokens', async () => {
    fs.writeFileSync(getCredentialsFilePath(), Buffer.from('not-encrypted-json', 'utf-8'));

    oauthServer.setTokenConfig({
      accessToken: 'recovered-access-token',
      refreshToken: 'recovered-refresh-token',
      expiresIn: 3_600,
    });
    oauthServer.setUserInfo({
      email: 'recover-corrupt-credentials@example.com',
      name: 'Recovered Credentials User',
    });

    const { loginPromise, authEvent } = await startLoginFlow();
    await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state);
    const response = await loginPromise;

    expect(response.success).to.equal(true);
    const storedTokens = CredentialService.getInstance().getTokens(String(response.data!.id));
    expect(storedTokens).to.not.be.null;
    expect(storedTokens!.accessToken).to.equal('recovered-access-token');
    expect(storedTokens!.refreshToken).to.equal('recovered-refresh-token');
  });

  it('returns AUTH_LOGIN_FAILED when the token endpoint returns invalid JSON', async () => {
    oauthServer.setErrorConfig({ tokenMalformedJson: true });

    const { loginPromise, authEvent } = await startLoginFlow();
    await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state);
    const response = await loginPromise;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('AUTH_LOGIN_FAILED');
    expect(response.error!.message).to.include('Failed to parse token response');
  });

   it('returns AUTH_LOGIN_FAILED when user info lookup fails after token exchange', async () => {
    oauthServer.setUserInfo({ email: 'userinfo-fail@example.com', name: 'UserInfo Failure' });
    oauthServer.setErrorConfig({ userInfoError: 'invalid_token' });

    const { loginPromise, authEvent } = await startLoginFlow();
    await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state);
    const response = await loginPromise;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('AUTH_LOGIN_FAILED');
    expect(response.error!.message.toLowerCase()).to.include('user info');
  });

  it('returns AUTH_LOGIN_FAILED when the user info endpoint returns invalid JSON', async () => {
    oauthServer.setTokenConfig({
      accessToken: 'userinfo-invalid-json-access-token',
      refreshToken: 'userinfo-invalid-json-refresh-token',
      expiresIn: 3_600,
    });
    oauthServer.setErrorConfig({ userInfoMalformedJson: true });

    const { loginPromise, authEvent } = await startLoginFlow();
    await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state);
    const response = await loginPromise;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('AUTH_LOGIN_FAILED');
    expect(response.error!.message).to.include('Failed to parse user info');
  });

  it('returns AUTH_LOGIN_FAILED when the OAuth callback uses an invalid authorization code', async () => {
    oauthServer.setUserInfo({ email: 'invalid-code@example.com', name: 'Invalid Code User' });

    const { loginPromise, authEvent } = await startLoginFlow();
    await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state, { code: 'invalid-code' });
    const response = await loginPromise;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('AUTH_LOGIN_FAILED');
    expect(response.error!.message).to.include('Token exchange failed');
    expect(response.error!.message).to.include('invalid_grant');
  });

  it('returns AUTH_NOT_CONFIGURED when login reports a missing Google client id', async () => {
    const oauthService = OAuthService.getInstance() as unknown as {
      clientId: string;
    };
    const originalClientId = oauthService.clientId;
    oauthService.clientId = '';

    try {
      const response = await callIpc('auth:login') as IpcResponse<AuthAccount>;
      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AUTH_NOT_CONFIGURED');
    } finally {
      oauthService.clientId = originalClientId;
    }
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

  it('surfaces a parse failure when the refresh endpoint returns invalid JSON', async function () {
    this.timeout(10_000);

    const seededAccount = seedTestAccount({
      email: 'refresh-invalid-json@example.com',
      accessToken: 'refresh-invalid-json-stale-access-token',
      refreshToken: 'refresh-invalid-json-refresh-token',
      expiresAt: DateTime.now().minus({ hours: 1 }).toMillis(),
    });
    oauthServer.setErrorConfig({ refreshMalformedJson: true });

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
      expect(caughtError!.message).to.include('Failed to parse refresh response');
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  it('automatically refreshes a token when the scheduled refresh timer fires', async function () {
    this.timeout(10_000);

    const seededAccount = seedTestAccount({
      email: 'scheduled-refresh@example.com',
      accessToken: 'scheduled-stale-access-token',
      refreshToken: 'scheduled-refresh-token',
      expiresAt: DateTime.now().plus({ minutes: 6 }).toMillis(),
    });

    oauthServer.setTokenConfig({
      accessToken: 'scheduled-refreshed-access-token',
      refreshToken: 'scheduled-refreshed-refresh-token',
      expiresIn: 3_600,
    });

    const oauthService = OAuthService.getInstance() as unknown as {
      initializeRefreshTimers: () => void;
      refreshTimers: Map<string, ReturnType<typeof setTimeout>>;
    };

    const originalSetTimeout = global.setTimeout;
    let acceleratedTimeoutCount = 0;
    const oneShotFastSetTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      acceleratedTimeoutCount += 1;
      if (acceleratedTimeoutCount === 1) {
        return originalSetTimeout(callback, 0, ...args);
      }

      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;

    global.setTimeout = oneShotFastSetTimeout;

    try {
      oauthService.initializeRefreshTimers();
    } finally {
      global.setTimeout = originalSetTimeout;
    }

    expect(oauthService.refreshTimers.has(String(seededAccount.accountId))).to.equal(true);

    await waitForStoredAccessToken(seededAccount.accountId, 'scheduled-refreshed-access-token');

    const storedTokens = CredentialService.getInstance().getTokens(String(seededAccount.accountId));
    expect(storedTokens).to.not.be.null;
    expect(storedTokens!.accessToken).to.equal('scheduled-refreshed-access-token');
    expect(storedTokens!.refreshToken).to.equal('scheduled-refreshed-refresh-token');

    const refreshRequests = oauthServer.getCapturedRequests().filter((request) => {
      return request.endpoint === '/o/oauth2/token' && request.body.includes('grant_type=refresh_token');
    });
    expect(refreshRequests.length).to.equal(1);
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

  it('removes credentials and clears pending queue items during account deletion', async () => {
    const seededAccount = seedTestAccount({
      email: 'logout-cleanup@example.com',
      accessToken: 'logout-cleanup-access-token',
      refreshToken: 'logout-cleanup-refresh-token',
    });

    const queueService = MailQueueService.getInstance() as unknown as {
      pausedAccounts: Set<number>;
    };
    queueService.pausedAccounts.add(seededAccount.accountId);

    try {
      const queueResponse = await callIpc('queue:enqueue', {
        type: 'send',
        accountId: seededAccount.accountId,
        payload: {
          to: 'cleanup-target@example.com',
          subject: 'Cleanup queue item',
          text: 'Pending queue item should be cancelled on logout.',
        },
        description: 'Queue item for logout cleanup',
      }) as IpcResponse<{ queueId: string }>;

      expect(queueResponse.success).to.equal(true);

      const queueBeforeLogout = await callIpc('queue:get-status') as IpcResponse<{
        items: Array<{ queueId: string; accountId: number; status: string }>;
      }>;
      expect(queueBeforeLogout.success).to.equal(true);
      const queuedItem = queueBeforeLogout.data!.items.find((item) => item.queueId === queueResponse.data!.queueId);
      expect(queuedItem).to.exist;
      expect(['pending', 'processing']).to.include(queuedItem!.status);

      const logoutResponse = await callIpc('auth:logout', String(seededAccount.accountId)) as IpcResponse<null>;
      expect(logoutResponse.success).to.equal(true);

      expect(DatabaseService.getInstance().getAccountById(seededAccount.accountId)).to.be.null;
      expect(CredentialService.getInstance().hasTokens(String(seededAccount.accountId))).to.equal(false);

      const queueAfterLogout = await callIpc('queue:get-status') as IpcResponse<{
        items: Array<{ queueId: string; accountId: number; status: string }>;
      }>;
      expect(queueAfterLogout.success).to.equal(true);
      const cancelledItem = queueAfterLogout.data!.items.find((item) => item.queueId === queueResponse.data!.queueId);
      expect(cancelledItem).to.exist;
      expect(cancelledItem!.accountId).to.equal(seededAccount.accountId);
      expect(cancelledItem!.status).to.equal('cancelled');
    } finally {
      queueService.pausedAccounts.delete(seededAccount.accountId);
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

  it('clears needsReauth after a successful re-auth login for the same account', async () => {
    const seededAccount = seedTestAccount({
      email: 'reauth-flow@example.com',
      displayName: 'Needs Reauth User',
      accessToken: 'reauth-old-access-token',
      refreshToken: 'reauth-old-refresh-token',
      expiresAt: DateTime.now().minus({ hours: 1 }).toMillis(),
    });

    DatabaseService.getInstance().setAccountNeedsReauth(seededAccount.accountId);

    oauthServer.setTokenConfig({
      accessToken: 'reauth-new-access-token',
      refreshToken: 'reauth-new-refresh-token',
      expiresIn: 3_600,
    });
    oauthServer.setUserInfo({
      email: 'reauth-flow@example.com',
      name: 'Reauthenticated User',
    });

    const { loginPromise, authEvent } = await startLoginFlow();
    await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state);
    const loginResponse = await loginPromise;

    expect(loginResponse.success).to.equal(true);
    expect(loginResponse.data!.id).to.equal(seededAccount.accountId);
    expect(loginResponse.data!.displayName).to.equal('Reauthenticated User');

    const account = DatabaseService.getInstance().getAccountById(seededAccount.accountId);
    expect(account).to.not.be.null;
    expect(account!.needsReauth).to.equal(false);
    expect(account!.displayName).to.equal('Reauthenticated User');

    const storedTokens = CredentialService.getInstance().getTokens(String(seededAccount.accountId));
    expect(storedTokens).to.not.be.null;
    expect(storedTokens!.accessToken).to.equal('reauth-new-access-token');
    expect(storedTokens!.refreshToken).to.equal('reauth-new-refresh-token');
  });

  it('stores credentials independently for multiple seeded accounts', () => {
    const firstAccount = seedTestAccount({
      email: 'independent-one@example.com',
      accessToken: 'independent-one-access',
      refreshToken: 'independent-one-refresh',
    });
    const secondAccount = seedTestAccount({
      email: 'independent-two@example.com',
      accessToken: 'independent-two-access',
      refreshToken: 'independent-two-refresh',
    });

    const credentialService = CredentialService.getInstance();
    const firstTokens = credentialService.getTokens(String(firstAccount.accountId));
    const secondTokens = credentialService.getTokens(String(secondAccount.accountId));

    expect(firstTokens).to.not.be.null;
    expect(secondTokens).to.not.be.null;
    expect(firstTokens!.accessToken).to.equal('independent-one-access');
    expect(firstTokens!.refreshToken).to.equal('independent-one-refresh');
    expect(secondTokens!.accessToken).to.equal('independent-two-access');
    expect(secondTokens!.refreshToken).to.equal('independent-two-refresh');
    expect(firstTokens).to.not.deep.equal(secondTokens);
  });

  it('fails login when the credentials path cannot be written', async () => {
    fs.mkdirSync(getCredentialsFilePath(), { recursive: true });

    oauthServer.setTokenConfig({
      accessToken: 'write-failure-access-token',
      refreshToken: 'write-failure-refresh-token',
      expiresIn: 3_600,
    });
    oauthServer.setUserInfo({
      email: 'write-failure@example.com',
      name: 'Write Failure User',
    });

    try {
      const { loginPromise, authEvent } = await startLoginFlow();
      await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state);
      const response = await loginPromise;

      expect(response.success).to.equal(false);
      expect(response.error).to.exist;
      expect(response.error!.code).to.equal('AUTH_LOGIN_FAILED');
      expect(fs.statSync(getCredentialsFilePath()).isDirectory()).to.equal(true);
    } finally {
      fs.rmSync(getCredentialsFilePath(), { recursive: true, force: true });
    }
  });

  it('fails login closed when secure credential storage is unavailable', async () => {
    fs.writeFileSync(getCredentialsFilePath(), 'stale-unencrypted-credentials', 'utf-8');

    const safeStorageApi = safeStorage as unknown as {
      isEncryptionAvailable: () => boolean;
    };
    const originalIsEncryptionAvailable = safeStorageApi.isEncryptionAvailable;
    safeStorageApi.isEncryptionAvailable = (): boolean => {
      return false;
    };

    oauthServer.setTokenConfig({
      accessToken: 'secure-storage-missing-access-token',
      refreshToken: 'secure-storage-missing-refresh-token',
      expiresIn: 3_600,
    });
    oauthServer.setUserInfo({
      email: 'secure-storage-missing@example.com',
      name: 'Secure Storage Missing User',
    });

    try {
      const { loginPromise, authEvent } = await startLoginFlow();
      await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state);
      const response = await loginPromise;

      expect(response.success).to.equal(false);
      expect(response.error).to.exist;
      expect(response.error!.code).to.equal('AUTH_LOGIN_FAILED');
      expect(response.error!.message).to.include('Secure credential storage unavailable');
      expect(fs.readFileSync(getCredentialsFilePath(), 'utf-8')).to.equal('stale-unencrypted-credentials');
    } finally {
      safeStorageApi.isEncryptionAvailable = originalIsEncryptionAvailable;
    }
  });

  it('clears the credentials file when clearAll is invoked after a login flow', async () => {
    oauthServer.setTokenConfig({
      accessToken: 'clear-all-access-token',
      refreshToken: 'clear-all-refresh-token',
      expiresIn: 3_600,
    });
    oauthServer.setUserInfo({
      email: 'clear-all@example.com',
      name: 'Clear All User',
    });

    const { loginPromise, authEvent } = await startLoginFlow();
    await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state);
    const response = await loginPromise;

    expect(response.success).to.equal(true);
    expect(fs.existsSync(getCredentialsFilePath())).to.equal(true);

    CredentialService.getInstance().clearAll();

    expect(fs.existsSync(getCredentialsFilePath())).to.equal(false);
    expect(CredentialService.getInstance().getTokens(String(response.data!.id))).to.equal(null);
  });

  it('swallows credential file deletion failures in clearAll', async () => {
    oauthServer.setTokenConfig({
      accessToken: 'clear-all-error-access-token',
      refreshToken: 'clear-all-error-refresh-token',
      expiresIn: 3_600,
    });
    oauthServer.setUserInfo({
      email: 'clear-all-error@example.com',
      name: 'Clear All Error User',
    });

    const { loginPromise, authEvent } = await startLoginFlow();
    await oauthServer.triggerCallback(authEvent.loopbackPort, authEvent.state);
    const response = await loginPromise;

    expect(response.success).to.equal(true);
    expect(fs.existsSync(getCredentialsFilePath())).to.equal(true);

    const mutableFsModule = require('fs') as typeof import('fs');
    const originalUnlinkSync = mutableFsModule.unlinkSync;
    mutableFsModule.unlinkSync = (targetPath: fs.PathLike): void => {
      if (path.resolve(String(targetPath)) === path.resolve(getCredentialsFilePath())) {
        throw new Error('forced credential clearAll failure');
      }

      originalUnlinkSync(targetPath);
    };

    try {
      CredentialService.getInstance().clearAll();

      expect(fs.existsSync(getCredentialsFilePath())).to.equal(true);
      expect(CredentialService.getInstance().getTokens(String(response.data!.id))).to.not.equal(null);
    } finally {
      mutableFsModule.unlinkSync = originalUnlinkSync;
    }
  });

  it('returns AUTH_GET_ACCOUNTS_FAILED when account lookup throws', async () => {
    const database = DatabaseService.getInstance() as unknown as {
      getAccounts: () => AccountSummary[];
    };
    const originalGetAccounts = database.getAccounts;
    database.getAccounts = (): AccountSummary[] => {
      throw new Error('forced account listing failure');
    };

    try {
      const response = await callIpc('auth:get-accounts') as IpcResponse<AccountSummary[]>;
      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AUTH_GET_ACCOUNTS_FAILED');
    } finally {
      database.getAccounts = originalGetAccounts;
    }
  });

  it('falls back to the original avatar url when cached avatar resolution throws', async () => {
    const seededAccount = seedTestAccount({
      email: 'avatar-fallback@example.com',
      displayName: 'Avatar Fallback User',
    });
    const originalAvatarUrl = 'https://example.com/avatar-fallback.png';

    DatabaseService.getInstance().getDatabase().prepare(
      'UPDATE accounts SET avatar_url = :avatarUrl WHERE id = :accountId',
    ).run({ avatarUrl: originalAvatarUrl, accountId: seededAccount.accountId });

    const avatarCacheModule = require('../../../electron/services/avatar-cache-service') as typeof import('../../../electron/services/avatar-cache-service');
    const originalGetCachedAvatarUrl = avatarCacheModule.getCachedAvatarUrl;
    avatarCacheModule.getCachedAvatarUrl = async (): Promise<string> => {
      throw new Error('forced avatar cache resolution failure');
    };

    try {
      const response = await callIpc('auth:get-accounts') as IpcResponse<AccountSummary[]>;
      expect(response.success).to.equal(true);
      const matchingAccount = response.data!.find((account) => account.id === seededAccount.accountId);
      expect(matchingAccount).to.not.equal(undefined);
      expect(matchingAccount!.avatarUrl).to.equal(originalAvatarUrl);
    } finally {
      avatarCacheModule.getCachedAvatarUrl = originalGetCachedAvatarUrl;
    }
  });

  it('returns AUTH_GET_ACCOUNT_COUNT_FAILED when account count lookup throws', async () => {
    const database = DatabaseService.getInstance() as unknown as {
      getAccountCount: () => number;
    };
    const originalGetAccountCount = database.getAccountCount;
    database.getAccountCount = (): number => {
      throw new Error('forced account count failure');
    };

    try {
      const response = await callIpc('auth:get-account-count') as IpcResponse<number>;
      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AUTH_GET_ACCOUNT_COUNT_FAILED');
    } finally {
      database.getAccountCount = originalGetAccountCount;
    }
  });

  it('exposes OAuth loopback port and redirect URI after start', async function () {
    this.timeout(10_000);

    const server = new OAuthLoopbackServer();
    const { port, callbackPromise } = await server.start('loopback-state', 5_000);

    expect(server.getPort()).to.equal(port);
    expect(server.getRedirectUri()).to.equal(`http://127.0.0.1:${port}/callback`);

    await oauthServer.triggerCallback(port, 'loopback-state');
    const callbackResult = await callbackPromise;
    expect(callbackResult.code).to.equal('test_code');
    expect(callbackResult.state).to.equal('loopback-state');
  });

  it('rejects the loopback callback when the authorization code is missing', async function () {
    this.timeout(10_000);

    const server = new OAuthLoopbackServer();
    const { port, callbackPromise } = await server.start('missing-code-state', 5_000);

    const callbackUrl = `http://127.0.0.1:${port}/callback?state=missing-code-state`;
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

    let caughtError: Error | null = null;
    try {
      await callbackPromise;
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).to.not.be.null;
    expect(caughtError!.message).to.include('missing authorization code');
  });

  it('rejects the loopback callback when the request path is invalid until timeout', async function () {
    this.timeout(10_000);

    const server = new OAuthLoopbackServer();
    const { port, callbackPromise } = await server.start('wrong-path-state', 200);

    const invalidPathUrl = `http://127.0.0.1:${port}/wrong-path?code=test_code&state=wrong-path-state`;
    await new Promise<void>((resolve, reject) => {
      const request = http.get(invalidPathUrl, (response) => {
        expect(response.statusCode).to.equal(404);
        response.resume();
        response.on('end', () => {
          resolve();
        });
      });
      request.on('error', (error: Error) => {
        reject(error);
      });
    });

    let caughtError: Error | null = null;
    try {
      await callbackPromise;
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).to.not.be.null;
    expect(caughtError!.message).to.include('timed out');
  });
});
