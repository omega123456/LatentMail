/**
 * fixtures/index.ts — Typed fixture loader for backend tests.
 *
 * Resolves fixture paths relative to the repository root, regardless of
 * where the compiled output resides.
 *
 * At runtime the compiled file is at:
 *   dist-test/tests/backend/fixtures/index.js
 *
 * Going up 4 levels from __dirname reaches the repo root:
 *   dist-test/tests/backend/fixtures/ → dist-test/tests/backend/ → dist-test/tests/ → dist-test/ → (repo root)
 *
 * Fixture inventory
 * -----------------
 * messages/
 *   plain-text.eml          — simple text/plain message
 *   html-email.eml          — text/html-only message
 *   multipart-attachment.eml — multipart/mixed with text + two attachments
 *   inline-images.eml       — multipart/related with a CID-referenced inline image
 *   reply-thread-1.eml      — first message in a 3-message reply thread
 *   reply-thread-2.eml      — second message in the reply thread
 *   reply-thread-3.eml      — third message in the reply thread
 *
 * attachments/
 *   small.png               — 1×1 pixel PNG (binary)
 *   notes.txt               — plain text file
 *   small.bin               — minimal binary blob with magic bytes
 */

import * as fs from 'fs';
import * as path from 'path';

// Resolve repo root relative to the compiled output location
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ---------------------------------------------------------------------------
// Core loader primitives
// ---------------------------------------------------------------------------

/**
 * Load a fixture file and return its raw Buffer.
 *
 * @param relativePath - Path relative to tests/backend/fixtures/ (e.g. 'messages/plain-text.eml')
 * @returns Raw file contents as a Buffer
 */
export function loadFixture(relativePath: string): Buffer {
  const absolutePath = path.join(REPO_ROOT, 'tests', 'backend', 'fixtures', relativePath);
  return fs.readFileSync(absolutePath);
}

/**
 * Load a fixture file and return its contents as a string.
 *
 * @param relativePath - Path relative to tests/backend/fixtures/
 * @param encoding - Text encoding (default 'utf8')
 * @returns File contents as a string
 */
export function loadFixtureAsString(relativePath: string, encoding: BufferEncoding = 'utf8'): string {
  return loadFixture(relativePath).toString(encoding);
}

/**
 * Get the absolute filesystem path to a fixture file without reading it.
 * Useful when a service needs a file path (e.g. attachment downloads).
 *
 * @param relativePath - Path relative to tests/backend/fixtures/
 * @returns Absolute filesystem path
 */
export function getFixturePath(relativePath: string): string {
  return path.join(REPO_ROOT, 'tests', 'backend', 'fixtures', relativePath);
}

// ---------------------------------------------------------------------------
// Typed message fixtures
// ---------------------------------------------------------------------------

/**
 * The names of all available .eml message fixtures.
 * Using a union type prevents typos at call sites.
 */
export type MessageFixtureName =
  | 'plain-text'
  | 'html-email'
  | 'multipart-attachment'
  | 'inline-images'
  | 'reply-thread-1'
  | 'reply-thread-2'
  | 'reply-thread-3';

/**
 * Parsed header metadata extracted from a loaded .eml fixture.
 * These fields are present in every fixture message and are used by
 * test helpers to seed the database without re-parsing the raw bytes.
 */
export interface EmlHeaders {
  /** Value of the From: header (e.g. 'alice@example.com') */
  from: string;
  /** Value of the To: header */
  to: string;
  /** Value of the Subject: header */
  subject: string;
  /** Value of the Date: header (RFC 2822 string) */
  date: string;
  /** Value of the Message-ID: header (without angle brackets) */
  messageId: string;
  /** Optional In-Reply-To: header (without angle brackets), undefined if absent */
  inReplyTo: string | undefined;
  /** X-GM-MSGID custom header value */
  xGmMsgId: string;
  /** X-GM-THRID custom header value */
  xGmThrid: string;
}

/**
 * A loaded .eml fixture with both the raw bytes and the parsed header metadata.
 */
export interface LoadedEml {
  /** Raw RFC 5322 message bytes */
  raw: Buffer;
  /** Parsed header values — all fields guaranteed present */
  headers: EmlHeaders;
}

/**
 * Load and parse a named .eml message fixture.
 *
 * Reads the .eml file from tests/backend/fixtures/messages/<name>.eml and
 * extracts the typed headers so tests can seed the DB without re-parsing.
 *
 * @param name - One of the MessageFixtureName values
 * @returns LoadedEml with raw bytes and parsed headers
 */
export function loadEml(name: MessageFixtureName): LoadedEml {
  const raw = loadFixture(`messages/${name}.eml`);
  const text = raw.toString('utf8');
  const headers = parseEmlHeaders(text);
  return { raw, headers };
}

/**
 * Extract typed header values from raw RFC 5322 message text.
 * Only reads the headers section (up to the first blank line).
 * Handles simple (non-folded) header lines.
 *
 * @internal
 */
function parseEmlHeaders(text: string): EmlHeaders {
  // Split headers from body at first blank line
  const blankLineIndex = text.indexOf('\r\n\r\n') !== -1
    ? text.indexOf('\r\n\r\n')
    : text.indexOf('\n\n');
  const headerSection = blankLineIndex !== -1 ? text.slice(0, blankLineIndex) : text;

  // Unfold RFC 2822 header continuation lines (leading whitespace on next line)
  const unfolded = headerSection.replace(/\r?\n([ \t]+)/g, ' ');
  const lines = unfolded.split(/\r?\n/);

  const map = new Map<string, string>();
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }
    const fieldName = line.slice(0, colonIndex).trim().toLowerCase();
    const fieldValue = line.slice(colonIndex + 1).trim();
    if (!map.has(fieldName)) {
      map.set(fieldName, fieldValue);
    }
  }

  function require(field: string): string {
    const value = map.get(field);
    if (value === undefined) {
      throw new Error(`[loadEml] Required header field missing: "${field}"`);
    }
    return value;
  }

  // Strip angle brackets from Message-ID / In-Reply-To values
  function stripAngles(value: string): string {
    return value.replace(/^</, '').replace(/>$/, '').trim();
  }

  const inReplyToRaw = map.get('in-reply-to');

  return {
    from: require('from'),
    to: require('to'),
    subject: require('subject'),
    date: require('date'),
    messageId: stripAngles(require('message-id')),
    inReplyTo: inReplyToRaw !== undefined ? stripAngles(inReplyToRaw) : undefined,
    xGmMsgId: require('x-gm-msgid'),
    xGmThrid: require('x-gm-thrid'),
  };
}

// ---------------------------------------------------------------------------
// Typed attachment fixtures
// ---------------------------------------------------------------------------

/**
 * The names of all available binary attachment fixtures.
 */
export type AttachmentFixtureName = 'small.png' | 'notes.txt' | 'small.bin';

/**
 * Load a named attachment fixture as a raw Buffer.
 *
 * @param name - One of the AttachmentFixtureName values
 * @returns Raw file contents as a Buffer
 */
export function loadAttachment(name: AttachmentFixtureName): Buffer {
  return loadFixture(`attachments/${name}`);
}

/**
 * Get the absolute path to a named attachment fixture.
 * Useful when passing file paths to services that read files directly.
 *
 * @param name - One of the AttachmentFixtureName values
 * @returns Absolute filesystem path
 */
export function getAttachmentPath(name: AttachmentFixtureName): string {
  return getFixturePath(`attachments/${name}`);
}

// ---------------------------------------------------------------------------
// Convenience re-exports
// ---------------------------------------------------------------------------

/**
 * Pre-loaded registry of all .eml fixtures, keyed by fixture name.
 * Loaded lazily on first access to avoid startup overhead.
 *
 * Usage in tests:
 *   const { headers } = emlFixtures['plain-text'];
 */
export const emlFixtures: Readonly<Record<MessageFixtureName, LoadedEml>> = (() => {
  const names: MessageFixtureName[] = [
    'plain-text',
    'html-email',
    'multipart-attachment',
    'inline-images',
    'reply-thread-1',
    'reply-thread-2',
    'reply-thread-3',
  ];
  const result = {} as Record<MessageFixtureName, LoadedEml>;
  for (const name of names) {
    result[name] = loadEml(name);
  }
  return result;
})();
