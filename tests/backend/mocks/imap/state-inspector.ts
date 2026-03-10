/**
 * state-inspector.ts — Unified test interface for the fake IMAP server.
 *
 * StateInspector is the primary entry point that test suites use to:
 *   1. Set up initial IMAP state (inject messages, configure allowed accounts)
 *   2. Assert on server-side state after IPC calls complete
 *   3. Trigger IDLE notifications (EXISTS / EXPUNGE)
 *   4. Inject transient command errors for resilience testing
 *   5. Reset all state between test suites
 *
 * Usage:
 *   const inspector = new StateInspector(imapServer, store);
 *   // In suite before() hook:
 *   inspector.reset();
 *   inspector.setAllowedAccounts(['test@example.com']);
 *   const { uid } = inspector.injectMessage('INBOX', Buffer.from(rawEmail));
 *   // After IPC call:
 *   const messages = inspector.getMessages('INBOX');
 *   expect(messages.find(m => m.uid === uid)?.flags.has('\\Seen')).to.be.true;
 */

import { GmailImapServer } from './gmail-imap-server';
import { MessageStore, GmailMessage, Mailbox } from './message-store';
import { IdleSupport } from './idle-support';

export class StateInspector {
  private imapServer: GmailImapServer;
  private store: MessageStore;
  private idleSupport: IdleSupport;

  constructor(imapServer: GmailImapServer, store: MessageStore) {
    this.imapServer = imapServer;
    this.store = store;
    this.idleSupport = new IdleSupport(imapServer, store);
  }

  // ---------------------------------------------------------------------------
  // State setup
  // ---------------------------------------------------------------------------

  /**
   * Configure which email addresses are allowed to authenticate.
   * An empty array means any email is accepted (the default).
   */
  setAllowedAccounts(emails: string[]): void {
    this.imapServer.setAllowedAccounts(emails);
  }

  /**
   * Inject a message directly into a mailbox.
   * This is the primary way tests set up IMAP state before exercising IPC calls.
   * Does NOT send an EXISTS notification to IDLE clients.
   *
   * @param mailboxName - Target mailbox (e.g. 'INBOX', '[Gmail]/Sent Mail')
   * @param rfc822 - Raw RFC 822 message bytes
   * @param options - Optional overrides for flags, date, and Gmail-specific IDs
   * @returns The assigned UID, xGmMsgId, and xGmThrid
   */
  injectMessage(
    mailboxName: string,
    rfc822: Buffer,
    options?: {
      flags?: string[];
      internalDate?: string;
      xGmMsgId?: string;
      xGmThrid?: string;
      xGmLabels?: string[];
    },
  ): { uid: number; xGmMsgId: string; xGmThrid: string } {
    return this.store.injectMessage(mailboxName, rfc822, options);
  }

  /**
   * Inject a message AND send an EXISTS notification to IDLE clients.
   * Use this when testing IDLE-triggered sync flows where the client must
   * observe the new message without polling.
   *
   * @param mailboxName - Target mailbox
   * @param rfc822 - Raw RFC 822 message bytes
   * @param options - Optional message metadata
   * @returns The assigned UID, xGmMsgId, and xGmThrid
   */
  injectAndNotify(
    mailboxName: string,
    rfc822: Buffer,
    options?: {
      flags?: string[];
      internalDate?: string;
      xGmMsgId?: string;
      xGmThrid?: string;
      xGmLabels?: string[];
    },
  ): { uid: number; xGmMsgId: string; xGmThrid: string } {
    return this.idleSupport.injectNewMessage(mailboxName, rfc822, options);
  }

  /**
   * Mark a message as deleted, expunge it, AND send an EXPUNGE notification
   * to IDLE clients. Use this when testing IDLE-triggered expunge flows.
   *
   * @param mailboxName - Target mailbox
   * @param uid - UID of the message to remove
   */
  expungeAndNotify(mailboxName: string, uid: number): void {
    this.idleSupport.expungeMessage(mailboxName, uid);
  }

  // ---------------------------------------------------------------------------
  // State inspection
  // ---------------------------------------------------------------------------

  /**
   * Get all messages in a mailbox, sorted by ascending UID.
   * Returns an empty array if the mailbox does not exist.
   */
  getMessages(mailboxName: string): GmailMessage[] {
    return this.store.getMessages(mailboxName);
  }

  /**
   * Get a specific message by UID within a mailbox.
   * Returns undefined if the mailbox or UID does not exist.
   */
  getMessage(mailboxName: string, uid: number): GmailMessage | undefined {
    return this.store.getMessage(mailboxName, uid);
  }

  /**
   * Get mailbox metadata (UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ, etc.).
   * Returns undefined if the mailbox does not exist.
   */
  getMailbox(mailboxName: string): Mailbox | undefined {
    return this.store.getMailbox(mailboxName);
  }

  /**
   * Get the count of messages currently in a mailbox.
   * Returns 0 if the mailbox does not exist.
   */
  getMessageCount(mailboxName: string): number {
    return this.store.getMessageCount(mailboxName);
  }

  /**
   * List all mailbox names (full paths) known to the server.
   */
  listMailboxes(): string[] {
    return this.store.listMailboxes();
  }

  /**
   * Get the flags currently set on a specific message.
   * Returns an empty Set if the mailbox or message does not exist.
   */
  getFlags(mailboxName: string, uid: number): Set<string> {
    const message = this.store.getMessage(mailboxName, uid);
    return message ? new Set(message.flags) : new Set();
  }

  // ---------------------------------------------------------------------------
  // Error injection
  // ---------------------------------------------------------------------------

  /**
   * Configure a specific IMAP command to return a NO error response the next
   * time it is received. The injection stays in place until cleared.
   * Used for resilience and retry testing.
   *
   * @param command - IMAP command name, case-insensitive (e.g. 'FETCH', 'STORE')
   * @param errorMessage - The error text returned after NO (e.g. 'Server error')
   */
  injectCommandError(command: string, errorMessage: string): void {
    this.imapServer.injectError(command, errorMessage);
  }

  /**
   * Remove all injected command errors, restoring normal server behaviour.
   */
  clearCommandErrors(): void {
    this.imapServer.clearErrorInjections();
  }

  // ---------------------------------------------------------------------------
  // UIDVALIDITY manipulation
  // ---------------------------------------------------------------------------

  /**
   * Reset a mailbox's UIDVALIDITY and clear all its messages.
   * Simulates a server-side UID invalidation event, which should trigger
   * the client to re-sync the entire mailbox from scratch.
   */
  resetUidValidity(mailboxName: string): void {
    this.store.resetUidValidity(mailboxName);
  }

  // ---------------------------------------------------------------------------
  // Full reset
  // ---------------------------------------------------------------------------

  /**
   * Reset all server state: clear all messages, restore the default Gmail
   * folder tree, reset UID counters, and clear all error injections.
   * Also clears any allowed-account restrictions.
   * Call in suite-level before() hooks to ensure test isolation.
   */
  reset(): void {
    this.store.reset();
    this.imapServer.clearErrorInjections();
    this.imapServer.setAllowedAccounts([]);
  }

  // ---------------------------------------------------------------------------
  // Raw IDLE notifications (for advanced tests)
  // ---------------------------------------------------------------------------

  /**
   * Send an EXISTS notification without actually changing the message store.
   * Use for testing how the client handles spurious or unexpected EXISTS counts.
   */
  sendExistsNotification(mailboxName: string, count: number): void {
    this.idleSupport.sendExistsNotification(mailboxName, count);
  }

  /**
   * Send an EXPUNGE notification without actually changing the message store.
   * Use for testing how the client handles EXPUNGE notifications it did not
   * initiate, or for testing sequence-number bookkeeping.
   */
  sendExpungeNotification(mailboxName: string, seqNum: number): void {
    this.idleSupport.sendExpungeNotification(mailboxName, seqNum);
  }

  // ---------------------------------------------------------------------------
  // Raw access (for advanced assertions)
  // ---------------------------------------------------------------------------

  /**
   * Access the underlying MessageStore for advanced assertions or operations
   * not exposed through the StateInspector API.
   */
  getStore(): MessageStore {
    return this.store;
  }

  /**
   * Access the underlying GmailImapServer for advanced configuration not
   * exposed through the StateInspector API.
   */
  getServer(): GmailImapServer {
    return this.imapServer;
  }
}
