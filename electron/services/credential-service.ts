import { safeStorage, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { LoggerService } from './logger-service';

const log = LoggerService.getInstance();

interface StoredCredentials {
  [accountId: string]: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
}

export class CredentialService {
  private static instance: CredentialService;
  private credentialsPath: string;

  private constructor() {
    const userDataPath = app.getPath('userData');
    this.credentialsPath = path.join(userDataPath, 'credentials.enc');
  }

  static getInstance(): CredentialService {
    if (!CredentialService.instance) {
      CredentialService.instance = new CredentialService();
    }
    return CredentialService.instance;
  }

  private isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  private readCredentials(): StoredCredentials {
    try {
      if (!fs.existsSync(this.credentialsPath)) {
        return {};
      }

      const fileContent = fs.readFileSync(this.credentialsPath);

      if (this.isEncryptionAvailable()) {
        const decrypted = safeStorage.decryptString(fileContent);
        return JSON.parse(decrypted);
      } else {
        // Fallback to plaintext (with warning)
        log.warn('safeStorage not available — credentials stored without encryption');
        return JSON.parse(fileContent.toString('utf-8'));
      }
    } catch (err) {
      log.error('Failed to read credentials:', err);
      return {};
    }
  }

  private writeCredentials(credentials: StoredCredentials): void {
    try {
      const json = JSON.stringify(credentials);

      if (this.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(json);
        fs.writeFileSync(this.credentialsPath, encrypted);
      } else {
        log.warn('safeStorage not available — credentials stored without encryption');
        fs.writeFileSync(this.credentialsPath, json, 'utf-8');
      }
    } catch (err) {
      log.error('Failed to write credentials:', err);
      throw err;
    }
  }

  storeTokens(accountId: string, accessToken: string, refreshToken: string, expiresAt: number): void {
    const credentials = this.readCredentials();
    credentials[accountId] = { accessToken, refreshToken, expiresAt };
    this.writeCredentials(credentials);
    log.info(`Tokens stored for account ${accountId}`);
  }

  getTokens(accountId: string): { accessToken: string; refreshToken: string; expiresAt: number } | null {
    const credentials = this.readCredentials();
    return credentials[accountId] ?? null;
  }

  removeTokens(accountId: string): void {
    const credentials = this.readCredentials();
    delete credentials[accountId];
    this.writeCredentials(credentials);
    log.info(`Tokens removed for account ${accountId}`);
  }

  hasTokens(accountId: string): boolean {
    const credentials = this.readCredentials();
    return accountId in credentials;
  }

  clearAll(): void {
    try {
      if (fs.existsSync(this.credentialsPath)) {
        fs.unlinkSync(this.credentialsPath);
      }
      log.info('All credentials cleared');
    } catch (err) {
      log.error('Failed to clear credentials:', err);
    }
  }
}
