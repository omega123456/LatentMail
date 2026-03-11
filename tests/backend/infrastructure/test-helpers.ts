/**
 * test-helpers.ts — Core helpers for backend E2E tests.
 *
 * Provides:
 *   - callIpc()           — invoke a registered IPC handler directly (no wire)
 *   - getDatabase()       — access DatabaseService for direct DB assertions
 *   - waitForEvent()      — wait for a specific IPC event on TestEventBus
 *   - seedTestAccount()   — create a test account in the DB, store fake credentials,
 *                           and configure all mock servers to accept the account
 */

import { ipcHandlerMap, hiddenWindow, imapStateInspector, smtpServer, oauthServer } from '../test-main';
import { DatabaseService } from '../../../electron/services/database-service';
import { CredentialService } from '../../../electron/services/credential-service';
import { TestEventBus } from './test-event-bus';
import { DateTime } from 'luxon';

/**
 * Invoke an IPC handler directly, bypassing the Electron wire protocol.
 *
 * The mock event passed to the handler includes the hidden window's webContents
 * as `sender`, matching what production handlers receive when invoked from the
 * renderer.
 *
 * @param channel - The IPC channel name (must be registered via ipcMain.handle)
 * @param args - Arguments to pass to the handler (same as what the renderer would send)
 * @returns Whatever the handler returns (typically IpcResponse<T>)
 */
export async function callIpc(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipcHandlerMap.get(channel);
  if (!handler) {
    throw new Error(`No IPC handler registered for channel: ${channel}`);
  }
  // Pass a minimal mock IpcMainInvokeEvent — most handlers only use sender (if at all)
  const fakeEvent = { sender: hiddenWindow ? hiddenWindow.webContents : null };
  return handler(fakeEvent, ...args);
}

/**
 * Get direct access to the DatabaseService singleton for assertions.
 * Use database.getDatabase() to run raw SQL queries in tests.
 */
export function getDatabase(): DatabaseService {
  return DatabaseService.getInstance();
}

/**
 * Wait for a specific IPC event to arrive on the TestEventBus.
 *
 * @param channel - The channel name to listen for
 * @param options.timeout - Timeout in ms (default 10000)
 * @param options.predicate - Optional filter function
 * @returns Promise resolving with the event's args array
 */
export function waitForEvent(
  channel: string,
  options?: { timeout?: number; predicate?: (args: unknown[]) => boolean },
): Promise<unknown[]> {
  return TestEventBus.getInstance().waitFor(channel, options);
}

/**
 * Options for seedTestAccount().
 */
export interface SeedAccountOptions {
  /** Gmail address for the test account. Defaults to 'test@example.com'. */
  email?: string;
  /** Display name. Defaults to 'Test User'. */
  displayName?: string;
  /** Access token to store in credentials. Defaults to 'fake-access-token-12345'. */
  accessToken?: string;
  /** Refresh token to store in credentials. Defaults to 'fake-refresh-token-67890'. */
  refreshToken?: string;
  /**
   * Token expiry timestamp (ms since epoch).
   * Defaults to 1 hour from now so the token is considered valid for the test duration.
   */
  expiresAt?: number;
}

/**
 * Result from seedTestAccount().
 */
export interface SeededAccount {
  /** Numeric account ID as assigned by DatabaseService.createAccount() */
  accountId: number;
  /** The email address used when creating the account */
  email: string;
  /** The access token stored in CredentialService */
  accessToken: string;
}

/**
 * Seed a test account by:
 *   1. Creating a DB row via DatabaseService
 *   2. Storing fake credentials via CredentialService (so getAccessToken() succeeds)
 *   3. Configuring the fake IMAP server to accept the account's email
 *   4. Configuring the fake SMTP server to accept the account's email
 *   5. Configuring the fake OAuth server with matching tokens and user info
 *
 * This is the canonical way to set up an account for backend E2E tests.
 * Call this inside a Mocha before() or beforeEach() hook AFTER quiesceAndRestore().
 *
 * @param options - Optional overrides for account properties and credentials
 * @returns The numeric accountId and the email/accessToken used
 */
export function seedTestAccount(options: SeedAccountOptions = {}): SeededAccount {
  const email = options.email ?? 'test@example.com';
  const displayName = options.displayName ?? 'Test User';
  const accessToken = options.accessToken ?? 'fake-access-token-12345';
  const refreshToken = options.refreshToken ?? 'fake-refresh-token-67890';
  // Default: expires 1 hour from now (well within test run window)
  const expiresAt = options.expiresAt ?? DateTime.now().plus({ hours: 1 }).toMillis();

  // 1. Create the DB row
  const db = DatabaseService.getInstance();
  const accountId = db.createAccount(email, displayName, null);

  // 2. Store fake credentials so OAuthService.getAccessToken() returns immediately
  const credentialService = CredentialService.getInstance();
  credentialService.storeTokens(String(accountId), accessToken, refreshToken, expiresAt);

  // 3. Configure the fake IMAP server to accept this email address
  // addAllowedAccount() adds to the existing set without clearing it,
  // so multiple seedTestAccount() calls accumulate allowed emails correctly.
  imapStateInspector.getServer().addAllowedAccount(email);

  // 4. Configure the fake SMTP server to accept this email address
  smtpServer.addAllowedAccount(email);

  // 5. Configure the fake OAuth server: token config and user info
  oauthServer.setTokenConfig({ accessToken, refreshToken });
  oauthServer.setUserInfo({ email, name: displayName });

  return { accountId, email, accessToken };
}

/**
 * Re-export ipcHandlerMap for advanced consumers (e.g. suite-level assertions
 * that need to inspect registered channels).
 */
export { ipcHandlerMap };
