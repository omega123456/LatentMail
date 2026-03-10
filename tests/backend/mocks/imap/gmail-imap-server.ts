/**
 * gmail-imap-server.ts — Raw TCP fake Gmail IMAP server for backend tests.
 *
 * Implements a subset of the IMAP4rev1 protocol sufficient for imapflow to
 * connect and perform all operations used by the production ImapService:
 *
 *   - XOAUTH2 authentication (via state machine, not temp handler swapping)
 *   - Gmail folder tree (LIST, LSUB)
 *   - SELECT / EXAMINE with CONDSTORE (HIGHESTMODSEQ, PERMANENTFLAGS)
 *   - FETCH with Gmail extensions (X-GM-MSGID, X-GM-THRID, X-GM-LABELS)
 *   - UID FETCH, UID STORE, UID COPY, UID MOVE, UID SEARCH, UID EXPUNGE
 *   - STORE (flags: add / remove / set, with and without .SILENT)
 *   - COPY / MOVE with COPYUID response (UIDPLUS)
 *   - APPEND with literal handling ({N}\r\n<N bytes>)
 *   - EXPUNGE — removes \Deleted messages, sends per-message responses
 *   - SEARCH — ALL, UNSEEN, SEEN, FLAGGED, UID range
 *   - IDLE — hold connection, accept DONE
 *   - STATUS (MESSAGES, RECENT, UIDNEXT, UIDVALIDITY, UNSEEN, HIGHESTMODSEQ)
 *   - NAMESPACE, ID, CAPABILITY, NOOP, LOGOUT, ENABLE, CLOSE, CREATE, DELETE
 *
 * Architecture notes:
 *   - Each TCP connection gets its own ImapSession (state machine).
 *   - The session drives two separate data modes:
 *       'line'    — normal IMAP command line parsing (CRLF-delimited UTF-8)
 *       'literal' — accumulate exactly N raw bytes (for APPEND content)
 *   - XOAUTH2 auth uses a pendingXoauth2Tag field: after we send the server
 *     challenge (+ ) the main handleLine dispatcher checks this field first
 *     and routes the next client line to processXoauth2Response().
 *   - Error injection (injectError / clearErrorInjections) lets tests simulate
 *     transient server failures for resilience testing.
 */

import * as net from 'net';
import { EventEmitter } from 'events';
import { DateTime } from 'luxon';
import { MessageStore, GmailMessage, mailboxToLabel } from './message-store';
import { parseSearchCriteria, applySearch } from './gmail-search';

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

/**
 * Per-connection IMAP session state.
 * The 'mode' field drives the raw data handler's behaviour:
 *   'line'    — split incoming bytes on CRLF and dispatch commands
 *   'literal' — accumulate bytes until literalBytesExpected are consumed
 */
interface ImapSession {
  /** Unique identifier for this connection (used for logging / Map key) */
  id: string;
  /** Underlying TCP socket for this session */
  socket: net.Socket;
  /** IMAP authentication state */
  state: 'not-authenticated' | 'authenticated' | 'selected' | 'logout';
  /** Authenticated email address (set after successful LOGIN / XOAUTH2) */
  email: string | null;
  /** Currently-selected mailbox name, or null when not in 'selected' state */
  selectedMailbox: string | null;
  /** True when the mailbox was opened with EXAMINE (read-only) */
  readOnly: boolean;
  /** True while the client is in IDLE mode (waiting for DONE) */
  idleMode: boolean;
  /** The IMAP tag that started IDLE (returned with OK when DONE is received) */
  idleTag: string | null;

  // ---- XOAUTH2 state ----
  /**
   * Set to the command tag when we are waiting for the client's XOAUTH2
   * response line. Cleared after processing. When non-null, the main line
   * dispatcher routes the next line to processXoauth2Response() instead of
   * the normal command switch.
   */
  pendingXoauth2Tag: string | null;
  /**
   * Set when auth failed once and we sent the JSON error challenge. The next
   * client line should be '*' to cancel; then we send the tagged BAD/NO.
   */
  awaitingXoauth2Cancel: boolean;

  // ---- APPEND literal state ----
  /** Current data-handling mode for this session */
  dataMode: 'line' | 'literal';
  /** Raw bytes accumulated in literal mode */
  literalBuffer: Buffer;
  /** Number of bytes still needed before the literal is complete */
  literalBytesRemaining: number;
  /** Metadata saved when we switched into literal mode for APPEND */
  literalMeta: {
    tag: string;
    mailboxName: string;
    flags: string[];
    internalDate?: string;
  } | null;
  /** Line-mode accumulation buffer (incomplete line without trailing CRLF) */
  lineBuffer: string;
}

// ---------------------------------------------------------------------------
// GmailImapServer
// ---------------------------------------------------------------------------

/**
 * A fake Gmail-compatible IMAP server for integration tests.
 *
 * Backed by a MessageStore for state. Tests control state via the store and
 * assert results by inspecting the store or by checking imapflow behaviour.
 *
 * @example
 * ```ts
 * const store = new MessageStore();
 * const server = new GmailImapServer(store);
 * const port = await server.start();
 * server.setAllowedAccounts(['test@example.com']);
 * // inject messages, run tests...
 * await server.stop();
 * ```
 */
export class GmailImapServer extends EventEmitter {
  private server: net.Server;
  private store: MessageStore;
  private port: number = 0;
  private allowedAccounts: Set<string> = new Set();
  private sessions: Map<string, ImapSession> = new Map();
  private sessionCounter: number = 0;
  /** command → error response string (injected for resilience tests) */
  private errorInjections: Map<string, string> = new Map();

  constructor(store: MessageStore) {
    super();
    this.store = store;
    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.on('error', (serverError) => this.emit('error', serverError));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start listening on a random available port on 127.0.0.1.
   * @returns The assigned TCP port number.
   */
  async start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address() as net.AddressInfo;
        this.port = address.port;
        resolve(this.port);
      });
      this.server.once('error', reject);
    });
  }

  /**
   * Stop the server: close all active sessions then close the listening socket.
   */
  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        session.socket.destroy();
      } catch {
        // Ignore — socket may already be closed
      }
    }
    this.sessions.clear();

    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  /** Return the port this server is listening on (0 before start()). */
  getPort(): number {
    return this.port;
  }

  // ---------------------------------------------------------------------------
  // Account management
  // ---------------------------------------------------------------------------

  /**
   * Replace the set of allowed accounts.
   * When the set is empty (default), any email is accepted.
   */
  setAllowedAccounts(emails: string[]): void {
    this.allowedAccounts = new Set(emails);
  }

  /**
   * Add a single email address to the allowed set.
   */
  addAllowedAccount(email: string): void {
    this.allowedAccounts.add(email);
  }

  // ---------------------------------------------------------------------------
  // Error injection (for resilience tests)
  // ---------------------------------------------------------------------------

  /**
   * Make the server respond with a NO error the next time it receives
   * the given command. The injection stays in place until cleared.
   *
   * @param command - IMAP command name, case-insensitive (e.g. 'FETCH')
   * @param errorResponse - Text after the NO tag (e.g. 'Server error')
   */
  injectError(command: string, errorResponse: string): void {
    this.errorInjections.set(command.toUpperCase(), errorResponse);
  }

  /** Remove all injected errors. */
  clearErrorInjections(): void {
    this.errorInjections.clear();
  }

  // ---------------------------------------------------------------------------
  // Push notifications (for IDLE tests)
  // ---------------------------------------------------------------------------

  /**
   * Send an untagged EXISTS notification to all sessions that have the given
   * mailbox selected. Used by tests to simulate incoming mail during IDLE.
   */
  notifyExists(mailboxName: string, count: number): void {
    for (const session of this.sessions.values()) {
      if (session.selectedMailbox === mailboxName) {
        this.send(session.socket, `* ${count} EXISTS`);
      }
    }
  }

  /**
   * Send an untagged EXPUNGE notification to all sessions that have the given
   * mailbox selected. Used by tests to simulate message removal during IDLE.
   */
  notifyExpunge(mailboxName: string, seqNum: number): void {
    for (const session of this.sessions.values()) {
      if (session.selectedMailbox === mailboxName) {
        this.send(session.socket, `* ${seqNum} EXPUNGE`);
      }
    }
  }

  /** Return the backing MessageStore (for state assertions in tests). */
  getStore(): MessageStore {
    return this.store;
  }

  // ---------------------------------------------------------------------------
  // Connection handling
  // ---------------------------------------------------------------------------

  private handleConnection(socket: net.Socket): void {
    const sessionId = `session-${++this.sessionCounter}`;
    const session: ImapSession = {
      id: sessionId,
      socket,
      state: 'not-authenticated',
      email: null,
      selectedMailbox: null,
      readOnly: false,
      idleMode: false,
      idleTag: null,
      pendingXoauth2Tag: null,
      awaitingXoauth2Cancel: false,
      dataMode: 'line',
      literalBuffer: Buffer.alloc(0),
      literalBytesRemaining: 0,
      literalMeta: null,
      lineBuffer: '',
    };

    this.sessions.set(sessionId, session);

    socket.on('close', () => {
      this.sessions.delete(sessionId);
    });

    socket.on('error', () => {
      this.sessions.delete(sessionId);
    });

    // Send the server greeting immediately
    this.send(
      socket,
      '* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=XOAUTH2 UIDPLUS CONDSTORE QRESYNC IDLE NAMESPACE ID CHILDREN LITERAL+] Gmail IMAP ready',
    );

    // Use binary encoding so we can handle both text commands and APPEND literals
    socket.setEncoding('binary');

    socket.on('data', (rawData: string) => {
      this.handleRawData(session, rawData);
    });
  }

  // ---------------------------------------------------------------------------
  // Data handling — line mode and literal mode
  // ---------------------------------------------------------------------------

  /**
   * Route incoming raw socket data to either literal accumulation or line
   * parsing, depending on the session's current dataMode.
   *
   * The socket uses 'binary' encoding so both text commands (UTF-8 compatible)
   * and APPEND binary literals can be handled uniformly.
   */
  private handleRawData(session: ImapSession, rawData: string): void {
    if (session.dataMode === 'literal') {
      this.handleLiteralData(session, rawData);
      return;
    }

    // Line mode — accumulate into lineBuffer and dispatch complete lines
    session.lineBuffer += rawData;

    let crlfIndex: number;
    while ((crlfIndex = session.lineBuffer.indexOf('\r\n')) !== -1) {
      const line = session.lineBuffer.slice(0, crlfIndex);
      session.lineBuffer = session.lineBuffer.slice(crlfIndex + 2);
      this.handleLine(session, line);

      // handleLine may switch to literal mode (APPEND); if so, stop line parsing
      // and let the remaining buffer be handled as literal data.
      // We check via a helper to avoid TypeScript's control-flow narrowing
      // misidentifying the post-handleLine state as still 'line'.
      if (this.isLiteralMode(session)) {
        if (session.lineBuffer.length > 0) {
          const overflow = session.lineBuffer;
          session.lineBuffer = '';
          this.handleLiteralData(session, overflow);
        }
        return;
      }
    }
  }

  /**
   * Accumulate literal bytes (binary mode for APPEND).
   * When enough bytes have been received, complete the APPEND operation and
   * switch back to line mode.
   */
  private handleLiteralData(session: ImapSession, rawData: string): void {
    const incomingBytes = Buffer.from(rawData, 'binary');

    if (incomingBytes.length <= session.literalBytesRemaining) {
      session.literalBuffer = Buffer.concat([session.literalBuffer, incomingBytes]);
      session.literalBytesRemaining -= incomingBytes.length;
    } else {
      // More data than expected — take exactly what we need
      const needed = session.literalBytesRemaining;
      const literalPart = incomingBytes.slice(0, needed);
      const remainder = incomingBytes.slice(needed);
      session.literalBuffer = Buffer.concat([session.literalBuffer, literalPart]);
      session.literalBytesRemaining = 0;

      // Put the overflow back as a string for line processing
      session.lineBuffer = remainder.toString('binary') + session.lineBuffer;
    }

    if (session.literalBytesRemaining === 0) {
      this.completeLiteralAppend(session);
    }
  }

  /**
   * Called when the literal buffer is complete. Stores the message and
   * restores line mode.
   */
  private completeLiteralAppend(session: ImapSession): void {
    const meta = session.literalMeta;
    if (!meta) {
      session.dataMode = 'line';
      return;
    }

    const rfc822 = session.literalBuffer;
    session.literalBuffer = Buffer.alloc(0);
    session.literalMeta = null;
    session.dataMode = 'line';

    const mailbox = this.store.getMailbox(meta.mailboxName);
    if (!mailbox) {
      this.send(session.socket, `${meta.tag} NO [TRYCREATE] No such mailbox`);
      return;
    }
    if (mailbox.noSelect) {
      this.send(session.socket, `${meta.tag} NO [CANNOT] Mailbox is not selectable`);
      return;
    }

    const { uid } = this.store.appendMessage(meta.mailboxName, rfc822, meta.flags, meta.internalDate);
    const updatedMailbox = this.store.getMailbox(meta.mailboxName);
    this.send(
      session.socket,
      `${meta.tag} OK [APPENDUID ${updatedMailbox?.uidValidity ?? 1} ${uid}] APPEND completed`,
    );

    // Drain any lines that accumulated while we were in literal mode
    if (session.lineBuffer.length > 0) {
      // Copy and clear before processing to avoid re-entrancy confusion
      const pending = session.lineBuffer;
      session.lineBuffer = '';
      this.handleRawData(session, pending);
    }
  }

  // ---------------------------------------------------------------------------
  // Line dispatcher
  // ---------------------------------------------------------------------------

  private handleLine(session: ImapSession, line: string): void {
    // ---- IDLE DONE handling ----
    if (session.idleMode) {
      if (line.trim() === 'DONE') {
        session.idleMode = false;
        const idleTag = session.idleTag ?? '*';
        session.idleTag = null;
        this.send(session.socket, `${idleTag} OK IDLE terminated`);
      }
      return;
    }

    // ---- XOAUTH2 response line ----
    if (session.pendingXoauth2Tag !== null) {
      this.processXoauth2Response(session, line);
      return;
    }

    // ---- Parse tag and command ----
    const firstSpaceIndex = line.indexOf(' ');
    if (firstSpaceIndex === -1) {
      return;
    }

    const tag = line.slice(0, firstSpaceIndex);
    const rest = line.slice(firstSpaceIndex + 1);
    const commandSpaceIndex = rest.indexOf(' ');
    const command =
      commandSpaceIndex === -1
        ? rest.toUpperCase()
        : rest.slice(0, commandSpaceIndex).toUpperCase();
    const args = commandSpaceIndex === -1 ? '' : rest.slice(commandSpaceIndex + 1);

    // ---- Error injection ----
    const injectedError = this.errorInjections.get(command);
    if (injectedError) {
      this.send(session.socket, `${tag} NO ${injectedError}`);
      return;
    }

    // ---- Command dispatch ----
    switch (command) {
      case 'CAPABILITY': {
        this.handleCapability(session, tag);
        break;
      }
      case 'NOOP': {
        this.send(session.socket, `${tag} OK NOOP completed`);
        break;
      }
      case 'LOGOUT': {
        this.send(session.socket, '* BYE IMAP4rev1 Server logging out');
        this.send(session.socket, `${tag} OK LOGOUT completed`);
        session.state = 'logout';
        session.socket.end();
        break;
      }
      case 'AUTHENTICATE': {
        this.handleAuthenticate(session, tag, args);
        break;
      }
      case 'LOGIN': {
        this.handleLogin(session, tag, args);
        break;
      }
      case 'ID': {
        this.send(session.socket, '* ID ("name" "GmailImapFake" "version" "1.0")');
        this.send(session.socket, `${tag} OK ID completed`);
        break;
      }
      case 'ENABLE': {
        this.handleEnable(session, tag, args);
        break;
      }
      case 'NAMESPACE': {
        this.send(session.socket, '* NAMESPACE (("" "/")) NIL NIL');
        this.send(session.socket, `${tag} OK NAMESPACE completed`);
        break;
      }
      case 'LIST': {
        this.handleList(session, tag, args);
        break;
      }
      case 'LSUB': {
        this.handleLsub(session, tag);
        break;
      }
      case 'SELECT': {
        this.handleSelect(session, tag, args, false);
        break;
      }
      case 'EXAMINE': {
        this.handleSelect(session, tag, args, true);
        break;
      }
      case 'STATUS': {
        this.handleStatus(session, tag, args);
        break;
      }
      case 'FETCH': {
        this.handleFetch(session, tag, args, false);
        break;
      }
      case 'UID': {
        this.handleUid(session, tag, args);
        break;
      }
      case 'STORE': {
        this.handleStore(session, tag, args, false);
        break;
      }
      case 'COPY': {
        this.handleCopy(session, tag, args, false);
        break;
      }
      case 'MOVE': {
        this.handleMove(session, tag, args, false);
        break;
      }
      case 'APPEND': {
        this.handleAppend(session, tag, args);
        break;
      }
      case 'CREATE': {
        this.handleCreate(session, tag, args);
        break;
      }
      case 'DELETE': {
        this.handleDelete(session, tag, args);
        break;
      }
      case 'EXPUNGE': {
        this.handleExpunge(session, tag);
        break;
      }
      case 'SEARCH': {
        this.handleSearch(session, tag, args, false);
        break;
      }
      case 'IDLE': {
        this.handleIdle(session, tag);
        break;
      }
      case 'CLOSE': {
        if (session.state === 'selected') {
          // Silently expunge \Deleted messages on CLOSE, but only for read-write
          // sessions (RFC 3501 — CLOSE must not expunge a read-only mailbox).
          if (session.selectedMailbox && !session.readOnly) {
            this.store.expunge(session.selectedMailbox);
          }
          session.selectedMailbox = null;
          session.state = 'authenticated';
        }
        this.send(session.socket, `${tag} OK CLOSE completed`);
        break;
      }
      case 'UNSELECT': {
        session.selectedMailbox = null;
        session.state = 'authenticated';
        this.send(session.socket, `${tag} OK UNSELECT completed`);
        break;
      }
      case 'SUBSCRIBE':
      case 'UNSUBSCRIBE': {
        // Accept silently — subscription state is not tracked
        this.send(session.socket, `${tag} OK ${command} completed`);
        break;
      }
      case 'XLIST': {
        // Legacy Gmail XLIST — respond identically to LIST
        this.handleList(session, tag, args);
        break;
      }
      default: {
        this.send(session.socket, `${tag} BAD Command unrecognized: ${command}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Return true when the session is currently in literal-accumulation mode.
   * Extracted to a method to avoid TypeScript control-flow narrowing issues
   * when checking the mode after a call that may have changed it.
   */
  private isLiteralMode(session: ImapSession): boolean {
    return session.dataMode === 'literal';
  }

  private send(socket: net.Socket, message: string): void {
    if (!socket.destroyed) {
      socket.write(message + '\r\n', 'binary');
    }
  }

  // ---------------------------------------------------------------------------
  // CAPABILITY
  // ---------------------------------------------------------------------------

  private handleCapability(session: ImapSession, tag: string): void {
    this.send(
      session.socket,
      '* CAPABILITY IMAP4rev1 SASL-IR AUTH=XOAUTH2 UIDPLUS CONDSTORE QRESYNC IDLE NAMESPACE ID CHILDREN LITERAL+',
    );
    this.send(session.socket, `${tag} OK CAPABILITY completed`);
  }

  // ---------------------------------------------------------------------------
  // Authentication — XOAUTH2 state machine
  // ---------------------------------------------------------------------------

  /**
   * Handle the AUTHENTICATE command.
   * Only XOAUTH2 is supported. We send an empty challenge (+ ) and record
   * the tag so the next client line is routed to processXoauth2Response().
   */
  private handleAuthenticate(session: ImapSession, tag: string, args: string): void {
    const mechanism = args.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    if (mechanism !== 'XOAUTH2') {
      this.send(session.socket, `${tag} NO [CANNOT] Unsupported auth mechanism: ${mechanism}`);
      return;
    }

    // Some clients send the initial response on the same line as AUTHENTICATE.
    // Format: AUTHENTICATE XOAUTH2 <base64>
    const parts = args.trim().split(/\s+/);
    if (parts.length >= 2) {
      // Client sent the token inline — process it directly
      session.pendingXoauth2Tag = tag;
      this.processXoauth2Response(session, parts[1]);
      return;
    }

    // Standard flow: send empty challenge, wait for next line
    session.pendingXoauth2Tag = tag;
    this.send(session.socket, '+ ');
  }

  /**
   * Process the client's XOAUTH2 response line.
   *
   * The XOAUTH2 token is a base64-encoded string of:
   *   user=<email>\x01auth=Bearer <token>\x01\x01
   *
   * On success: transition to 'authenticated', clear pendingXoauth2Tag.
   * On failure: send JSON error challenge, set awaitingXoauth2Cancel.
   * On cancel (*): send tagged BAD.
   */
  private processXoauth2Response(session: ImapSession, line: string): void {
    const tag = session.pendingXoauth2Tag!;

    // Handle cancellation from a previous failed auth attempt
    if (session.awaitingXoauth2Cancel) {
      session.awaitingXoauth2Cancel = false;
      session.pendingXoauth2Tag = null;
      if (line.trim() === '*') {
        this.send(session.socket, `${tag} BAD Authentication cancelled`);
      } else {
        this.send(session.socket, `${tag} NO [AUTHENTICATIONFAILED] Authentication failed`);
      }
      return;
    }

    session.pendingXoauth2Tag = null;

    // Client cancels without trying
    if (line.trim() === '*') {
      this.send(session.socket, `${tag} BAD Authentication cancelled`);
      return;
    }

    try {
      const decoded = Buffer.from(line.trim(), 'base64').toString('utf8');
      const userMatch = decoded.match(/user=([^\x01]+)/);
      const email = userMatch ? userMatch[1] : null;

      if (email && (this.allowedAccounts.size === 0 || this.allowedAccounts.has(email))) {
        session.state = 'authenticated';
        session.email = email;
        this.send(
          session.socket,
          `${tag} OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=XOAUTH2 UIDPLUS CONDSTORE QRESYNC IDLE NAMESPACE ID CHILDREN LITERAL+] Authenticated`,
        );
      } else {
        // Send the RFC 7628 JSON failure response, wait for client to send '*'
        const failureJson = JSON.stringify({
          status: '401',
          schemes: 'Bearer',
          scope: 'https://mail.google.com/',
        });
        const failureB64 = Buffer.from(failureJson).toString('base64');
        session.pendingXoauth2Tag = tag;
        session.awaitingXoauth2Cancel = true;
        this.send(session.socket, `+ ${failureB64}`);
      }
    } catch {
      this.send(session.socket, `${tag} BAD Invalid XOAUTH2 token encoding`);
    }
  }

  // ---------------------------------------------------------------------------
  // LOGIN (plain-text fallback)
  // ---------------------------------------------------------------------------

  private handleLogin(session: ImapSession, tag: string, args: string): void {
    // Parse: user password (both optionally quoted)
    const quotedMatch = args.match(/^"([^"]+)"\s+"([^"]+)"$/);
    let email: string;

    if (quotedMatch) {
      email = quotedMatch[1];
    } else {
      const spaceParts = args.split(' ');
      email = (spaceParts[0] ?? '').replace(/"/g, '');
    }

    if (this.allowedAccounts.size === 0 || this.allowedAccounts.has(email)) {
      session.state = 'authenticated';
      session.email = email;
      this.send(session.socket, `${tag} OK LOGIN completed`);
    } else {
      this.send(session.socket, `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
    }
  }

  // ---------------------------------------------------------------------------
  // ENABLE
  // ---------------------------------------------------------------------------

  private handleEnable(session: ImapSession, tag: string, args: string): void {
    const extensions = args.toUpperCase().split(/\s+/);
    const enabled: string[] = [];

    if (extensions.includes('CONDSTORE')) {
      enabled.push('CONDSTORE');
    }
    if (extensions.includes('QRESYNC')) {
      enabled.push('QRESYNC');
    }

    if (enabled.length > 0) {
      this.send(session.socket, `* ENABLED ${enabled.join(' ')}`);
    }
    this.send(session.socket, `${tag} OK ENABLE completed`);
  }

  // ---------------------------------------------------------------------------
  // LIST / LSUB
  // ---------------------------------------------------------------------------

  private handleList(session: ImapSession, tag: string, _args: string): void {
    if (session.state === 'not-authenticated') {
      this.send(session.socket, `${tag} NO Not authenticated`);
      return;
    }

    for (const [name, mailbox] of this.store.getAllMailboxes()) {
      const allFlags = [...mailbox.flags, ...mailbox.specialUseFlags];
      const flagStr = allFlags.join(' ');
      this.send(session.socket, `* LIST (${flagStr}) "/" "${name}"`);
    }
    this.send(session.socket, `${tag} OK LIST completed`);
  }

  private handleLsub(session: ImapSession, tag: string): void {
    if (session.state === 'not-authenticated') {
      this.send(session.socket, `${tag} NO Not authenticated`);
      return;
    }
    // Return all selectable mailboxes as subscribed
    for (const [name, mailbox] of this.store.getAllMailboxes()) {
      if (!mailbox.noSelect) {
        this.send(session.socket, `* LSUB () "/" "${name}"`);
      }
    }
    this.send(session.socket, `${tag} OK LSUB completed`);
  }

  // ---------------------------------------------------------------------------
  // SELECT / EXAMINE
  // ---------------------------------------------------------------------------

  private handleSelect(
    session: ImapSession,
    tag: string,
    args: string,
    readOnly: boolean,
  ): void {
    if (session.state === 'not-authenticated') {
      this.send(session.socket, `${tag} NO Not authenticated`);
      return;
    }

    const mailboxName = args.trim().replace(/^"|"$/g, '');
    const mailbox = this.store.getMailbox(mailboxName);

    if (!mailbox) {
      this.send(session.socket, `${tag} NO [NONEXISTENT] No such mailbox`);
      return;
    }
    if (mailbox.noSelect) {
      this.send(session.socket, `${tag} NO [NOSELECT] Mailbox is not selectable`);
      return;
    }

    session.selectedMailbox = mailboxName;
    session.state = 'selected';
    session.readOnly = readOnly;

    const messages = this.store.getMessages(mailboxName);
    const existsCount = messages.length;
    const unseenMessages = messages.filter((message) => !message.flags.has('\\Seen'));
    const unseenCount = unseenMessages.length;
    const firstUnseenIndex =
      unseenCount > 0 ? messages.findIndex((message) => !message.flags.has('\\Seen')) + 1 : 0;

    this.send(session.socket, `* ${existsCount} EXISTS`);
    this.send(session.socket, `* 0 RECENT`);

    if (firstUnseenIndex > 0) {
      this.send(
        session.socket,
        `* OK [UNSEEN ${firstUnseenIndex}] Message ${firstUnseenIndex} is the first unseen`,
      );
    }

    this.send(session.socket, `* OK [UIDVALIDITY ${mailbox.uidValidity}] UIDs valid`);
    this.send(session.socket, `* OK [UIDNEXT ${mailbox.uidNext}] Predicted next UID`);
    this.send(session.socket, `* OK [HIGHESTMODSEQ ${mailbox.highestModseq}] Highest`);
    this.send(
      session.socket,
      `* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)`,
    );
    this.send(
      session.socket,
      `* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted`,
    );

    const statusCode = readOnly ? 'READ-ONLY' : 'READ-WRITE';
    this.send(session.socket, `${tag} OK [${statusCode}] ${readOnly ? 'EXAMINE' : 'SELECT'} completed`);
  }

  // ---------------------------------------------------------------------------
  // STATUS
  // ---------------------------------------------------------------------------

  private handleStatus(session: ImapSession, tag: string, args: string): void {
    if (session.state === 'not-authenticated') {
      this.send(session.socket, `${tag} NO Not authenticated`);
      return;
    }

    // Parse: "mailbox" (ITEM1 ITEM2 ...)  or  mailbox (ITEM1 ITEM2 ...)
    const matchResult = args.match(/^"?([^"(]+)"?\s*\(([^)]+)\)/);
    if (!matchResult) {
      this.send(session.socket, `${tag} BAD Invalid STATUS arguments`);
      return;
    }

    const mailboxName = matchResult[1].trim();
    const requestedItems = matchResult[2].toUpperCase().split(/\s+/);
    const mailbox = this.store.getMailbox(mailboxName);

    if (!mailbox) {
      this.send(session.socket, `${tag} NO [NONEXISTENT] No such mailbox`);
      return;
    }

    const messages = this.store.getMessages(mailboxName);
    const resultParts: string[] = [];

    if (requestedItems.includes('MESSAGES')) {
      resultParts.push(`MESSAGES ${messages.length}`);
    }
    if (requestedItems.includes('RECENT')) {
      resultParts.push('RECENT 0');
    }
    if (requestedItems.includes('UIDNEXT')) {
      resultParts.push(`UIDNEXT ${mailbox.uidNext}`);
    }
    if (requestedItems.includes('UIDVALIDITY')) {
      resultParts.push(`UIDVALIDITY ${mailbox.uidValidity}`);
    }
    if (requestedItems.includes('UNSEEN')) {
      const unseenCount = messages.filter((message) => !message.flags.has('\\Seen')).length;
      resultParts.push(`UNSEEN ${unseenCount}`);
    }
    if (requestedItems.includes('HIGHESTMODSEQ')) {
      resultParts.push(`HIGHESTMODSEQ ${mailbox.highestModseq}`);
    }

    this.send(session.socket, `* STATUS "${mailboxName}" (${resultParts.join(' ')})`);
    this.send(session.socket, `${tag} OK STATUS completed`);
  }

  // ---------------------------------------------------------------------------
  // FETCH
  // ---------------------------------------------------------------------------

  private handleFetch(
    session: ImapSession,
    tag: string,
    args: string,
    uidMode: boolean,
  ): void {
    if (session.state !== 'selected' || !session.selectedMailbox) {
      this.send(session.socket, `${tag} NO No mailbox selected`);
      return;
    }

    const mailboxName = session.selectedMailbox;
    const allMessages = this.store.getMessages(mailboxName);

    // Strip CONDSTORE modifier FIRST, before splitting sequence-set from fetch items.
    const condstoreParenMatch = args.match(/\s*\(CHANGEDSINCE\s+\d+\)/i);
    const condstoreBarMatch = args.match(/\s+CHANGEDSINCE\s+\d+/i);
    const condstoreMatch = condstoreParenMatch ?? condstoreBarMatch;
    const argsWithoutCondstore = condstoreMatch ? args.replace(condstoreMatch[0], '') : args;

    // Extract the CHANGEDSINCE value before stripping it
    const changedSinceMatch = args.match(/CHANGEDSINCE\s+(\d+)/i);
    const changedSince = changedSinceMatch ? parseInt(changedSinceMatch[1], 10) : null;

    // Split argsWithoutCondstore into sequence-set and fetch-items portions.
    // The sequence set ends at the first '(' or at the item token boundary.
    const parenIndex = argsWithoutCondstore.indexOf('(');
    let sequenceSet: string;
    let fetchItemsStr: string;

    if (parenIndex !== -1) {
      sequenceSet = argsWithoutCondstore.slice(0, parenIndex).trim();
      fetchItemsStr = argsWithoutCondstore.slice(parenIndex);
    } else {
      // Items might be a macro or single token: "1:* FLAGS"
      const firstSpaceIndex = argsWithoutCondstore.indexOf(' ');
      if (firstSpaceIndex !== -1) {
        sequenceSet = argsWithoutCondstore.slice(0, firstSpaceIndex).trim();
        fetchItemsStr = argsWithoutCondstore.slice(firstSpaceIndex + 1).trim();
      } else {
        sequenceSet = argsWithoutCondstore.trim();
        fetchItemsStr = 'ALL';
      }
    }

    const fetchItems = this.parseFetchItems(fetchItemsStr);

    let targetMessages: GmailMessage[];
    if (uidMode) {
      targetMessages = this.resolveUidSet(allMessages, sequenceSet);
    } else {
      targetMessages = this.resolveSeqSet(allMessages, sequenceSet);
    }

    if (changedSince !== null) {
      targetMessages = targetMessages.filter((message) => message.modseq > changedSince);
    }

    for (const message of targetMessages) {
      const seqNum = allMessages.indexOf(message) + 1;
      const responseBody = this.buildFetchResponse(message, seqNum, fetchItems, uidMode);
      this.send(session.socket, `* ${seqNum} FETCH (${responseBody})`);
    }

    this.send(session.socket, `${tag} OK FETCH completed`);
  }

  /**
   * Parse a FETCH items string into an array of item tokens.
   * Handles macros (ALL, FAST, FULL) and bracket notation like BODY[HEADER].
   * Also handles parenthesised field lists like BODY[HEADER.FIELDS (FROM TO)].
   * Normalises BODY.PEEK[...] to BODY[...] so the server does not set \Seen.
   */
  private parseFetchItems(itemStr: string): string[] {
    const cleaned = itemStr.replace(/^\s*\(/, '').replace(/\)\s*$/, '').trim();

    // Macro expansion
    if (cleaned === 'ALL') {
      return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'];
    }
    if (cleaned === 'FAST') {
      return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'];
    }
    if (cleaned === 'FULL') {
      return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY'];
    }

    // Tokenise by spaces, respecting brackets [] and parens () inside brackets.
    // Depth tracks [] nesting; parenDepth tracks () when inside brackets.
    const items: string[] = [];
    let bracketDepth = 0;
    let parenDepth = 0;
    let current = '';

    for (const character of cleaned) {
      if (character === '[') {
        bracketDepth++;
        current += character;
      } else if (character === ']') {
        bracketDepth--;
        current += character;
      } else if (character === '(' && bracketDepth > 0) {
        parenDepth++;
        current += character;
      } else if (character === ')' && bracketDepth > 0) {
        parenDepth--;
        current += character;
      } else if (character === ' ' && bracketDepth === 0 && parenDepth === 0) {
        if (current) {
          items.push(current.toUpperCase().replace(/^BODY\.PEEK/, 'BODY'));
          current = '';
        }
      } else {
        current += character;
      }
    }
    if (current) {
      items.push(current.toUpperCase().replace(/^BODY\.PEEK/, 'BODY'));
    }
    return items;
  }

  /**
   * Build the parenthesised body of an untagged FETCH response.
   * Items are space-separated; literal bodies use the {N}\r\n<bytes> notation.
   */
  private buildFetchResponse(
    message: GmailMessage,
    _seqNum: number,
    items: string[],
    uidMode: boolean,
  ): string {
    const parts: string[] = [];

    // UID is always first in UID FETCH responses
    if (uidMode) {
      parts.push(`UID ${message.uid}`);
    }

    for (const item of items) {
      if (item === 'UID') {
        if (!uidMode) {
          parts.push(`UID ${message.uid}`);
        }
        // Already added above for uidMode
      } else if (item === 'FLAGS') {
        const flagStr = Array.from(message.flags).join(' ');
        parts.push(`FLAGS (${flagStr})`);
      } else if (item === 'INTERNALDATE') {
        const dateStr = this.formatImapDate(message.internalDate);
        parts.push(`INTERNALDATE "${dateStr}"`);
      } else if (item === 'RFC822.SIZE') {
        parts.push(`RFC822.SIZE ${message.rfc822.length}`);
      } else if (item === 'MODSEQ') {
        parts.push(`MODSEQ (${message.modseq})`);
      } else if (item === 'X-GM-MSGID') {
        parts.push(`X-GM-MSGID ${message.xGmMsgId}`);
      } else if (item === 'X-GM-THRID') {
        parts.push(`X-GM-THRID ${message.xGmThrid}`);
      } else if (item === 'X-GM-LABELS') {
        const labelStr = message.xGmLabels.map((label) => `"${label}"`).join(' ');
        parts.push(`X-GM-LABELS (${labelStr})`);
      } else if (item === 'BODY[]' || item === 'RFC822') {
        const bodyStr = message.rfc822.toString('binary');
        parts.push(`BODY[] {${message.rfc822.length}}\r\n${bodyStr}`);
      } else if (item === 'BODY[HEADER]' || item.startsWith('BODY[HEADER]')) {
        const headerEnd = message.rfc822.indexOf('\r\n\r\n');
        const headers =
          headerEnd >= 0 ? message.rfc822.slice(0, headerEnd + 4) : message.rfc822;
        parts.push(`BODY[HEADER] {${headers.length}}\r\n${headers.toString('binary')}`);
      } else if (item === 'BODY[TEXT]') {
        const headerEnd = message.rfc822.indexOf('\r\n\r\n');
        const body = headerEnd >= 0 ? message.rfc822.slice(headerEnd + 4) : Buffer.alloc(0);
        parts.push(`BODY[TEXT] {${body.length}}\r\n${body.toString('binary')}`);
      } else if (item === 'BODY[HEADER.FIELDS' || item.startsWith('BODY[HEADER.FIELDS')) {
        // Partial match — just return all headers
        const headerEnd = message.rfc822.indexOf('\r\n\r\n');
        const headers =
          headerEnd >= 0 ? message.rfc822.slice(0, headerEnd + 4) : message.rfc822;
        parts.push(`BODY[HEADER.FIELDS] {${headers.length}}\r\n${headers.toString('binary')}`);
      } else if (item === 'ENVELOPE') {
        parts.push(`ENVELOPE ${this.buildEnvelope(message)}`);
      } else if (item === 'BODYSTRUCTURE') {
        parts.push(`BODYSTRUCTURE ${this.buildBodyStructure()}`);
      } else if (item === 'BODY') {
        // Alias for BODYSTRUCTURE in FULL macro
        parts.push(`BODY ${this.buildBodyStructure()}`);
      }
      // Silently ignore unrecognised items — imapflow may send CONDSTORE modifiers
    }

    return parts.join(' ');
  }

  /**
   * Format an ISO 8601 date string as an IMAP INTERNALDATE value.
   * Output format: "DD-Mon-YYYY HH:MM:SS +0000"
   */
  private formatImapDate(isoDate: string): string {
    const dateTime = DateTime.fromISO(isoDate, { zone: 'utc' });
    return dateTime.toFormat('dd-MMM-yyyy HH:mm:ss +0000');
  }

  /**
   * Build a minimal IMAP ENVELOPE structure from a message's RFC 822 headers.
   * The format is: (date subject from sender reply-to to cc bcc in-reply-to message-id)
   */
  private buildEnvelope(message: GmailMessage): string {
    const headerSection = message.rfc822.toString('utf8').split('\r\n\r\n')[0] ?? '';
    const headers: Record<string, string> = {};

    for (const line of headerSection.split('\r\n')) {
      const colonIndex = line.indexOf(': ');
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).toLowerCase();
        const value = line.slice(colonIndex + 2);
        if (!headers[key]) {
          headers[key] = value;
        }
      }
    }

    const date = headers['date'] ? `"${headers['date']}"` : 'NIL';
    const subject = headers['subject'] ? `"${headers['subject']}"` : 'NIL';
    const from = headers['from'] ? this.formatAddressList(headers['from']) : 'NIL';
    const to = headers['to'] ? this.formatAddressList(headers['to']) : 'NIL';
    const messageId = headers['message-id'] ? `"${headers['message-id']}"` : 'NIL';

    return `(${date} ${subject} ${from} ${from} ${from} ${to} NIL NIL NIL ${messageId})`;
  }

  /**
   * Format an email address header value as an IMAP address list.
   * Returns IMAP parenthesised form: (("Name" NIL "user" "domain"))
   */
  private formatAddressList(raw: string): string {
    const nameAndAngle = raw.match(/^"?([^<"]+)"?\s*<([^>]+)>/);
    if (nameAndAngle) {
      const name = nameAndAngle[1].trim();
      const emailAddress = nameAndAngle[2];
      const atIndex = emailAddress.indexOf('@');
      const user = emailAddress.slice(0, atIndex);
      const domain = emailAddress.slice(atIndex + 1);
      return `(("${name}" NIL "${user}" "${domain}"))`;
    }
    const atIndex = raw.indexOf('@');
    if (atIndex > 0) {
      const user = raw.slice(0, atIndex).trim();
      const domain = raw.slice(atIndex + 1).trim();
      return `((NIL NIL "${user}" "${domain}"))`;
    }
    return 'NIL';
  }

  /**
   * Build a simplified IMAP BODYSTRUCTURE for a single-part text/plain message.
   * Sufficient for most test scenarios.
   */
  private buildBodyStructure(): string {
    return '("TEXT" "PLAIN" ("charset" "utf-8") NIL NIL "7bit" 100 5)';
  }

  // ---------------------------------------------------------------------------
  // STORE
  // ---------------------------------------------------------------------------

  private handleStore(
    session: ImapSession,
    tag: string,
    args: string,
    uidMode: boolean,
  ): void {
    if (session.state !== 'selected' || !session.selectedMailbox) {
      this.send(session.socket, `${tag} NO No mailbox selected`);
      return;
    }
    if (session.readOnly) {
      this.send(session.socket, `${tag} NO [READ-ONLY] Mailbox is read-only`);
      return;
    }

    const mailboxName = session.selectedMailbox;
    const allMessages = this.store.getMessages(mailboxName);

    // Parse: <sequenceSet> <+|-|>FLAGS[.SILENT] (<flag1> <flag2> ...)
    const matchResult = args.match(/^(\S+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+\(([^)]*)\)/i);
    if (!matchResult) {
      this.send(session.socket, `${tag} BAD Invalid STORE arguments`);
      return;
    }

    const sequenceSet = matchResult[1];
    const flagOperation = matchResult[2].toUpperCase();
    const flagListStr = matchResult[3].trim();
    const flagList = flagListStr.length > 0 ? flagListStr.split(/\s+/) : [];
    const isSilent = flagOperation.includes('.SILENT');

    let operation: 'add' | 'remove' | 'set';
    if (flagOperation.startsWith('+')) {
      operation = 'add';
    } else if (flagOperation.startsWith('-')) {
      operation = 'remove';
    } else {
      operation = 'set';
    }

    let targetMessages: GmailMessage[];
    if (uidMode) {
      targetMessages = this.resolveUidSet(allMessages, sequenceSet);
    } else {
      targetMessages = this.resolveSeqSet(allMessages, sequenceSet);
    }

    for (const message of targetMessages) {
      this.store.setFlags(mailboxName, message.uid, flagList, operation);

      if (!isSilent) {
        const updatedMessage = this.store.getMessage(mailboxName, message.uid);
        if (updatedMessage) {
          const seqNum = allMessages.indexOf(message) + 1;
          const flagStr = Array.from(updatedMessage.flags).join(' ');
          this.send(
            session.socket,
            `* ${seqNum} FETCH (FLAGS (${flagStr}) UID ${message.uid})`,
          );
        }
      }
    }

    this.send(session.socket, `${tag} OK STORE completed`);
  }

  // ---------------------------------------------------------------------------
  // COPY
  // ---------------------------------------------------------------------------

  private handleCopy(
    session: ImapSession,
    tag: string,
    args: string,
    uidMode: boolean,
  ): void {
    if (session.state !== 'selected' || !session.selectedMailbox) {
      this.send(session.socket, `${tag} NO No mailbox selected`);
      return;
    }
    if (session.readOnly) {
      this.send(session.socket, `${tag} NO [READ-ONLY] Mailbox is read-only`);
      return;
    }

    // Parse: <sequenceSet> <destinationMailbox>
    // The destination mailbox may be quoted (e.g. "[Gmail]/Sent Mail") or unquoted.
    const parsed = this.parseLastMailboxArg(args);
    if (parsed === null) {
      this.send(session.socket, `${tag} BAD Invalid COPY arguments`);
      return;
    }

    const sequenceSet = parsed.sequenceSet;
    const targetMailboxName = parsed.mailboxName;

    const sourceMailboxName = session.selectedMailbox;
    const allMessages = this.store.getMessages(sourceMailboxName);

    let targetMessages: GmailMessage[];
    if (uidMode) {
      targetMessages = this.resolveUidSet(allMessages, sequenceSet);
    } else {
      targetMessages = this.resolveSeqSet(allMessages, sequenceSet);
    }

    const targetMailbox = this.store.getMailbox(targetMailboxName);
    if (!targetMailbox) {
      this.send(session.socket, `${tag} NO [TRYCREATE] No such destination mailbox`);
      return;
    }
    if (targetMailbox.noSelect) {
      this.send(session.socket, `${tag} NO [CANNOT] Mailbox is not selectable`);
      return;
    }

    const sourceUids: number[] = [];
    const destinationUids: number[] = [];

    for (const message of targetMessages) {
      const newUid = this.store.copyMessage(sourceMailboxName, message.uid, targetMailboxName);
      if (newUid !== null) {
        sourceUids.push(message.uid);
        destinationUids.push(newUid);
      }
    }

    if (sourceUids.length > 0) {
      const updatedTargetMailbox = this.store.getMailbox(targetMailboxName);
      this.send(
        session.socket,
        `${tag} OK [COPYUID ${updatedTargetMailbox?.uidValidity ?? 1} ${sourceUids.join(',')} ${destinationUids.join(',')}] COPY completed`,
      );
    } else {
      this.send(session.socket, `${tag} OK COPY completed`);
    }
  }

  // ---------------------------------------------------------------------------
  // MOVE
  // ---------------------------------------------------------------------------

  private handleMove(
    session: ImapSession,
    tag: string,
    args: string,
    uidMode: boolean,
  ): void {
    if (session.state !== 'selected' || !session.selectedMailbox) {
      this.send(session.socket, `${tag} NO No mailbox selected`);
      return;
    }
    if (session.readOnly) {
      this.send(session.socket, `${tag} NO [READ-ONLY] Mailbox is read-only`);
      return;
    }

    // Parse: <sequenceSet> <destinationMailbox>
    // The destination mailbox may be quoted (e.g. "[Gmail]/Sent Mail") or unquoted.
    const parsed = this.parseLastMailboxArg(args);
    if (parsed === null) {
      this.send(session.socket, `${tag} BAD Invalid MOVE arguments`);
      return;
    }

    const sequenceSet = parsed.sequenceSet;
    const targetMailboxName = parsed.mailboxName;
    const sourceMailboxName = session.selectedMailbox;
    const allMessages = this.store.getMessages(sourceMailboxName);

    const targetMailbox = this.store.getMailbox(targetMailboxName);
    if (!targetMailbox) {
      this.send(session.socket, `${tag} NO [TRYCREATE] No such destination mailbox`);
      return;
    }
    if (targetMailbox.noSelect) {
      this.send(session.socket, `${tag} NO [CANNOT] Mailbox is not selectable`);
      return;
    }

    let targetMessages: GmailMessage[];
    if (uidMode) {
      targetMessages = this.resolveUidSet(allMessages, sequenceSet);
    } else {
      targetMessages = this.resolveSeqSet(allMessages, sequenceSet);
    }

    const sourceUids: number[] = [];
    const destinationUids: number[] = [];

    for (const message of targetMessages) {
      const newUid = this.store.copyMessage(sourceMailboxName, message.uid, targetMailboxName);
      if (newUid !== null) {
        sourceUids.push(message.uid);
        destinationUids.push(newUid);

        // Remove the source mailbox label from the copy — the message is no longer
        // in the source mailbox after a MOVE, so its X-GM-LABELS should reflect that.
        const sourceLabel = mailboxToLabel(sourceMailboxName);
        if (sourceLabel !== null) {
          const copiedMessage = this.store.getMessage(targetMailboxName, newUid);
          if (copiedMessage) {
            copiedMessage.xGmLabels = copiedMessage.xGmLabels.filter(
              (label) => label !== sourceLabel,
            );
          }
        }
      }
    }

    // Capture sequence numbers BEFORE expunge for EXPUNGE notifications (issue #11)
    const messagesBefore = this.store.getMessages(sourceMailboxName);

    // Remove originals by UID directly (bypasses \Deleted flag state on other messages)
    const targetUids = targetMessages.map((message) => message.uid);
    this.store.expungeUids(sourceMailboxName, targetUids);

    // Send EXPUNGE responses in descending sequence-number order (issue #11)
    const expungeSeqNums: number[] = [];
    for (const uid of targetUids) {
      const seqNum = messagesBefore.findIndex((message) => message.uid === uid) + 1;
      if (seqNum > 0) {
        expungeSeqNums.push(seqNum);
      }
    }
    for (const seqNum of expungeSeqNums.sort((sequenceA, sequenceB) => sequenceB - sequenceA)) {
      this.send(session.socket, `* ${seqNum} EXPUNGE`);
    }

    if (sourceUids.length > 0) {
      const updatedTargetMailbox = this.store.getMailbox(targetMailboxName);
      this.send(
        session.socket,
        `${tag} OK [COPYUID ${updatedTargetMailbox?.uidValidity ?? 1} ${sourceUids.join(',')} ${destinationUids.join(',')}] MOVE completed`,
      );
    } else {
      this.send(session.socket, `${tag} OK MOVE completed`);
    }
  }

  // ---------------------------------------------------------------------------
  // APPEND
  // ---------------------------------------------------------------------------

  private handleAppend(session: ImapSession, tag: string, args: string): void {
    if (session.state === 'not-authenticated') {
      this.send(session.socket, `${tag} NO Not authenticated`);
      return;
    }

    // Parse: "mailboxName" (\Flag1 \Flag2) "date" {size} or {size+}
    // The {size} or {size+} literal indicator is always at the end of the line.
    const sizeMatch = args.match(/\{(\d+)(\+)?\}$/);
    if (!sizeMatch) {
      this.send(session.socket, `${tag} BAD Invalid APPEND command — missing literal size`);
      return;
    }

    const literalSize = parseInt(sizeMatch[1], 10);
    // LITERAL+: non-synchronising literal uses {N+} — no continuation response needed.
    const isSynchronizingLiteral = sizeMatch[2] !== '+';

    // Extract mailbox name (required, first quoted or unquoted token)
    let mailboxName: string;
    const quotedMailboxMatch = args.match(/^"([^"]+)"/);
    if (quotedMailboxMatch) {
      mailboxName = quotedMailboxMatch[1];
    } else {
      const spaceIndex = args.indexOf(' ');
      mailboxName = spaceIndex !== -1 ? args.slice(0, spaceIndex) : args;
    }

    // Extract optional flags in parentheses
    const flagsMatch = args.match(/\(([^)]*)\)/);
    const flags = flagsMatch
      ? flagsMatch[1].split(/\s+/).filter((flag) => flag.length > 0)
      : [];

    // Extract optional internal date (quoted, after the flags parens)
    const argsAfterFlags = flagsMatch ? args.slice(args.indexOf(')') + 1) : args;
    const dateMatch = argsAfterFlags.match(/"([^"]+)"/);
    const internalDate = dateMatch ? dateMatch[1] : undefined;

    // Store metadata and switch to literal mode — completeLiteralAppend() finishes the job
    session.literalMeta = { tag, mailboxName, flags, internalDate };
    session.literalBuffer = Buffer.alloc(0);
    session.literalBytesRemaining = literalSize;
    session.dataMode = 'literal';

    // Only send continuation for synchronising literals (RFC 7888 / LITERAL+)
    if (isSynchronizingLiteral) {
      this.send(session.socket, '+ go ahead');
    }
  }

  // ---------------------------------------------------------------------------
  // CREATE / DELETE
  // ---------------------------------------------------------------------------

  private handleCreate(session: ImapSession, tag: string, args: string): void {
    if (session.state === 'not-authenticated') {
      this.send(session.socket, `${tag} NO Not authenticated`);
      return;
    }
    const mailboxName = args.trim().replace(/^"|"$/g, '');
    this.store.createMailbox(mailboxName);
    this.send(session.socket, `${tag} OK CREATE completed`);
  }

  private handleDelete(session: ImapSession, tag: string, args: string): void {
    if (session.state === 'not-authenticated') {
      this.send(session.socket, `${tag} NO Not authenticated`);
      return;
    }
    const mailboxName = args.trim().replace(/^"|"$/g, '');
    this.store.deleteMailbox(mailboxName);
    this.send(session.socket, `${tag} OK DELETE completed`);
  }

  // ---------------------------------------------------------------------------
  // EXPUNGE
  // ---------------------------------------------------------------------------

  private handleExpunge(session: ImapSession, tag: string): void {
    if (session.state !== 'selected' || !session.selectedMailbox) {
      this.send(session.socket, `${tag} NO No mailbox selected`);
      return;
    }
    if (session.readOnly) {
      this.send(session.socket, `${tag} NO [READ-ONLY] Mailbox is read-only`);
      return;
    }

    const mailboxName = session.selectedMailbox;
    // Capture the sequence numbers BEFORE expunge (they shift after each removal)
    const messagesBefore = this.store.getMessages(mailboxName);
    const deletedUids = this.store.expunge(mailboxName);

    // Send EXPUNGE responses in descending sequence-number order so that
    // the client's sequence numbers remain consistent as each is removed.
    const expungeSeqNums: number[] = [];
    for (const uid of deletedUids) {
      const seqNum = messagesBefore.findIndex((message) => message.uid === uid) + 1;
      if (seqNum > 0) {
        expungeSeqNums.push(seqNum);
      }
    }

    for (const seqNum of expungeSeqNums.sort((a, b) => b - a)) {
      this.send(session.socket, `* ${seqNum} EXPUNGE`);
    }

    this.send(session.socket, `${tag} OK EXPUNGE completed`);
  }

  // ---------------------------------------------------------------------------
  // SEARCH
  // ---------------------------------------------------------------------------

  private handleSearch(
    session: ImapSession,
    tag: string,
    args: string,
    uidMode: boolean,
  ): void {
    if (session.state !== 'selected' || !session.selectedMailbox) {
      this.send(session.socket, `${tag} NO No mailbox selected`);
      return;
    }

    const mailboxName = session.selectedMailbox;
    const messages = this.store.getMessages(mailboxName);

    const criteria = parseSearchCriteria(args.trim());
    const matchingMessages = applySearch(messages, criteria, this.store, mailboxName);

    const resultList = uidMode
      ? matchingMessages.map((message) => message.uid)
      : matchingMessages.map((message) => messages.indexOf(message) + 1);

    this.send(session.socket, `* SEARCH ${resultList.join(' ')}`);
    this.send(session.socket, `${tag} OK SEARCH completed`);
  }

  // ---------------------------------------------------------------------------
  // IDLE
  // ---------------------------------------------------------------------------

  private handleIdle(session: ImapSession, tag: string): void {
    if (session.state === 'not-authenticated') {
      this.send(session.socket, `${tag} NO Not authenticated`);
      return;
    }

    session.idleMode = true;
    session.idleTag = tag;
    this.send(session.socket, '+ idling');
  }

  // ---------------------------------------------------------------------------
  // UID sub-command router
  // ---------------------------------------------------------------------------

  private handleUid(session: ImapSession, tag: string, args: string): void {
    const firstSpaceIndex = args.indexOf(' ');
    const subCommand =
      firstSpaceIndex === -1 ? args.toUpperCase() : args.slice(0, firstSpaceIndex).toUpperCase();
    const subArgs = firstSpaceIndex === -1 ? '' : args.slice(firstSpaceIndex + 1);

    switch (subCommand) {
      case 'FETCH': {
        this.handleFetch(session, tag, subArgs, true);
        break;
      }
      case 'STORE': {
        this.handleStore(session, tag, subArgs, true);
        break;
      }
      case 'COPY': {
        this.handleCopy(session, tag, subArgs, true);
        break;
      }
      case 'MOVE': {
        this.handleMove(session, tag, subArgs, true);
        break;
      }
      case 'SEARCH': {
        this.handleSearch(session, tag, subArgs, true);
        break;
      }
      case 'EXPUNGE': {
        // UID EXPUNGE <uidset> — expunge specific UIDs (RFC 4315)
        if (!session.selectedMailbox) {
          this.send(session.socket, `${tag} NO No mailbox selected`);
          return;
        }
        if (session.readOnly) {
          this.send(session.socket, `${tag} NO [READ-ONLY] Mailbox is read-only`);
          return;
        }
        const mailboxName = session.selectedMailbox;
        const allMessages = this.store.getMessages(mailboxName);
        const targetMessages = this.resolveUidSet(allMessages, subArgs).filter(
          (message) => message.flags.has('\\Deleted'),
        );

        // Capture sequence numbers BEFORE removal for EXPUNGE notifications
        const messagesBefore = this.store.getMessages(mailboxName);

        // Remove only the targeted UIDs that have \Deleted (RFC 4315)
        const targetUids = targetMessages.map((message) => message.uid);
        this.store.expungeUids(mailboxName, targetUids);

        const expungeSeqNums: number[] = [];
        for (const uid of targetUids) {
          const seqNum = messagesBefore.findIndex((message) => message.uid === uid) + 1;
          if (seqNum > 0) {
            expungeSeqNums.push(seqNum);
          }
        }
        for (const seqNum of expungeSeqNums.sort((sequenceA, sequenceB) => sequenceB - sequenceA)) {
          this.send(session.socket, `* ${seqNum} EXPUNGE`);
        }

        this.send(session.socket, `${tag} OK UID EXPUNGE completed`);
        break;
      }
      default: {
        this.send(session.socket, `${tag} BAD Unknown UID sub-command: ${subCommand}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Sequence set resolution helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse the last mailbox argument from a COPY/MOVE args string.
   * Handles quoted mailbox names that contain spaces (e.g. "[Gmail]/Sent Mail").
   *
   * @param args - The full COPY/MOVE argument string, e.g. `1:* "[Gmail]/Sent Mail"`
   * @returns { sequenceSet, mailboxName } or null if parsing fails
   */
  private parseLastMailboxArg(
    args: string,
  ): { sequenceSet: string; mailboxName: string } | null {
    // Try to find a trailing quoted string: <sequenceSet> "<mailboxName>"
    const quotedMatch = args.match(/(.*?)\s+"([^"]+)"\s*$/);
    if (quotedMatch) {
      return {
        sequenceSet: (quotedMatch[1] ?? '').trim(),
        mailboxName: quotedMatch[2],
      };
    }

    // Fall back to splitting on the last space (unquoted names without spaces)
    const lastSpaceIndex = args.lastIndexOf(' ');
    if (lastSpaceIndex === -1) {
      return null;
    }
    return {
      sequenceSet: args.slice(0, lastSpaceIndex).trim(),
      mailboxName: args.slice(lastSpaceIndex + 1).trim(),
    };
  }

  /**
   * Filter messages by UID set string (e.g. "1,3:5,7:*").
   * Returns all messages whose UID appears in the set.
   * `*` resolves to the highest UID in the mailbox.
   */
  private resolveUidSet(messages: GmailMessage[], uidSet: string): GmailMessage[] {
    const highestUid = messages.length > 0 ? Math.max(...messages.map((message) => message.uid)) : 0;
    return messages.filter((message) =>
      this.isInSequenceSet(message.uid, uidSet, highestUid),
    );
  }

  /**
   * Filter messages by message sequence number set string.
   * Sequence numbers are 1-based positions in the sorted message array.
   */
  private resolveSeqSet(messages: GmailMessage[], seqSet: string): GmailMessage[] {
    return messages.filter((_message, index) =>
      this.isInSequenceSet(index + 1, seqSet, messages.length),
    );
  }

  /**
   * Check whether a number falls within an IMAP sequence set.
   *
   * @param num - The value to test (UID or sequence number)
   * @param seqSet - Comma-separated list of numbers and ranges (e.g. "1,3:5,7:*")
   * @param maxNum - Value substituted for '*'; null means '*' matches exactly num
   */
  private isInSequenceSet(
    num: number,
    seqSet: string,
    maxNum: number | null,
  ): boolean {
    const segments = seqSet.split(',');

    for (const segment of segments) {
      if (segment.includes(':')) {
        const colonIndex = segment.indexOf(':');
        const startStr = segment.slice(0, colonIndex);
        const endStr = segment.slice(colonIndex + 1);
        const start = parseInt(startStr, 10);
        const end = endStr === '*' ? (maxNum ?? num) : parseInt(endStr, 10);

        if (num >= start && num <= end) {
          return true;
        }
      } else if (segment === '*') {
        if (maxNum === null || num === maxNum) {
          return true;
        }
      } else {
        if (num === parseInt(segment, 10)) {
          return true;
        }
      }
    }

    return false;
  }
}
