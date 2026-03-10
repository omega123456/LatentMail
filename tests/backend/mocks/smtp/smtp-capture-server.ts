/**
 * smtp-capture-server.ts — In-process SMTP capture server for backend tests.
 *
 * Wraps the `smtp-server` npm package to act as a local SMTP sink:
 *   - Binds to 127.0.0.1 on a dynamic port (pass 0 to listen())
 *   - Accepts XOAUTH2 authentication (nodemailer sends OAuth2 tokens via XOAUTH2 SASL)
 *   - Parses every incoming message with mailparser and stores it in memory
 *   - Exposes helpers for test assertions (getCapturedEmails, getLastEmail, etc.)
 *
 * Usage in tests:
 *   const server = new SmtpCaptureServer();
 *   const port = await server.start();
 *   // ... configure nodemailer to use 127.0.0.1:port ...
 *   const lastEmail = server.getLastEmail();
 *   await server.stop();
 */

import { SMTPServer } from 'smtp-server';
import type { SMTPServerAuthentication, SMTPServerAuthenticationResponse, SMTPServerSession, SMTPServerDataStream } from 'smtp-server';
import { simpleParser } from 'mailparser';
import type { HeaderValue } from 'mailparser';
import * as net from 'net';
import { DateTime } from 'luxon';

/**
 * A captured, parsed email message received by the SMTP capture server.
 */
export interface CapturedEmail {
  /** The sender address (from the parsed message headers or MAIL FROM envelope) */
  from: string;
  /** All recipient addresses from the RCPT TO envelope */
  to: string[];
  /** Email subject line */
  subject: string;
  /** Plain-text body (undefined if not present) */
  text?: string;
  /** HTML body (undefined if not present) */
  html?: string;
  /** All message headers as a string map */
  headers: Map<string, string>;
  /** The raw message bytes as UTF-8 string */
  raw: string;
  /** The raw message bytes as a Buffer (for binary attachment assertions) */
  rawBuffer: Buffer;
  /** When this message was received by the capture server (ISO 8601 string) */
  receivedAt: string;
  /** The OAuth2 user (email address) from the XOAUTH2 auth exchange */
  authUser?: string;
}

/**
 * Converts a mailparser HeaderValue to a plain string for storage.
 * HeaderValue can be a string, string[], Date, or structured object.
 */
function headerValueToString(value: HeaderValue): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(headerValueToString).join(', ');
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  // AddressObject or StructuredHeader — use their .text or .value property
  if (typeof value === 'object' && value !== null) {
    if ('text' in value && typeof (value as { text: string }).text === 'string') {
      return (value as { text: string }).text;
    }
    if ('value' in value) {
      const inner = (value as { value: unknown }).value;
      if (typeof inner === 'string') {
        return inner;
      }
    }
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * In-process SMTP server that accepts all connections and captures every
 * email delivered to it. Intended for backend integration tests only.
 */
export class SmtpCaptureServer {
  private smtpServer: SMTPServer;
  private capturedEmails: CapturedEmail[] = [];
  private allowedAccounts: Set<string> = new Set();
  private port: number = 0;

  constructor() {
    this.smtpServer = new SMTPServer({
      // Only advertise XOAUTH2 — nodemailer's OAuth2 transport always uses it
      authMethods: ['XOAUTH2'],

      // Custom auth handler: accept any token for configured accounts.
      // auth.username is the email address; auth.accessToken is the bearer token.
      onAuth: (
        auth: SMTPServerAuthentication,
        _session: SMTPServerSession,
        callback: (error: Error | null | undefined, response?: SMTPServerAuthenticationResponse) => void,
      ): void => {
        if (auth.method === 'XOAUTH2') {
          const user = auth.username ?? '';
          if (this.allowedAccounts.size === 0 || this.allowedAccounts.has(user)) {
            // Accept — pass the user back so session.user is set
            callback(null, { user });
          } else {
            callback(new Error('Authentication failed: user not in allowed accounts'));
          }
        } else {
          callback(new Error(`Unsupported auth method: ${auth.method}`));
        }
      },

      // Data handler: collect raw bytes, parse with mailparser, store in memory.
      onData: (
        stream: SMTPServerDataStream,
        session: SMTPServerSession,
        callback: (error?: Error | null) => void,
      ): void => {
        const chunks: Buffer[] = [];

        stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        stream.on('end', (): void => {
          const rawBuffer = Buffer.concat(chunks);
          const raw = rawBuffer.toString('utf8');

          simpleParser(rawBuffer)
            .then((parsed) => {
              const fromText = parsed.from?.text ?? '';
              const fromAddress =
                fromText ||
                (session.envelope.mailFrom !== false ? session.envelope.mailFrom.address : '');

              const to = session.envelope.rcptTo.map(
                (recipient: { address: string }) => recipient.address,
              );

              // Convert the mailparser Headers map to a plain Map<string, string>
              const headers = new Map<string, string>();
              for (const [key, value] of parsed.headers.entries()) {
                headers.set(key, headerValueToString(value));
              }

              const captured: CapturedEmail = {
                from: fromAddress,
                to,
                subject: parsed.subject ?? '',
                text: parsed.text ?? undefined,
                html: typeof parsed.html === 'string' ? parsed.html : undefined,
                headers,
                raw,
                rawBuffer,
                receivedAt: DateTime.now().toISO()!,
                authUser:
                  typeof session.user === 'string' ? session.user : undefined,
              };

              this.capturedEmails.push(captured);
              callback();
            })
            .catch((parseError: Error) => {
              console.warn('[SmtpCaptureServer] Failed to parse email:', parseError);
              callback(); // Don't reject the SMTP transaction — still accept delivery
            });
        });

        stream.on('error', (streamError: Error) => {
          callback(streamError);
        });
      },

      // Disable TLS — test environment, localhost only
      secure: false,
      // Suppress internal smtp-server console output
      logger: false,
      // Allow authentication over plaintext connection (no STARTTLS required)
      allowInsecureAuth: true,
    });
  }

  /**
   * Start the SMTP server on a random available port on 127.0.0.1.
   * @returns Promise resolving with the assigned port number.
   */
  async start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      // SMTPServer.server is the underlying net.Server (typed in @types/smtp-server)
      this.smtpServer.listen(0, '127.0.0.1', (): void => {
        const address = this.smtpServer.server.address() as net.AddressInfo | null;
        if (address === null) {
          reject(new Error('SmtpCaptureServer: server.address() returned null after listen'));
          return;
        }
        this.port = address.port;
        resolve(this.port);
      });

      this.smtpServer.on('error', (serverError: Error) => {
        reject(serverError);
      });
    });
  }

  /**
   * Stop the SMTP server and close all active connections.
   * @returns Promise resolving when the server is fully closed.
   */
  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.smtpServer.close(() => {
        resolve();
      });
    });
  }

  /**
   * Restrict authentication to a specific set of email addresses.
   * If the set is empty (default), all users are accepted.
   * @param emails - List of email addresses to allow.
   */
  setAllowedAccounts(emails: string[]): void {
    this.allowedAccounts = new Set(emails);
  }

  /**
   * Add a single email address to the allowed accounts set.
   * @param email - Email address to permit.
   */
  addAllowedAccount(email: string): void {
    this.allowedAccounts.add(email);
  }

  /**
   * Return a snapshot of all captured emails (oldest first).
   */
  getCapturedEmails(): CapturedEmail[] {
    return [...this.capturedEmails];
  }

  /**
   * Return the most recently captured email, or undefined if none.
   */
  getLastEmail(): CapturedEmail | undefined {
    return this.capturedEmails[this.capturedEmails.length - 1];
  }

  /**
   * Return all emails where the given address appears in the RCPT TO list.
   * @param address - The recipient address to filter by.
   */
  getEmailsTo(address: string): CapturedEmail[] {
    return this.capturedEmails.filter((email) => email.to.includes(address));
  }

  /**
   * Discard all captured emails.
   */
  clearCaptures(): void {
    this.capturedEmails = [];
  }

  /**
   * Reset server state: clear all captured emails and remove all allowed
   * account restrictions. Does not stop or restart the server.
   */
  reset(): void {
    this.capturedEmails = [];
    this.allowedAccounts = new Set();
  }

  /**
   * Return the TCP port the server is currently bound to (0 before start()).
   */
  getPort(): number {
    return this.port;
  }
}
