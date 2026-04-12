/**
 * Shared interfaces and Gmail X-GM-RAW query translator for the semantic
 * search LLM intent + filter pipeline.
 *
 * `SemanticSearchFilters` holds the structured filter fields extracted by the
 * LLM from a natural-language search query. `translateFiltersToGmailQuery`
 * converts those fields into a Gmail X-GM-RAW query string that can be passed
 * directly to IMAP.
 *
 * Date handling note: the LLM is responsible for adjusting dates by ±1 day to
 * account for Gmail's exclusive `after:` / `before:` semantics. This translator
 * converts the ISO dash-format dates to Gmail's slash-format as-is — no further
 * date arithmetic is performed here.
 */

import { DateTime } from 'luxon';

/**
 * Structured filter fields extracted from a natural-language search query by
 * the LLM intent-extraction step.
 *
 * All fields are optional. When a field is `undefined` the translator treats it
 * as "no constraint" for that dimension.
 */
export interface SemanticSearchFilters {
  /** ISO date string "YYYY-MM-DD". Pre-adjusted by LLM for Gmail's exclusive after: operator. */
  dateFrom?: string;
  /** ISO date string "YYYY-MM-DD". Pre-adjusted by LLM for Gmail's exclusive before: operator. */
  dateTo?: string;
  /** Exact folder name from the user's folder list. */
  folder?: string;
  /** Email address or display name of the sender. */
  sender?: string;
  /** Email address or display name of the recipient. */
  recipient?: string;
  /** Whether the email must have (true) or must not have (false) an attachment. */
  hasAttachment?: boolean;
  /** Whether the email must be read (true) or unread (false). */
  isRead?: boolean;
  /** Whether the email must be starred (true) or unstarred (false). */
  isStarred?: boolean;
}

/**
 * The complete structured output produced by the LLM intent-extraction step.
 *
 * `semanticQuery` contains only the topic/content terms (no filter qualifiers),
 * suitable for embedding-based similarity search. `filters` contains all
 * structured constraints that should be applied via Gmail X-GM-RAW.
 */
export interface SemanticSearchIntent {
  /** Topic-only query string with no filter qualifiers. Used for embedding search. */
  semanticQuery: string;
  /** Structured filter constraints extracted from the natural-language query. */
  filters: SemanticSearchFilters;
}

/**
 * Pattern matching any Gmail search operator keyword followed by a colon.
 * Used to detect injection attempts in user-supplied filter values.
 */
const BLOCKED_OPERATOR_PATTERN = /\b(?:from|to|subject|in|is|has|after|before|newer_than|older_than|label)\s*:/i;

/**
 * Sanitizes a folder name for safe inclusion inside a quoted `in:"..."` Gmail
 * operator.
 *
 * Strips double-quotes (which would break the surrounding quotes) and
 * backslashes (which could escape the closing quote). Also collapses
 * runs of whitespace.
 *
 * Returns `null` if the result is empty after stripping.
 */
function sanitizeFolderValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = trimmed
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return null;
  }
  return cleaned;
}

/**
 * Sanitizes an address-like value (email address or display name) for safe
 * inclusion inside a quoted `from:"..."` or `to:"..."` Gmail operator.
 *
 * Follows the same pattern as `sanitizeAddressValue` in
 * `search-query-generator.ts`:
 * - Returns `null` if the value contains Gmail operator keywords (injection
 *   guard).
 * - Strips parentheses and double-quotes.
 * - Collapses runs of whitespace.
 *
 * Returns `null` if the result is empty after stripping.
 */
function sanitizeAddressValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (BLOCKED_OPERATOR_PATTERN.test(trimmed)) {
    return null;
  }
  const cleaned = trimmed
    .replace(/["()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return null;
  }
  return cleaned;
}

/**
 * Converts an ISO "YYYY-MM-DD" date string to Gmail's "YYYY/MM/DD" slash
 * format required by the `after:` and `before:` operators.
 *
 * Returns `null` if the value is empty or not a valid ISO date string.
 */
function convertDateToGmailFormat(isoDate: string): string | null {
  const trimmed = isoDate.trim();
  if (!trimmed) {
    return null;
  }
  const converted = trimmed.replace(/-/g, '/');
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(converted)) {
    return null;
  }
  return converted;
}

/**
 * Converts a `SemanticSearchFilters` object to a Gmail X-GM-RAW query string.
 *
 * Each defined filter field is translated to the corresponding Gmail search
 * operator token:
 *
 * - `dateFrom`      → `after:YYYY/MM/DD`
 * - `dateTo`        → `before:YYYY/MM/DD`
 * - `folder`        → `in:"<folder>"`
 * - `sender`        → `from:"<sender>"`
 * - `recipient`     → `to:"<recipient>"`
 * - `hasAttachment` → `has:attachment` / `-has:attachment`
 * - `isRead`        → `is:read` / `is:unread`
 * - `isStarred`     → `is:starred` / `-is:starred`
 *
 * All string values are sanitized to prevent Gmail operator injection. If a
 * string value sanitizes to `null` (empty or contains blocked operators) the
 * corresponding token is omitted.
 *
 * Returns an empty string when `filters` contains no defined fields or every
 * field sanitizes to nothing.
 */
export function translateFiltersToGmailQuery(filters: SemanticSearchFilters): string {
  const parts: string[] = [];

  if (filters.dateFrom !== undefined) {
    const gmailDate = convertDateToGmailFormat(filters.dateFrom);
    if (gmailDate !== null) {
      parts.push(`after:${gmailDate}`);
    }
  }

  if (filters.dateTo !== undefined) {
    const gmailDate = convertDateToGmailFormat(filters.dateTo);
    if (gmailDate !== null) {
      parts.push(`before:${gmailDate}`);
    }
  }

  if (filters.folder !== undefined) {
    const sanitizedFolder = sanitizeFolderValue(filters.folder);
    if (sanitizedFolder !== null) {
      parts.push(`in:"${sanitizedFolder}"`);
    }
  }

  if (filters.sender !== undefined) {
    const sanitizedSender = sanitizeAddressValue(filters.sender);
    if (sanitizedSender !== null) {
      parts.push(`from:"${sanitizedSender}"`);
    }
  }

  if (filters.recipient !== undefined) {
    const sanitizedRecipient = sanitizeAddressValue(filters.recipient);
    if (sanitizedRecipient !== null) {
      parts.push(`to:"${sanitizedRecipient}"`);
    }
  }

  if (filters.hasAttachment === true) {
    parts.push('has:attachment');
  } else if (filters.hasAttachment === false) {
    parts.push('-has:attachment');
  }

  if (filters.isRead === true) {
    parts.push('is:read');
  } else if (filters.isRead === false) {
    parts.push('is:unread');
  }

  if (filters.isStarred === true) {
    parts.push('is:starred');
  } else if (filters.isStarred === false) {
    parts.push('-is:starred');
  }

  return parts.join(' ');
}

/**
 * Returns `true` if any field in `filters` has a defined (non-`undefined`)
 * value, `false` if the object is empty or all fields are `undefined`.
 *
 * This is used to short-circuit the Gmail X-GM-RAW query path when the LLM
 * did not extract any structured filters from the query.
 */
export function hasFilters(filters: SemanticSearchFilters): boolean {
  return (
    filters.dateFrom !== undefined ||
    filters.dateTo !== undefined ||
    filters.folder !== undefined ||
    filters.sender !== undefined ||
    filters.recipient !== undefined ||
    filters.hasAttachment !== undefined ||
    filters.isRead !== undefined ||
    filters.isStarred !== undefined
  );
}

/**
 * Normalizes local calendar date strings ("YYYY-MM-DD") in a
 * SemanticSearchFilters object to UTC ISO timestamp bounds suitable for
 * direct comparison against the `emails.date` column (which stores full
 * ISO 8601 timestamps in UTC).
 *
 * - `dateFrom` ("YYYY-MM-DD") → start of that local calendar day in UTC
 * - `dateTo`   ("YYYY-MM-DD") → start of the NEXT local calendar day in UTC
 *   (exclusive upper bound)
 *
 * Other filter fields are passed through unchanged. Operates on a COPY of
 * the input — does NOT mutate the original.
 *
 * If a date string is already a full ISO timestamp (contains 'T'), it is
 * left unchanged — normalization applies only to bare YYYY-MM-DD strings.
 *
 * Invalid date strings are silently dropped (the corresponding field is
 * removed from the returned copy).
 */
export function normalizeFilterDatesForDb(filters: SemanticSearchFilters): SemanticSearchFilters {
  const normalized: SemanticSearchFilters = { ...filters };

  if (filters.dateFrom !== undefined && !filters.dateFrom.includes('T')) {
    const localDate = DateTime.fromFormat(filters.dateFrom, 'yyyy-MM-dd', { zone: 'local' });
    if (localDate.isValid) {
      normalized.dateFrom = localDate.toUTC().toISO() ?? filters.dateFrom;
    } else {
      delete normalized.dateFrom;
    }
  }

  if (filters.dateTo !== undefined && !filters.dateTo.includes('T')) {
    const localDate = DateTime.fromFormat(filters.dateTo, 'yyyy-MM-dd', { zone: 'local' });
    if (localDate.isValid) {
      normalized.dateTo = localDate.plus({ days: 1 }).toUTC().toISO() ?? filters.dateTo;
    } else {
      delete normalized.dateTo;
    }
  }

  return normalized;
}
