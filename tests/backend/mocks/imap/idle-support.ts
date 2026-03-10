/**
 * idle-support.ts — IDLE connection tracking and event injection helpers.
 *
 * IdleSupport wraps a GmailImapServer and MessageStore to provide a clean
 * API for test code to inject messages and trigger the corresponding IMAP
 * push notifications that IDLE-connected imapflow clients will see.
 */

import { GmailImapServer } from './gmail-imap-server';
import { MessageStore } from './message-store';

/**
 * IdleSupport provides helpers for injecting IDLE notifications into the
 * fake IMAP server from test code.
 *
 * Usage in tests:
 *   const idleSupport = new IdleSupport(imapServer, messageStore);
 *   idleSupport.injectNewMessage('INBOX', rfc822Buffer);
 *   // imapflow's IDLE listener sees the EXISTS notification and re-fetches
 */
export class IdleSupport {
  private imapServer: GmailImapServer;
  private store: MessageStore;

  constructor(imapServer: GmailImapServer, store: MessageStore) {
    this.imapServer = imapServer;
    this.store = store;
  }

  /**
   * Inject a new message into a mailbox AND send an EXISTS notification
   * to all connected IDLE clients watching that mailbox.
   *
   * @param mailboxName - Target mailbox
   * @param rfc822 - Raw RFC 822 message bytes
   * @param options - Optional message metadata
   * @returns The injected message metadata
   */
  injectNewMessage(
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
    const result = this.store.injectMessage(mailboxName, rfc822, options);
    const count = this.store.getMessageCount(mailboxName);
    this.imapServer.notifyExists(mailboxName, count);
    return result;
  }

  /**
   * Remove a message (by UID) from a mailbox AND send EXPUNGE notifications
   * to all connected IDLE clients watching that mailbox.
   *
   * Uses expungeUids() to remove only the targeted message, without touching
   * any other pre-existing \Deleted messages in the mailbox.
   *
   * @param mailboxName - Target mailbox
   * @param uid - UID of the message to remove
   */
  expungeMessage(mailboxName: string, uid: number): void {
    const messagesBefore = this.store.getMessages(mailboxName);
    const seqNum = messagesBefore.findIndex((message) => message.uid === uid) + 1;

    if (seqNum === 0) {
      // Message not found — nothing to do
      return;
    }

    // Remove only the targeted UID — do not disturb other \Deleted messages
    this.store.expungeUids(mailboxName, [uid]);

    // Notify IDLE clients of the removed sequence number
    this.imapServer.notifyExpunge(mailboxName, seqNum);
  }

  /**
   * Send a raw EXISTS notification for a mailbox without actually changing
   * the message store. Useful for testing edge cases such as spurious
   * notifications or re-entrancy scenarios.
   *
   * @param mailboxName - Target mailbox
   * @param count - The count to report in the EXISTS response
   */
  sendExistsNotification(mailboxName: string, count: number): void {
    this.imapServer.notifyExists(mailboxName, count);
  }

  /**
   * Send a raw EXPUNGE notification for a sequence number without changing
   * the message store. Useful for testing edge cases where the client must
   * handle an EXPUNGE it did not initiate.
   *
   * @param mailboxName - Target mailbox
   * @param seqNum - The sequence number to expunge in the notification
   */
  sendExpungeNotification(mailboxName: string, seqNum: number): void {
    this.imapServer.notifyExpunge(mailboxName, seqNum);
  }
}
