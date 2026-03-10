/**
 * gmail-search.ts — Gmail IMAP SEARCH command emulation for the fake server.
 *
 * Provides a full SEARCH criteria parser and matcher that handles all
 * SEARCH patterns used by the production ImapService via imapflow:
 *
 *   - Standard flags: ALL, UNSEEN, SEEN, FLAGGED, UNFLAGGED, DELETED, UNDELETED, etc.
 *   - Date criteria: SINCE, BEFORE, ON, SENTSINCE, SENTBEFORE
 *   - Header criteria: FROM, TO, SUBJECT
 *   - Body criteria: BODY, TEXT
 *   - CONDSTORE: MODSEQ <n>
 *   - Gmail extensions: X-GM-MSGID, X-GM-THRID, X-GM-RAW
 *   - UID and sequence-set matching
 *   - Boolean operators: NOT, OR, implicit AND
 *
 * The Gmail X-GM-RAW query format used by production code (from search-query-generator.ts):
 *   from:, to:, subject:, in:, label:, is:read/unread/starred,
 *   has:attachment, after:, before:, newer_than:, older_than:,
 *   "phrase search", -negated keyword, plain keywords
 */

import { GmailMessage, MessageStore } from './message-store';
import { DateTime } from 'luxon';

/**
 * Parsed search criteria tree for IMAP SEARCH command.
 */
export interface SearchCriteria {
  type:
    | 'all'
    | 'uid'
    | 'seqset'
    | 'flag'
    | 'header'
    | 'body'
    | 'size'
    | 'date'
    | 'modseq'
    | 'gmMsgId'
    | 'gmThrid'
    | 'gmRaw'
    | 'not'
    | 'or'
    | 'and';
  value?: string | number;
  children?: SearchCriteria[];
  flagName?: string;
  /** true = has flag, false = does not have flag */
  flagSet?: boolean;
  headerName?: string;
  comparison?: 'before' | 'after' | 'on';
  dateType?: 'internal' | 'sent';
}

/**
 * Parse an IMAP SEARCH command argument string into a criteria tree.
 * Handles the subset of IMAP SEARCH criteria used by imapflow.
 */
export function parseSearchCriteria(args: string): SearchCriteria {
  const tokens = tokenize(args);
  const criteria = parseCriteriaList(tokens);
  if (criteria.length === 1) {
    return criteria[0];
  }
  return { type: 'and', children: criteria };
}

/**
 * Apply a search criteria tree to a list of messages.
 * Returns the subset of messages that match.
 */
export function applySearch(
  messages: GmailMessage[],
  criteria: SearchCriteria,
  store: MessageStore,
  mailboxName: string,
): GmailMessage[] {
  return messages.filter((message) =>
    matchesCriteria(message, criteria, store, mailboxName, messages),
  );
}

/**
 * Parse an X-GM-RAW query string into search criteria.
 * Handles the Gmail search operators emitted by search-query-generator.ts.
 */
export function parseGmailRawQuery(query: string): SearchCriteria {
  const criteria: SearchCriteria[] = [];

  const parts = tokenizeGmailQuery(query);

  for (const part of parts) {
    if (part.startsWith('from:')) {
      criteria.push({
        type: 'header',
        headerName: 'from',
        value: part.slice(5).replace(/^"|"$/g, ''),
      });
    } else if (part.startsWith('to:')) {
      criteria.push({
        type: 'header',
        headerName: 'to',
        value: part.slice(3).replace(/^"|"$/g, ''),
      });
    } else if (part.startsWith('subject:')) {
      criteria.push({
        type: 'header',
        headerName: 'subject',
        value: part.slice(8).replace(/^"|"$/g, ''),
      });
    } else if (part.startsWith('in:inbox')) {
      criteria.push({ type: 'gmRaw', value: 'in:inbox' });
    } else if (part.startsWith('in:') || part.startsWith('label:')) {
      const label = part.includes(':') ? part.split(':')[1] : '';
      criteria.push({ type: 'gmRaw', value: `label:${label}` });
    } else if (part === 'is:read') {
      criteria.push({ type: 'flag', flagName: '\\Seen', flagSet: true });
    } else if (part === 'is:unread') {
      criteria.push({ type: 'flag', flagName: '\\Seen', flagSet: false });
    } else if (part === 'is:starred') {
      criteria.push({ type: 'flag', flagName: '\\Flagged', flagSet: true });
    } else if (part === 'has:attachment') {
      criteria.push({ type: 'gmRaw', value: 'has:attachment' });
    } else if (part.startsWith('after:') || part.startsWith('newer_than:')) {
      const dateStr = part.split(':')[1] ?? '';
      criteria.push({
        type: 'date',
        comparison: 'after',
        value: dateStr,
        dateType: 'internal',
      });
    } else if (part.startsWith('before:') || part.startsWith('older_than:')) {
      const dateStr = part.split(':')[1] ?? '';
      criteria.push({
        type: 'date',
        comparison: 'before',
        value: dateStr,
        dateType: 'internal',
      });
    } else if (part.startsWith('-')) {
      // Negation
      const inner = part.slice(1);
      criteria.push({ type: 'not', children: [{ type: 'body', value: inner }] });
    } else if (part.startsWith('"') && part.endsWith('"')) {
      // Phrase search
      criteria.push({ type: 'body', value: part.replace(/^"|"$/g, '') });
    } else if (part.length > 0) {
      // Plain keyword
      criteria.push({ type: 'body', value: part });
    }
  }

  if (criteria.length === 0) {
    return { type: 'all' };
  }
  if (criteria.length === 1) {
    return criteria[0];
  }
  return { type: 'and', children: criteria };
}

// ---------------------------------------------------------------------------
// Internal — criteria matching
// ---------------------------------------------------------------------------

function matchesCriteria(
  message: GmailMessage,
  criteria: SearchCriteria,
  store: MessageStore,
  mailboxName: string,
  allMessages: GmailMessage[],
): boolean {
  switch (criteria.type) {
    case 'all': {
      return true;
    }
    case 'uid': {
      const maxUid = allMessages.length > 0
        ? Math.max(...allMessages.map((message) => message.uid))
        : 0;
      return matchesSequenceSet(message.uid, String(criteria.value), maxUid);
    }
    case 'seqset': {
      const seqNum = allMessages.indexOf(message) + 1;
      return matchesSequenceSet(seqNum, String(criteria.value), allMessages.length);
    }
    case 'flag': {
      if (!criteria.flagName) {
        return false;
      }
      const hasFlag = message.flags.has(criteria.flagName);
      return criteria.flagSet ? hasFlag : !hasFlag;
    }
    case 'header': {
      const headerValue = extractHeader(message.rfc822, criteria.headerName ?? '').toLowerCase();
      return headerValue.includes(String(criteria.value).toLowerCase());
    }
    case 'body': {
      const bodyText = message.rfc822.toString('utf8').toLowerCase();
      return bodyText.includes(String(criteria.value).toLowerCase());
    }
    case 'size': {
      // LARGER/SMALLER — size filtering is not implemented; permissive match
      return true;
    }
    case 'date': {
      return matchesDate(message, criteria);
    }
    case 'modseq': {
      return message.modseq >= Number(criteria.value);
    }
    case 'gmMsgId': {
      return message.xGmMsgId === String(criteria.value);
    }
    case 'gmThrid': {
      return message.xGmThrid === String(criteria.value);
    }
    case 'gmRaw': {
      const rawQuery = String(criteria.value);
      const subCriteria = parseGmailRawQuery(rawQuery);
      // If parseGmailRawQuery returned the same gmRaw criterion unchanged
      // (i.e., it's an atomic operator that cannot be expanded further),
      // fall back to matchesGmRaw() directly to avoid infinite recursion.
      if (subCriteria.type === 'gmRaw' && subCriteria.value === rawQuery) {
        return matchesGmRaw(message, rawQuery.toLowerCase());
      }
      return matchesCriteria(message, subCriteria, store, mailboxName, allMessages);
    }
    case 'not': {
      if (!criteria.children || criteria.children.length === 0) {
        return true;
      }
      return !matchesCriteria(
        message,
        criteria.children[0],
        store,
        mailboxName,
        allMessages,
      );
    }
    case 'or': {
      if (!criteria.children || criteria.children.length < 2) {
        return true;
      }
      return (
        matchesCriteria(message, criteria.children[0], store, mailboxName, allMessages) ||
        matchesCriteria(message, criteria.children[1], store, mailboxName, allMessages)
      );
    }
    case 'and': {
      if (!criteria.children) {
        return true;
      }
      return criteria.children.every((child) =>
        matchesCriteria(message, child, store, mailboxName, allMessages),
      );
    }
    default: {
      // Unknown criteria type — permissive match
      return true;
    }
  }
}

/**
 * Match a message against a Gmail raw query operator value.
 * The rawValue parameter must already be lowercased.
 */
function matchesGmRaw(message: GmailMessage, rawValue: string): boolean {
  if (rawValue === 'has:attachment') {
    const bodyStr = message.rfc822.toString('utf8').toLowerCase();
    return bodyStr.includes('content-disposition: attachment');
  }
  if (rawValue.startsWith('label:')) {
    const labelName = rawValue.slice(6).toLowerCase();
    return message.xGmLabels.some((label) => label.toLowerCase().includes(labelName));
  }
  if (rawValue === 'in:inbox') {
    return message.xGmLabels.some(
      (label) => label === '\\Inbox' || label.toLowerCase() === 'inbox',
    );
  }
  // Unknown GM-RAW operator — permissive match
  return true;
}

function matchesDate(message: GmailMessage, criteria: SearchCriteria): boolean {
  // For SENTSINCE / SENTBEFORE, try to extract the RFC 822 Date: header and
  // compare against that. Fall back to internalDate if the header is missing
  // or cannot be parsed.
  let dateToCompare: DateTime;
  if (criteria.dateType === 'sent') {
    const dateHeaderValue = extractHeader(message.rfc822, 'date');
    if (dateHeaderValue.length > 0) {
      const parsedSentDate =
        DateTime.fromRFC2822(dateHeaderValue).isValid
          ? DateTime.fromRFC2822(dateHeaderValue)
          : DateTime.fromHTTP(dateHeaderValue);
      dateToCompare = parsedSentDate.isValid
        ? parsedSentDate
        : DateTime.fromISO(message.internalDate);
    } else {
      dateToCompare = DateTime.fromISO(message.internalDate);
    }
  } else {
    dateToCompare = DateTime.fromISO(message.internalDate);
  }

  const valueStr = String(criteria.value);

  // Handle relative dates like "7d" (newer_than / older_than)
  if (valueStr.endsWith('d')) {
    const days = parseInt(valueStr, 10);
    const threshold = DateTime.now().minus({ days });
    if (criteria.comparison === 'after') {
      return dateToCompare >= threshold;
    }
    if (criteria.comparison === 'before') {
      return dateToCompare <= threshold;
    }
    return true;
  }

  // Handle absolute dates in various formats
  let threshold: DateTime;
  if (valueStr.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
    threshold = DateTime.fromFormat(valueStr, 'yyyy/MM/dd');
  } else if (valueStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
    threshold = DateTime.fromISO(valueStr);
  } else {
    // IMAP date format: 12-Jan-2024
    threshold = DateTime.fromFormat(valueStr, 'dd-MMM-yyyy');
  }

  if (!threshold.isValid) {
    // Unparseable date — permissive match
    return true;
  }

  if (criteria.comparison === 'after') {
    return dateToCompare >= threshold;
  }
  if (criteria.comparison === 'before') {
    return dateToCompare < threshold;
  }
  if (criteria.comparison === 'on') {
    return dateToCompare.toISODate() === threshold.toISODate();
  }
  return true;
}

function extractHeader(rfc822: Buffer, headerName: string): string {
  const text = rfc822.toString('utf8');
  const headerSection = text.split('\r\n\r\n')[0] ?? text.split('\n\n')[0] ?? '';
  const lowerName = headerName.toLowerCase();

  for (const line of headerSection.split(/\r?\n/)) {
    const colonIndex = line.indexOf(': ');
    if (colonIndex > 0 && line.slice(0, colonIndex).toLowerCase() === lowerName) {
      return line.slice(colonIndex + 2);
    }
  }
  return '';
}

function matchesSequenceSet(
  num: number,
  seqSet: string,
  maxNum: number | null,
): boolean {
  const parts = seqSet.split(',');
  for (const part of parts) {
    if (part.includes(':')) {
      const colonIndex = part.indexOf(':');
      const startStr = part.slice(0, colonIndex);
      const endStr = part.slice(colonIndex + 1);
      const start = parseInt(startStr, 10);
      const end = endStr === '*' ? (maxNum ?? num) : parseInt(endStr, 10);
      if (num >= start && num <= end) {
        return true;
      }
    } else if (part === '*') {
      if (maxNum === null || num === maxNum) {
        return true;
      }
    } else {
      if (num === parseInt(part, 10)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal — tokenizers
// ---------------------------------------------------------------------------

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let inParens = 0;

  for (let charIndex = 0; charIndex < input.length; charIndex++) {
    const char = input[charIndex];
    if (char === '"' && inParens === 0) {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === '(' && !inQuotes) {
      inParens++;
      current += char;
    } else if (char === ')' && !inQuotes) {
      inParens--;
      current += char;
      if (inParens === 0) {
        tokens.push(current.trim());
        current = '';
      }
    } else if (char === ' ' && !inQuotes && inParens === 0) {
      if (current.trim()) {
        tokens.push(current.trim());
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    tokens.push(current.trim());
  }
  return tokens;
}

function parseCriteriaList(tokens: string[]): SearchCriteria[] {
  const criteria: SearchCriteria[] = [];
  let tokenIndex = 0;

  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex].toUpperCase();

    if (token === 'ALL') {
      criteria.push({ type: 'all' });
      tokenIndex++;
    } else if (token === 'UID') {
      tokenIndex++;
      const uidSet = tokens[tokenIndex] ?? '';
      criteria.push({ type: 'uid', value: uidSet });
      tokenIndex++;
    } else if (token === 'UNSEEN') {
      criteria.push({ type: 'flag', flagName: '\\Seen', flagSet: false });
      tokenIndex++;
    } else if (token === 'SEEN') {
      criteria.push({ type: 'flag', flagName: '\\Seen', flagSet: true });
      tokenIndex++;
    } else if (token === 'FLAGGED') {
      criteria.push({ type: 'flag', flagName: '\\Flagged', flagSet: true });
      tokenIndex++;
    } else if (token === 'UNFLAGGED') {
      criteria.push({ type: 'flag', flagName: '\\Flagged', flagSet: false });
      tokenIndex++;
    } else if (token === 'DELETED') {
      criteria.push({ type: 'flag', flagName: '\\Deleted', flagSet: true });
      tokenIndex++;
    } else if (token === 'UNDELETED') {
      criteria.push({ type: 'flag', flagName: '\\Deleted', flagSet: false });
      tokenIndex++;
    } else if (token === 'ANSWERED') {
      criteria.push({ type: 'flag', flagName: '\\Answered', flagSet: true });
      tokenIndex++;
    } else if (token === 'DRAFT') {
      criteria.push({ type: 'flag', flagName: '\\Draft', flagSet: true });
      tokenIndex++;
    } else if (token === 'X-GM-MSGID') {
      tokenIndex++;
      const msgId = tokens[tokenIndex] ?? '';
      criteria.push({ type: 'gmMsgId', value: msgId });
      tokenIndex++;
    } else if (token === 'X-GM-THRID') {
      tokenIndex++;
      const thrid = tokens[tokenIndex] ?? '';
      criteria.push({ type: 'gmThrid', value: thrid });
      tokenIndex++;
    } else if (token === 'X-GM-RAW') {
      tokenIndex++;
      const rawQuery = (tokens[tokenIndex] ?? '').replace(/^"|"$/g, '');
      criteria.push({ type: 'gmRaw', value: rawQuery });
      tokenIndex++;
    } else if (token === 'MODSEQ') {
      tokenIndex++;
      const modseq = parseInt(tokens[tokenIndex] ?? '0', 10);
      criteria.push({ type: 'modseq', value: modseq });
      tokenIndex++;
    } else if (token === 'SINCE') {
      tokenIndex++;
      criteria.push({
        type: 'date',
        comparison: 'after',
        value: tokens[tokenIndex] ?? '',
        dateType: 'internal',
      });
      tokenIndex++;
    } else if (token === 'BEFORE') {
      tokenIndex++;
      criteria.push({
        type: 'date',
        comparison: 'before',
        value: tokens[tokenIndex] ?? '',
        dateType: 'internal',
      });
      tokenIndex++;
    } else if (token === 'ON') {
      tokenIndex++;
      criteria.push({
        type: 'date',
        comparison: 'on',
        value: tokens[tokenIndex] ?? '',
        dateType: 'internal',
      });
      tokenIndex++;
    } else if (token === 'SENTSINCE') {
      tokenIndex++;
      criteria.push({
        type: 'date',
        comparison: 'after',
        value: tokens[tokenIndex] ?? '',
        dateType: 'sent',
      });
      tokenIndex++;
    } else if (token === 'SENTBEFORE') {
      tokenIndex++;
      criteria.push({
        type: 'date',
        comparison: 'before',
        value: tokens[tokenIndex] ?? '',
        dateType: 'sent',
      });
      tokenIndex++;
    } else if (token === 'FROM') {
      tokenIndex++;
      criteria.push({
        type: 'header',
        headerName: 'from',
        value: (tokens[tokenIndex] ?? '').replace(/^"|"$/g, ''),
      });
      tokenIndex++;
    } else if (token === 'TO') {
      tokenIndex++;
      criteria.push({
        type: 'header',
        headerName: 'to',
        value: (tokens[tokenIndex] ?? '').replace(/^"|"$/g, ''),
      });
      tokenIndex++;
    } else if (token === 'SUBJECT') {
      tokenIndex++;
      criteria.push({
        type: 'header',
        headerName: 'subject',
        value: (tokens[tokenIndex] ?? '').replace(/^"|"$/g, ''),
      });
      tokenIndex++;
    } else if (token === 'BODY') {
      tokenIndex++;
      criteria.push({
        type: 'body',
        value: (tokens[tokenIndex] ?? '').replace(/^"|"$/g, ''),
      });
      tokenIndex++;
    } else if (token === 'TEXT') {
      tokenIndex++;
      criteria.push({
        type: 'body',
        value: (tokens[tokenIndex] ?? '').replace(/^"|"$/g, ''),
      });
      tokenIndex++;
    } else if (token === 'LARGER') {
      // Skip size value — not filtering by size in mock
      tokenIndex++;
      tokenIndex++;
    } else if (token === 'SMALLER') {
      // Skip size value — not filtering by size in mock
      tokenIndex++;
      tokenIndex++;
    } else if (token === 'NOT') {
      tokenIndex++;
      const notResult = parseOneCriteria(tokens, tokenIndex);
      criteria.push({ type: 'not', children: [notResult.criteria] });
      tokenIndex = notResult.nextIndex;
    } else if (token === 'OR') {
      tokenIndex++;
      const leftResult = parseOneCriteria(tokens, tokenIndex);
      const rightResult = parseOneCriteria(tokens, leftResult.nextIndex);
      criteria.push({
        type: 'or',
        children: [leftResult.criteria, rightResult.criteria],
      });
      tokenIndex = rightResult.nextIndex;
    } else if (/^\d/.test(token) || token.includes(':') || token.includes(',')) {
      // Sequence set (e.g. "1:5" or "1,3,5")
      criteria.push({ type: 'seqset', value: token });
      tokenIndex++;
    } else {
      // Unknown token — skip
      tokenIndex++;
    }
  }

  return criteria.length > 0 ? criteria : [{ type: 'all' }];
}

/**
 * Consume exactly ONE complete criteria item (keyword + its arguments) from
 * the token stream, starting at startIndex. Returns the parsed criteria and
 * the index of the next unconsumed token.
 *
 * This is necessary because NOT and OR need to consume compound criteria
 * (e.g. NOT SUBJECT "hello" requires two tokens for SUBJECT), not just
 * single tokens.
 */
function parseOneCriteria(
  tokens: string[],
  startIndex: number,
): { criteria: SearchCriteria; nextIndex: number } {
  const token = (tokens[startIndex] ?? '').toUpperCase();

  // Keywords that consume the next token as their value
  const twoTokenKeywords = [
    'UID', 'FROM', 'TO', 'SUBJECT', 'BODY', 'TEXT',
    'X-GM-MSGID', 'X-GM-THRID', 'X-GM-RAW', 'MODSEQ',
    'SINCE', 'BEFORE', 'ON', 'SENTSINCE', 'SENTBEFORE',
    'LARGER', 'SMALLER',
  ];

  if (twoTokenKeywords.includes(token)) {
    const parsed = parseCriteriaList(tokens.slice(startIndex, startIndex + 2));
    return { criteria: parsed[0] ?? { type: 'all' }, nextIndex: startIndex + 2 };
  }

  // Recursive boolean: NOT <criterion>
  if (token === 'NOT') {
    const inner = parseOneCriteria(tokens, startIndex + 1);
    return {
      criteria: { type: 'not', children: [inner.criteria] },
      nextIndex: inner.nextIndex,
    };
  }

  // Recursive boolean: OR <criterion> <criterion>
  if (token === 'OR') {
    const leftResult = parseOneCriteria(tokens, startIndex + 1);
    const rightResult = parseOneCriteria(tokens, leftResult.nextIndex);
    return {
      criteria: { type: 'or', children: [leftResult.criteria, rightResult.criteria] },
      nextIndex: rightResult.nextIndex,
    };
  }

  // Single-token criteria (flags, ALL, sequence sets, etc.)
  const parsed = parseCriteriaList(tokens.slice(startIndex, startIndex + 1));
  return { criteria: parsed[0] ?? { type: 'all' }, nextIndex: startIndex + 1 };
}

function tokenizeGmailQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of query) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === ' ' && !inQuotes) {
      if (current.trim()) {
        tokens.push(current.trim());
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    tokens.push(current.trim());
  }
  return tokens;
}
