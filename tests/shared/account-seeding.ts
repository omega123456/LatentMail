import { DateTime } from 'luxon';

import { DatabaseService } from '../../electron/services/database-service';
import { CredentialService } from '../../electron/services/credential-service';
import { StateInspector } from '../backend/mocks/imap/state-inspector';
import { SmtpCaptureServer } from '../backend/mocks/smtp/smtp-capture-server';
import { FakeOAuthServer } from '../backend/mocks/oauth/fake-oauth-server';

export interface SeedAccountOptions {
  email?: string;
  displayName?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface SeededAccount {
  accountId: number;
  email: string;
  accessToken: string;
}

export interface SeedAccountDependencies {
  imapStateInspector: StateInspector;
  smtpServer: SmtpCaptureServer;
  oauthServer: FakeOAuthServer;
}

export function seedTestAccount(
  options: SeedAccountOptions = {},
  dependencies: SeedAccountDependencies,
): SeededAccount {
  const email = options.email ?? 'test@example.com';
  const displayName = options.displayName ?? 'Test User';
  const accessToken = options.accessToken ?? 'fake-access-token-12345';
  const refreshToken = options.refreshToken ?? 'fake-refresh-token-67890';
  const expiresAt = options.expiresAt ?? DateTime.now().plus({ hours: 1 }).toMillis();

  const db = DatabaseService.getInstance();
  const accountId = db.createAccount(email, displayName, null);

  const credentialService = CredentialService.getInstance();
  credentialService.storeTokens(String(accountId), accessToken, refreshToken, expiresAt);

  dependencies.imapStateInspector.getServer().addAllowedAccount(email);
  dependencies.smtpServer.addAllowedAccount(email);
  dependencies.oauthServer.setTokenConfig({ accessToken, refreshToken });
  dependencies.oauthServer.setUserInfo({ email, name: displayName });

  try {
    const { MailQueueService } = require('../../electron/services/mail-queue-service') as typeof import('../../electron/services/mail-queue-service');
    MailQueueService.getInstance().resumeFromTesting();
  } catch {
    // Non-fatal — service may not be available in all environments
  }

  try {
    const { SyncQueueBridge } = require('../../electron/services/sync-queue-bridge') as typeof import('../../electron/services/sync-queue-bridge');
    SyncQueueBridge.getInstance().resumeForTesting();
  } catch {
    // Non-fatal
  }

  try {
    const { SyncService } = require('../../electron/services/sync-service') as typeof import('../../electron/services/sync-service');
    SyncService.getInstance().setGlobalIdleSuppression(false);
  } catch {
    // Non-fatal
  }

  try {
    const { BodyFetchQueueService } = require('../../electron/services/body-fetch-queue-service') as typeof import('../../electron/services/body-fetch-queue-service');
    BodyFetchQueueService.getInstance().resumeFromTesting();
  } catch {
    // Non-fatal
  }

  return { accountId, email, accessToken };
}
