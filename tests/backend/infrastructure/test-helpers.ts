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

export interface QueueUpdateEventSnapshot {
  queueId: string;
  accountId: number;
  type: string;
  status: string;
  error?: string;
}

export interface WaitForQueueTerminalStateOptions {
  timeout?: number;
  expectedStatus?: 'completed' | 'failed';
}

function isTerminalQueueStatus(status: unknown): status is 'completed' | 'failed' {
  return status === 'completed' || status === 'failed';
}

export async function waitForQueueTerminalState(
  queueId: string,
  options: WaitForQueueTerminalStateOptions = {},
): Promise<QueueUpdateEventSnapshot> {
  const timeoutMs = options.timeout ?? 15_000;
  const resultArgs = await waitForEvent('queue:update', {
    timeout: timeoutMs,
    predicate: (args) => {
      const snapshot = args[0] as QueueUpdateEventSnapshot | undefined;
      return (
        snapshot != null &&
        snapshot.queueId === queueId &&
        isTerminalQueueStatus(snapshot.status)
      );
    },
  });

  const snapshot = resultArgs[0] as QueueUpdateEventSnapshot;
  if (options.expectedStatus !== undefined && snapshot.status !== options.expectedStatus) {
    const errorSuffix = typeof snapshot.error === 'string' ? `: ${snapshot.error}` : '';
    throw new Error(
      `waitForQueueTerminalState: operation ${queueId} reached status '${snapshot.status}' ` +
      `(expected '${options.expectedStatus}')${errorSuffix}`,
    );
  }

  return snapshot;
}

export interface FolderUpdatedEventPayload extends Record<string, unknown> {
  accountId: number;
  folders?: string[];
  reason?: string;
  changeType?: string;
  count?: number;
}

export interface WaitForNextFolderUpdatedOptions {
  timeout?: number;
  reason?: string;
  folder?: string;
  priorCount?: number;
}

function matchesFolderUpdatedEvent(
  payload: FolderUpdatedEventPayload | undefined,
  accountId: number,
  options: WaitForNextFolderUpdatedOptions,
): boolean {
  if (payload == null) {
    return false;
  }
  if (Number(payload.accountId) !== accountId) {
    return false;
  }
  if (options.reason !== undefined && payload.reason !== options.reason) {
    return false;
  }
  if (options.folder !== undefined) {
    if (!Array.isArray(payload.folders)) {
      return false;
    }
    if (!payload.folders.includes(options.folder)) {
      return false;
    }
  }

  return true;
}

export async function waitForNextFolderUpdated(
  accountId: number,
  options: WaitForNextFolderUpdatedOptions = {},
): Promise<FolderUpdatedEventPayload> {
  const timeoutMs = options.timeout ?? 15_000;
  const eventBus = TestEventBus.getInstance();
  const priorCount = options.priorCount ?? eventBus.getHistory('mail:folder-updated').filter((record) => {
    const payload = record.args[0] as FolderUpdatedEventPayload | undefined;
    return matchesFolderUpdatedEvent(payload, accountId, options);
  }).length;

  const resultArgs = await waitForEvent('mail:folder-updated', {
    timeout: timeoutMs,
    predicate: (args) => {
      const payload = args[0] as FolderUpdatedEventPayload | undefined;
      if (!matchesFolderUpdatedEvent(payload, accountId, options)) {
        return false;
      }

      const currentCount = eventBus.getHistory('mail:folder-updated').filter((record) => {
        const recordPayload = record.args[0] as FolderUpdatedEventPayload | undefined;
        return matchesFolderUpdatedEvent(recordPayload, accountId, options);
      }).length;

      return currentCount > priorCount;
    },
  });

  return resultArgs[0] as FolderUpdatedEventPayload;
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

  // 6. Lift MailQueueService and SyncQueueBridge test suspensions.
  //    quiesceAndRestore() sets both services to "suspended" at its start to block
  //    any in-flight async callers from the previous suite (e.g. a background sync
  //    tick triggered by sync:resume). By the time seedTestAccount() is called the DB
  //    has been restored, credentials cleared and re-added, and mock servers reset —
  //    so it is safe to lift the suspensions now. Any legitimate IPC call
  //    (callIpc('mail:sync-account'), triggerSyncAndWait(), etc.) made after this
  //    point will reach the queue normally.
  try {
    const { MailQueueService } = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
    MailQueueService.getInstance().resumeFromTesting();
  } catch {
    // Non-fatal — service may not be available in all environments
  }
  try {
    const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
    SyncQueueBridge.getInstance().resumeForTesting();
  } catch {
    // Non-fatal
  }
  // 6b. Lift SyncService global IDLE suppression.
  //     quiesceAndRestore() → resetIdleStateForTesting() sets globalIdleSuppression=true
  //     to prevent the onClose callbacks fired by IMAP teardown from scheduling new
  //     reconnect timers for the dying previous-suite connections.  Now that the new
  //     suite is fully set up, clear the flag so that any IDLE connections started by
  //     this suite can auto-reconnect normally if the connection drops mid-test.
  try {
    const { SyncService } = require('../../../electron/services/sync-service') as typeof import('../../../electron/services/sync-service');
    SyncService.getInstance().setGlobalIdleSuppression(false);
  } catch {
    // Non-fatal
  }
  // 7. Lift BodyFetchQueueService isPaused flag so body-fetch workers can run again.
  //    quiesceAndRestore() calls BodyFetchQueueService.resetForTesting() which sets
  //    isPaused=true (to make any surviving in-flight worker fail fast).  Now that
  //    the DB is restored and credentials are ready, clear the flag so the new
  //    suite's syncs can enqueue body fetches normally.
  try {
    const { BodyFetchQueueService } = require('../../../electron/services/body-fetch-queue-service') as typeof import('../../../electron/services/body-fetch-queue-service');
    BodyFetchQueueService.getInstance().resumeFromTesting();
  } catch {
    // Non-fatal
  }

  return { accountId, email, accessToken };
}

/**
 * Options for triggerSyncAndWait().
 */
export interface TriggerSyncOptions {
  /** Timeout in ms to wait for the sync to complete. Defaults to 15000. */
  timeout?: number;
}

/**
 * Trigger a full sync for an account and wait for it to complete.
 *
 * Pattern:
 *   1. Call `mail:sync-account` IPC which enqueues a sync-allmail item and returns
 *      `{ queueId }` — the exact queue item created for this call.
 *   2. Wait for a `queue:update` event whose `queueId` matches the one returned by
 *      the IPC call AND whose `status` is `'completed'` or `'failed'`.
 *      If the item was deduped (queueId === null), fall back to a count-based wait
 *      on any same-account sync terminal event (same as the old behaviour).
 *   3. If the terminal status is `'failed'`, rejects so test suites see a clear error.
 *
 * Path (a) — unique queueId returned:
 *   Wait for exactly that item to reach a terminal state.  Because the predicate
 *   matches only the specific queueId, no other concurrent sync from a lingering
 *   previous-suite worker can cause a false positive.
 *
 * Path (b) — null queueId (dedup or test-suspended):
 *   Fall back to the prior count-based approach: wait for any new sync-allmail /
 *   sync-folder terminal event for the account.
 *
 * Both paths also accept a `mail:folder-updated` (reason='sync') event as a
 * secondary early-resolution signal (the folder-updated event fires *before* the
 * final queue:update completed event, so it allows the helper to unblock sooner
 * when the sync actually changed content).
 *
 * IMPORTANT: inject IMAP messages via stateInspector.injectMessage() BEFORE
 * calling this helper so that `mail:folder-updated` fires (the sync must
 * actually see changed folders to emit that event).
 *
 * @param accountId - Numeric account ID (from seedTestAccount().accountId)
 * @param options   - Optional timeout override
 */
export async function triggerSyncAndWait(
  accountId: number,
  options: TriggerSyncOptions = {},
): Promise<void> {
  const timeoutMs = options.timeout ?? 15_000;
  const bus = TestEventBus.getInstance();

  // Count events already in history so we only react to NEW events after this point.
  // Used for the folder-updated signal and the null-queueId fallback path.
  const priorFolderUpdatedCount = bus.getHistory('mail:folder-updated').filter((record) => {
    const argPayload = record.args[0] as Record<string, unknown> | undefined;
    return (
      argPayload != null &&
      Number(argPayload['accountId']) === accountId &&
      argPayload['reason'] === 'sync'
    );
  }).length;

  // Baseline for the null-queueId fallback path.
  const priorQueueUpdateCount = bus.getHistory('queue:update').filter((record) => {
    const recordSnapshot = record.args[0] as Record<string, unknown> | undefined;
    return (
      recordSnapshot != null &&
      Number(recordSnapshot['accountId']) === accountId &&
      (recordSnapshot['type'] === 'sync-allmail' || recordSnapshot['type'] === 'sync-folder') &&
      (recordSnapshot['status'] === 'completed' || recordSnapshot['status'] === 'failed')
    );
  }).length;

  // Enqueue the sync via IPC. Returns { queueId } — null when deduped or test-suspended.
  const syncResponse = await callIpc('mail:sync-account', String(accountId));
  const syncResponseTyped = syncResponse as {
    success: boolean;
    data?: { queueId: string | null };
    error?: { code: string; message: string };
  };
  if (!syncResponseTyped.success) {
    throw new Error(
      `triggerSyncAndWait: mail:sync-account IPC failed: ${syncResponseTyped.error?.code ?? 'unknown'} — ${syncResponseTyped.error?.message ?? ''}`,
    );
  }

  // The queueId for the specific sync-allmail item created by this call.
  // null means the item was deduped (already running) or the queue was suspended.
  const syncQueueId: string | null = syncResponseTyped.data?.queueId ?? null;

  // Race between folder-updated (best/earliest signal) and queue:update completed (fallback).
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`triggerSyncAndWait: timed out after ${timeoutMs}ms waiting for sync to complete`));
    }, timeoutMs);

    function settle(): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve();
    }

    function rejectWithError(message: string): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      reject(new Error(message));
    }

    // Path (a): mail:folder-updated with reason==='sync' — fires when a sync actually changed folders.
    // We restrict to reason==='sync' to avoid premature resolution from lingering flag/move/delete
    // operations that complete after a test suite boundary.
    const folderUpdatedPredicate = (args: unknown[]): boolean => {
      const payload = args[0] as Record<string, unknown> | undefined;
      if (!payload) {
        return false;
      }
      if (Number(payload['accountId']) !== accountId) {
        return false;
      }
      if (payload['reason'] !== 'sync') {
        return false;
      }
      // Only count events after the sync was triggered.
      const currentCount = bus.getHistory('mail:folder-updated').filter(
        (record) => {
          const argPayload = record.args[0] as Record<string, unknown> | undefined;
          return (
            argPayload != null &&
            Number(argPayload['accountId']) === accountId &&
            argPayload['reason'] === 'sync'
          );
        },
      ).length;
      return currentCount > priorFolderUpdatedCount;
    };

    bus
      .waitFor('mail:folder-updated', {
        timeout: timeoutMs,
        predicate: folderUpdatedPredicate,
      })
      .then(() => settle())
      .catch(() => {
        // Timeout on this path is okay — the queue:update path may still fire.
      });

    // Path (b): queue:update terminal event for the exact sync item (or any sync item
    // for this account when queueId is null / deduped).
    //
    // When syncQueueId is non-null we match the *specific* item returned by the IPC call.
    // This prevents a lingering previous-suite sync item (same account, same type) from
    // resolving our wait prematurely.
    //
    // When syncQueueId is null (dedup or suspension) we fall back to the count-based
    // approach for backward compatibility.
    const queueUpdatePredicate = (args: unknown[]): boolean => {
      const snapshot = args[0] as Record<string, unknown> | undefined;
      if (!snapshot) {
        return false;
      }
      if (Number(snapshot['accountId']) !== accountId) {
        return false;
      }
      if (snapshot['type'] !== 'sync-allmail' && snapshot['type'] !== 'sync-folder') {
        return false;
      }
      if (snapshot['status'] !== 'completed' && snapshot['status'] !== 'failed') {
        return false;
      }

      if (syncQueueId !== null) {
        // Specific-item path: only react to the exact queue item we triggered.
        return snapshot['queueId'] === syncQueueId;
      }

      // Fallback count-based path: any new terminal sync event for this account.
      const relevantEvents = bus.getHistory('queue:update').filter((record) => {
        const recordSnapshot = record.args[0] as Record<string, unknown> | undefined;
        return (
          recordSnapshot != null &&
          Number(recordSnapshot['accountId']) === accountId &&
          (recordSnapshot['type'] === 'sync-allmail' || recordSnapshot['type'] === 'sync-folder') &&
          (recordSnapshot['status'] === 'completed' || recordSnapshot['status'] === 'failed')
        );
      });
      return relevantEvents.length > priorQueueUpdateCount;
    };

    bus
      .waitFor('queue:update', {
        timeout: timeoutMs,
        predicate: queueUpdatePredicate,
      })
      .then((args) => {
        const snapshot = args[0] as Record<string, unknown> | undefined;
        if (snapshot && snapshot['status'] === 'failed') {
          // Sync worker completed but with a failure — propagate so tests don't silently pass.
          const errorMessage = typeof snapshot['error'] === 'string'
            ? snapshot['error']
            : 'sync worker reported failed status';
          rejectWithError(`triggerSyncAndWait: sync queue item failed: ${errorMessage}`);
        } else {
          settle();
        }
      })
      .catch(() => {
        // If both paths time out, the outer timeout will fire the rejection.
      });
  });
}

/**
 * Re-export ipcHandlerMap for advanced consumers (e.g. suite-level assertions
 * that need to inspect registered channels).
 */
export { ipcHandlerMap };
