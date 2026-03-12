/**
 * message-store.ts — In-memory IMAP message storage for the fake Gmail IMAP server.
 *
 * MessageStore holds all mailboxes and messages in memory. It is the single
 * source of truth for the fake server's state: all IMAP commands (SELECT,
 * FETCH, STORE, COPY, EXPUNGE, etc.) read from and write to this store.
 *
 * Tests inject messages via injectMessage() and inspect state via getMessages()
 * and getMessage() to make assertions without going through the IMAP protocol.
 */

import { DateTime } from 'luxon';

// ---------------------------------------------------------------------------
// Internal label mapping helper (module-level so it can be reused)
// ---------------------------------------------------------------------------

/**
 * Map a well-known Gmail mailbox name to its corresponding Gmail label string.
 * Returns null for mailboxes that have no standard label equivalent.
 *
 * Exported so that gmail-imap-server.ts can use it when adjusting labels
 * on messages after a MOVE operation (the source mailbox label must be removed).
 */
export function mailboxToLabel(mailboxName: string): string | null {
  const labelMap: Record<string, string> = {
    'INBOX': '\\Inbox',
    '[Gmail]/Sent Mail': '\\Sent',
    '[Gmail]/Drafts': '\\Draft',
    '[Gmail]/Trash': '\\Trash',
    '[Gmail]/Spam': '\\Junk',
    '[Gmail]/Starred': '\\Starred',
    '[Gmail]/All Mail': '\\All',
    '[Gmail]/Important': '\\Important',
  };
  return labelMap[mailboxName] ?? null;
}

function setsEqual(firstSet: Set<string>, secondSet: Set<string>): boolean {
  if (firstSet.size !== secondSet.size) {
    return false;
  }

  for (const value of firstSet) {
    if (!secondSet.has(value)) {
      return false;
    }
  }

  return true;
}

function arraysEqualAsSets(firstValues: string[], secondValues: string[]): boolean {
  return setsEqual(new Set(firstValues), new Set(secondValues));
}

/**
 * A single Gmail message as stored in the fake server.
 * Mirrors the real Gmail IMAP metadata that imapflow fetches.
 */
export interface GmailMessage {
  /** Per-mailbox UID assigned at injection time */
  uid: number;
  /** IMAP system flags: \Seen, \Flagged, \Deleted, \Draft, \Answered */
  flags: Set<string>;
  /** ISO 8601 internal date (when the message was received) */
  internalDate: string;
  /** Raw RFC 822 message bytes */
  rfc822: Buffer;
  /** X-GM-MSGID — stable across all mailboxes, globally unique */
  xGmMsgId: string;
  /** X-GM-THRID — thread grouping identifier */
  xGmThrid: string;
  /** X-GM-LABELS — Gmail label paths (e.g. ['\\Inbox', 'Work/Project']) */
  xGmLabels: string[];
  /** CONDSTORE sequence number — increments on every flag/content change */
  modseq: number;
}

/**
 * An IMAP mailbox (folder) as stored in the fake server.
 */
export interface Mailbox {
  /** Full path, e.g. 'INBOX', '[Gmail]/All Mail' */
  name: string;
  /** UIDVALIDITY — changes when UIDs are invalidated */
  uidValidity: number;
  /** Next UID to assign to a new message */
  uidNext: number;
  /** Highest MODSEQ across all messages in this mailbox */
  highestModseq: number;
  /** Mailbox-level flags (\Noselect, \HasChildren, etc.) */
  flags: string[];
  /** Special-use flags (\Inbox, \Sent, \Drafts, \Trash, \Spam, \All, etc.) */
  specialUseFlags: string[];
  /** True for non-selectable containers like [Gmail] */
  noSelect: boolean;
  /** Map of uid → GmailMessage */
  messages: Map<number, GmailMessage>;
  /** Map of uid → xGmMsgId for quick cross-reference lookup */
  uidToMsgId: Map<number, string>;
}

/**
 * In-memory store for all IMAP mailboxes and messages.
 *
 * Initialized with the standard Gmail folder tree. Tests call injectMessage()
 * to populate mailboxes before exercising IMAP commands. The store is
 * intentionally dumb — it stores and retrieves; protocol logic stays in
 * GmailImapServer.
 */
export class MessageStore {
  private mailboxes: Map<string, Mailbox> = new Map();
  private globalMsgIdCounter: bigint = BigInt('1000000000000000');
  private globalThridCounter: bigint = BigInt('2000000000000000');
  private globalModseq: number = 1;

  constructor() {
    this.initializeGmailFolders();
  }

  /**
   * Set up the standard Gmail folder tree with empty mailboxes.
   * Called on construction and reset().
   */
  private initializeGmailFolders(): void {
    const folderDefinitions: Array<{
      name: string;
      flags: string[];
      specialUseFlags: string[];
      noSelect?: boolean;
    }> = [
      {
        name: 'INBOX',
        flags: ['\\HasNoChildren'],
        specialUseFlags: ['\\Inbox'],
      },
      {
        name: '[Gmail]',
        flags: ['\\Noselect', '\\HasChildren'],
        specialUseFlags: [],
        noSelect: true,
      },
      {
        name: '[Gmail]/All Mail',
        flags: ['\\HasNoChildren'],
        specialUseFlags: ['\\All'],
      },
      {
        name: '[Gmail]/Drafts',
        flags: ['\\HasNoChildren'],
        specialUseFlags: ['\\Drafts'],
      },
      {
        name: '[Gmail]/Important',
        flags: ['\\HasNoChildren'],
        specialUseFlags: ['\\Important'],
      },
      {
        name: '[Gmail]/Sent Mail',
        flags: ['\\HasNoChildren'],
        specialUseFlags: ['\\Sent'],
      },
      {
        name: '[Gmail]/Starred',
        flags: ['\\HasNoChildren'],
        specialUseFlags: ['\\Flagged'],
      },
      {
        name: '[Gmail]/Trash',
        flags: ['\\HasNoChildren'],
        specialUseFlags: ['\\Trash'],
      },
      {
        name: '[Gmail]/Spam',
        flags: ['\\HasNoChildren'],
        specialUseFlags: ['\\Junk'],
      },
    ];

    for (const folderDef of folderDefinitions) {
      this.mailboxes.set(folderDef.name, {
        name: folderDef.name,
        uidValidity: Math.floor(Math.random() * 900000) + 100000,
        uidNext: 1,
        highestModseq: 1,
        flags: folderDef.flags,
        specialUseFlags: folderDef.specialUseFlags,
        noSelect: folderDef.noSelect ?? false,
        messages: new Map(),
        uidToMsgId: new Map(),
      });
    }
  }

  /**
   * Generate a globally unique X-GM-MSGID string.
   * Each call returns a different value (monotonically increasing).
   */
  generateMsgId(): string {
    this.globalMsgIdCounter += BigInt(1);
    return this.globalMsgIdCounter.toString();
  }

  /**
   * Generate a new X-GM-THRID string.
   * Each call returns a different value (monotonically increasing).
   */
  generateThrid(): string {
    this.globalThridCounter += BigInt(1);
    return this.globalThridCounter.toString();
  }

  /**
   * Inject a message directly into a mailbox, bypassing the IMAP APPEND flow.
   * Used by tests to set up initial state before exercising protocol logic.
   *
   * @param mailboxName - Target mailbox path (e.g. 'INBOX', '[Gmail]/Sent Mail')
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
    const mailbox = this.mailboxes.get(mailboxName);
    if (!mailbox) {
      throw new Error(`Mailbox not found: ${mailboxName}`);
    }
    if (mailbox.noSelect) {
      throw new Error(`Cannot inject into noselect mailbox: ${mailboxName}`);
    }

    const uid = mailbox.uidNext;
    const xGmMsgId = options?.xGmMsgId ?? this.generateMsgId();
    const xGmThrid = options?.xGmThrid ?? this.generateThrid();
    const modseq = ++this.globalModseq;

    // Auto-derive xGmLabels if not explicitly provided.
    // All messages are implicitly in All Mail; also include the target mailbox label.
    let derivedLabels: string[];
    if (options?.xGmLabels !== undefined) {
      derivedLabels = options.xGmLabels;
    } else {
      const labelsSet = new Set<string>();
      labelsSet.add('\\All');
      const mailboxLabel = mailboxToLabel(mailboxName);
      if (mailboxLabel !== null) {
        labelsSet.add(mailboxLabel);
      }
      derivedLabels = Array.from(labelsSet);
    }

    const message: GmailMessage = {
      uid,
      flags: new Set(options?.flags ?? []),
      internalDate: options?.internalDate ?? DateTime.now().toISO()!,
      rfc822,
      xGmMsgId,
      xGmThrid,
      xGmLabels: derivedLabels,
      modseq,
    };

    mailbox.messages.set(uid, message);
    mailbox.uidToMsgId.set(uid, xGmMsgId);
    mailbox.uidNext = uid + 1;
    mailbox.highestModseq = modseq;

    return { uid, xGmMsgId, xGmThrid };
  }

  /**
   * Get a mailbox by its full path name.
   * Returns undefined if the mailbox does not exist.
   */
  getMailbox(name: string): Mailbox | undefined {
    return this.mailboxes.get(name);
  }

  /**
   * List all mailbox names (full paths) in insertion order.
   */
  listMailboxes(): string[] {
    return Array.from(this.mailboxes.keys());
  }

  /**
   * Get all messages in a mailbox sorted by ascending UID.
   * Returns an empty array if the mailbox does not exist.
   */
  getMessages(mailboxName: string): GmailMessage[] {
    const mailbox = this.mailboxes.get(mailboxName);
    if (!mailbox) {
      return [];
    }
    return Array.from(mailbox.messages.values()).sort(
      (messageA, messageB) => messageA.uid - messageB.uid,
    );
  }

  /**
   * Get a single message by UID within a mailbox.
   * Returns undefined if the mailbox or UID does not exist.
   */
  getMessage(mailboxName: string, uid: number): GmailMessage | undefined {
    return this.mailboxes.get(mailboxName)?.messages.get(uid);
  }

  /**
   * Get the number of messages in a mailbox.
   * Returns 0 if the mailbox does not exist.
   */
  getMessageCount(mailboxName: string): number {
    return this.mailboxes.get(mailboxName)?.messages.size ?? 0;
  }

  /**
   * Update the flags on a message.
   *
   * @param mailboxName - Mailbox containing the message
   * @param uid - UID of the message to update
   * @param flags - Flag strings to apply
   * @param operation - 'add' appends flags, 'remove' removes them, 'set' replaces all
   */
  setFlags(
    mailboxName: string,
    uid: number,
    flags: string[],
    operation: 'add' | 'remove' | 'set',
  ): void {
    const mailbox = this.mailboxes.get(mailboxName);
    const message = mailbox?.messages.get(uid);
    if (!message || !mailbox) {
      return;
    }

    const originalFlags = new Set(message.flags);

    if (operation === 'set') {
      message.flags = new Set(flags);
    } else if (operation === 'add') {
      for (const flag of flags) {
        message.flags.add(flag);
      }
    } else {
      for (const flag of flags) {
        message.flags.delete(flag);
      }
    }

    if (setsEqual(originalFlags, message.flags)) {
      return;
    }

    message.modseq = ++this.globalModseq;
    mailbox.highestModseq = this.globalModseq;
  }

  /**
   * Replace the full Gmail label set on a message and bump its MODSEQ.
   * Used by tests to simulate remote label / folder changes that should be
   * detected by CONDSTORE incremental sync.
   */
  setLabels(mailboxName: string, uid: number, labels: string[]): void {
    const mailbox = this.mailboxes.get(mailboxName);
    const message = mailbox?.messages.get(uid);
    if (!message || !mailbox) {
      return;
    }

    if (arraysEqualAsSets(message.xGmLabels, labels)) {
      return;
    }

    message.xGmLabels = [...labels];
    message.modseq = ++this.globalModseq;
    mailbox.highestModseq = this.globalModseq;
  }

  /**
   * Copy a message from one mailbox to another.
   * The copy receives a new UID in the target mailbox, but inherits all other
   * fields (flags, body, Gmail IDs) from the source.
   *
   * @returns The new UID in the target mailbox, or null if source/target missing
   */
  copyMessage(
    sourceMailboxName: string,
    uid: number,
    targetMailboxName: string,
  ): number | null {
    const sourceMailbox = this.mailboxes.get(sourceMailboxName);
    const targetMailbox = this.mailboxes.get(targetMailboxName);
    const sourceMessage = sourceMailbox?.messages.get(uid);

    if (!sourceMessage || !targetMailbox) {
      return null;
    }

    const newUid = targetMailbox.uidNext;
    const modseq = ++this.globalModseq;

    // Add the target mailbox label to the copy's xGmLabels if not already present.
    const targetLabel = mailboxToLabel(targetMailboxName);
    const copiedLabels = [...sourceMessage.xGmLabels];
    if (targetLabel !== null && !copiedLabels.includes(targetLabel)) {
      copiedLabels.push(targetLabel);
    }

    const copiedMessage: GmailMessage = {
      ...sourceMessage,
      uid: newUid,
      modseq,
      flags: new Set(sourceMessage.flags),
      xGmLabels: copiedLabels,
    };

    targetMailbox.messages.set(newUid, copiedMessage);
    targetMailbox.uidToMsgId.set(newUid, sourceMessage.xGmMsgId);
    targetMailbox.uidNext = newUid + 1;
    targetMailbox.highestModseq = modseq;

    return newUid;
  }

  /**
   * Permanently remove all messages flagged with \Deleted from a mailbox.
   *
   * @returns Array of UIDs that were removed
   */
  expunge(mailboxName: string): number[] {
    const mailbox = this.mailboxes.get(mailboxName);
    if (!mailbox) {
      return [];
    }

    const deletedUids: number[] = [];
    for (const [uid, message] of mailbox.messages) {
      if (message.flags.has('\\Deleted')) {
        deletedUids.push(uid);
      }
    }

    for (const uid of deletedUids) {
      mailbox.messages.delete(uid);
      mailbox.uidToMsgId.delete(uid);
    }

    return deletedUids;
  }

  /**
   * Permanently remove specific messages by UID, regardless of \Deleted flag.
   * Used by UID EXPUNGE (RFC 4315) and IdleSupport.expungeMessage().
   *
   * @param mailboxName - Mailbox to remove messages from
   * @param uids - Array of UIDs to remove
   * @returns Array of UIDs that were actually removed (existed in the mailbox)
   */
  expungeUids(mailboxName: string, uids: number[]): number[] {
    const mailbox = this.mailboxes.get(mailboxName);
    if (!mailbox) {
      return [];
    }
    const removedUids: number[] = [];
    for (const uid of uids) {
      if (mailbox.messages.has(uid)) {
        mailbox.messages.delete(uid);
        mailbox.uidToMsgId.delete(uid);
        removedUids.push(uid);
      }
    }
    return removedUids;
  }

  /**
   * Append a raw message to a mailbox (used by the IMAP APPEND command handler).
   * Delegates to injectMessage() with APPEND-appropriate defaults.
   *
   * @returns The assigned UID, xGmMsgId, and xGmThrid
   */
  appendMessage(
    mailboxName: string,
    rfc822: Buffer,
    flags?: string[],
    internalDate?: string,
  ): { uid: number; xGmMsgId: string; xGmThrid: string } {
    return this.injectMessage(mailboxName, rfc822, { flags, internalDate });
  }

  /**
   * Create a new empty mailbox.
   * No-ops if the mailbox already exists.
   */
  createMailbox(name: string): void {
    if (this.mailboxes.has(name)) {
      return;
    }
    this.mailboxes.set(name, {
      name,
      uidValidity: Math.floor(Math.random() * 900000) + 100000,
      uidNext: 1,
      highestModseq: 1,
      flags: ['\\HasNoChildren'],
      specialUseFlags: [],
      noSelect: false,
      messages: new Map(),
      uidToMsgId: new Map(),
    });
  }

  /**
   * Delete a mailbox and all its messages.
   * No-ops if the mailbox does not exist.
   */
  deleteMailbox(name: string): void {
    this.mailboxes.delete(name);
  }

  /**
   * Reset the store to its initial state: standard Gmail folders, no messages.
   * Also resets all ID counters. Use between test suites for isolation.
   */
  reset(): void {
    this.mailboxes.clear();
    this.globalMsgIdCounter = BigInt('1000000000000000');
    this.globalThridCounter = BigInt('2000000000000000');
    this.globalModseq = 1;
    this.initializeGmailFolders();
  }

  /**
   * Return the raw mailboxes Map (used by the LIST command handler).
   */
  getAllMailboxes(): Map<string, Mailbox> {
    return this.mailboxes;
  }

  /**
   * Invalidate a mailbox's UIDVALIDITY and clear all its messages.
   * Simulates a UID-validity reset for resilience testing.
   */
  resetUidValidity(mailboxName: string): void {
    const mailbox = this.mailboxes.get(mailboxName);
    if (mailbox) {
      mailbox.uidValidity = Math.floor(DateTime.now().toMillis() / 1000);
      mailbox.uidNext = 1;
      mailbox.messages.clear();
      mailbox.uidToMsgId.clear();
    }
  }

  /**
   * Find all occurrences of a message across all mailboxes by its stable
   * Gmail message ID (X-GM-MSGID). A single logical message can appear in
   * multiple mailboxes (e.g. INBOX and [Gmail]/All Mail) with different UIDs.
   *
   * @param xGmMsgId - Stable Gmail message identifier
   * @returns Array of { mailbox, uid, message } for every occurrence found
   */
  getMessagesByXGmMsgId(
    xGmMsgId: string,
  ): Array<{ mailbox: string; uid: number; message: GmailMessage }> {
    const results: Array<{ mailbox: string; uid: number; message: GmailMessage }> = [];
    for (const [mailboxName, mailbox] of this.mailboxes) {
      for (const [uid, message] of mailbox.messages) {
        if (message.xGmMsgId === xGmMsgId) {
          results.push({ mailbox: mailboxName, uid, message });
        }
      }
    }
    return results;
  }

  /**
   * Find all messages in a specific mailbox that share the given thread ID
   * (X-GM-THRID). Results are sorted by ascending UID.
   *
   * @param xGmThrid - Gmail thread identifier
   * @param mailboxName - Mailbox to search within
   * @returns Array of matching messages sorted by UID, or [] if mailbox missing
   */
  getMessagesByXGmThrid(xGmThrid: string, mailboxName: string): GmailMessage[] {
    const mailbox = this.mailboxes.get(mailboxName);
    if (!mailbox) {
      return [];
    }
    return Array.from(mailbox.messages.values())
      .filter((message) => message.xGmThrid === xGmThrid)
      .sort((messageA, messageB) => messageA.uid - messageB.uid);
  }

  /**
   * Find a single message in a specific mailbox by its stable Gmail message
   * ID (X-GM-MSGID). Returns the first match or undefined if not found.
   *
   * @param mailboxName - Mailbox to search within
   * @param xGmMsgId - Stable Gmail message identifier
   * @returns The matching GmailMessage, or undefined
   */
  findByMsgId(mailboxName: string, xGmMsgId: string): GmailMessage | undefined {
    const mailbox = this.mailboxes.get(mailboxName);
    if (!mailbox) {
      return undefined;
    }
    for (const message of mailbox.messages.values()) {
      if (message.xGmMsgId === xGmMsgId) {
        return message;
      }
    }
    return undefined;
  }

  /**
   * Find all messages in a specific mailbox with the given thread ID.
   * Alias for getMessagesByXGmThrid with argument order swapped to match
   * the mailbox-first convention used elsewhere in the store API.
   *
   * @param mailboxName - Mailbox to search within
   * @param xGmThrid - Gmail thread identifier
   * @returns Array of matching messages sorted by UID, or [] if mailbox missing
   */
  findByThrid(mailboxName: string, xGmThrid: string): GmailMessage[] {
    return this.getMessagesByXGmThrid(xGmThrid, mailboxName);
  }
}
