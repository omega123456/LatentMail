/**
 * Gmail Query Parser
 *
 * Parses a Gmail-style search query string into SQL WHERE conditions
 * with named placeholders for use by DatabaseService.searchEmails().
 *
 * Supported operators:
 *   from:, to:, subject:, body:, in:, label:, is:unread, is:read, is:starred,
 *   has:attachment, after:, before:, newer_than:, older_than:,
 *   negation (-), exact phrases ("")
 *
 * Unknown operators and plain keywords are treated as LIKE searches
 * across subject, from_address, from_name, to_addresses, and text_body.
 *
 * Does NOT support OR, () grouping at the SQL level.
 */

import { DateTime } from 'luxon';

interface ParsedQuery {
  whereClause: string;
  params: Record<string, unknown>;
}

interface ParseGmailQueryOptions {
  accountId?: number;
  paramPrefix?: string;
  /**
   * Optional callback to resolve the trash folder path for the current account.
   * Called when the parser encounters the 'trash' folder alias.
   * Must NOT import DatabaseService — callers inject the resolution logic to avoid circular deps.
   * Falls back to '[Gmail]/Trash' when not provided.
   */
  trashFolderResolver?: (accountId?: number) => string;
}

const FOLDER_ALIAS_MAP: Record<string, string | null> = {
  inbox: 'INBOX',
  sent: '[Gmail]/Sent Mail',
  drafts: '[Gmail]/Drafts',
  spam: '[Gmail]/Spam',
  starred: '[Gmail]/Starred',
  important: '[Gmail]/Important',
  all: null,
  allmail: null,
  'all-mail': null,
};

/** Escape SQL LIKE wildcard characters in user-provided values. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Convert Gmail date (YYYY/MM/DD) to ISO date string (YYYY-MM-DD). */
function gmailDateToIso(dateStr: string): string | null {
  const normalized = dateStr.replace(/\//g, '-');
  const dt = DateTime.fromFormat(normalized, 'yyyy-M-d');
  return dt.isValid ? dt.toISODate() : null;
}

/**
 * Parse a relative time value like "7d", "3m", "1y" into a Date object
 * relative to the current UTC date.
 */
function parseRelativeTime(value: string): string | null {
  const match = value.match(/^(\d+)([dmy])$/i);
  if (!match) {
    return null;
  }
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'd': {
      return DateTime.utc().minus({ days: amount }).toISO();
    }
    case 'm': {
      return DateTime.utc().minus({ months: amount }).toISO();
    }
    case 'y': {
      return DateTime.utc().minus({ years: amount }).toISO();
    }
    default: {
      return null;
    }
  }
}

function normalizeParamPrefix(rawPrefix: string | undefined): string {
  const sanitized = (rawPrefix || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!sanitized) {
    return 'sqp';
  }
  return `sqp_${sanitized}`;
}

function resolveFolderAlias(value: string, options?: ParseGmailQueryOptions): string | null | undefined {
  const normalized = value.trim().toLowerCase();
  // 'trash' is resolved dynamically via an optional resolver callback to avoid circular dependencies
  // (database-service requires this file at runtime; this file must NOT import database-service).
  if (normalized === 'trash') {
    if (options?.trashFolderResolver) {
      return options.trashFolderResolver(options.accountId);
    }
    return '[Gmail]/Trash';
  }
  if (Object.prototype.hasOwnProperty.call(FOLDER_ALIAS_MAP, normalized)) {
    return FOLDER_ALIAS_MAP[normalized];
  }
  return undefined;
}

interface Token {
  negated: boolean;
  operator: string | null;
  value: string;
}

/**
 * Tokenize a Gmail search query into operator/keyword tokens.
 * Handles quoted phrases, negation prefix (-), and operator:value pairs.
 */
function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = query.length;

  while (i < len) {
    while (i < len && /\s/.test(query[i])) {
      i++;
    }
    if (i >= len) {
      break;
    }

    let negated = false;
    if (query[i] === '-' && i + 1 < len && !/\s/.test(query[i + 1])) {
      negated = true;
      i++;
    }

    if (query[i] === '"') {
      const closeQuote = query.indexOf('"', i + 1);
      if (closeQuote !== -1) {
        const phrase = query.substring(i + 1, closeQuote);
        tokens.push({ negated, operator: null, value: phrase });
        i = closeQuote + 1;
        continue;
      }
      const rest = query.substring(i + 1).trim();
      if (rest) {
        tokens.push({ negated, operator: null, value: rest });
      }
      break;
    }

    let word = '';
    while (i < len && !/\s/.test(query[i])) {
      word += query[i];
      i++;
    }

    if (!word) {
      continue;
    }

    const colonIdx = word.indexOf(':');
    if (colonIdx > 0 && colonIdx < word.length - 1) {
      const op = word.substring(0, colonIdx).toLowerCase();
      let val = word.substring(colonIdx + 1);

      if (val.startsWith('"')) {
        val = val.substring(1);
        if (val.endsWith('"')) {
          val = val.substring(0, val.length - 1);
        } else {
          const closeQuote = query.indexOf('"', i);
          if (closeQuote !== -1) {
            val += query.substring(i, closeQuote);
            i = closeQuote + 1;
          }
        }
      }

      tokens.push({ negated, operator: op, value: val });
    } else if (colonIdx > 0 && colonIdx === word.length - 1) {
      tokens.push({ negated, operator: null, value: word });
    } else {
      tokens.push({ negated, operator: null, value: word });
    }
  }

  return tokens;
}

/**
 * Parse a Gmail-style query string into SQL WHERE clause and named params.
 */
export function parseGmailQuery(query: string, options?: ParseGmailQueryOptions): ParsedQuery {
  const tokens = tokenize(query.trim());
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  let paramCounter = 0;
  const paramPrefix = normalizeParamPrefix(options?.paramPrefix);
  const accountId = options?.accountId;

  if (typeof accountId === 'number' && Number.isFinite(accountId)) {
    params['accountId'] = accountId;
  }

  /**
   * Returns the next unique parameter NAME (without colon prefix) for use as the JS
   * object key.  The SQL string must embed the placeholder as `:${name}`.
   */
  function nextParam(): string {
    paramCounter++;
    return `${paramPrefix}${paramCounter}`;
  }

  for (const token of tokens) {
    const { negated, operator, value } = token;
    const not = negated ? 'NOT ' : '';

    if (operator === null) {
      const paramName = nextParam();
      const escaped = escapeLike(value);
      params[paramName] = `%${escaped}%`;
      conditions.push(
        `${not}(e.subject LIKE :${paramName} ESCAPE '\\' OR e.from_address LIKE :${paramName} ESCAPE '\\' OR e.from_name LIKE :${paramName} ESCAPE '\\' OR e.to_addresses LIKE :${paramName} ESCAPE '\\' OR e.text_body LIKE :${paramName} ESCAPE '\\')`
      );
      continue;
    }

    switch (operator) {
      case 'from': {
        const paramName = nextParam();
        const escaped = escapeLike(value);
        params[paramName] = `%${escaped}%`;
        conditions.push(
          `${not}(e.from_address LIKE :${paramName} ESCAPE '\\' OR e.from_name LIKE :${paramName} ESCAPE '\\')`
        );
        break;
      }

      case 'to': {
        const paramName = nextParam();
        const escaped = escapeLike(value);
        params[paramName] = `%${escaped}%`;
        conditions.push(`${not}(e.to_addresses LIKE :${paramName} ESCAPE '\\')`);
        break;
      }

      case 'subject': {
        const paramName = nextParam();
        const escaped = escapeLike(value);
        params[paramName] = `%${escaped}%`;
        conditions.push(`${not}(e.subject LIKE :${paramName} ESCAPE '\\')`);
        break;
      }

      case 'body': {
        const paramName = nextParam();
        const escaped = escapeLike(value);
        params[paramName] = `%${escaped}%`;
        conditions.push(`${not}(e.text_body LIKE :${paramName} ESCAPE '\\' OR e.html_body LIKE :${paramName} ESCAPE '\\')`);
        break;
      }

      case 'in': {
        const rawFolder = value.trim();
        if (!rawFolder) {
          break;
        }

        const mappedFolder = resolveFolderAlias(rawFolder, options);
        if (mappedFolder === null) {
          if (negated) {
            conditions.push('1 = 0');
          }
          break;
        }

        if (typeof mappedFolder === 'string') {
          const folderParamName = nextParam();
          params[folderParamName] = mappedFolder.toLowerCase();
          conditions.push(
            `${not}EXISTS (SELECT 1 FROM email_folders ef_in WHERE ef_in.account_id = e.account_id AND ef_in.x_gm_msgid = e.x_gm_msgid AND LOWER(ef_in.folder) = :${folderParamName})`
          );
          break;
        }

        const folderParamName = nextParam();
        params[folderParamName] = rawFolder.toLowerCase();

        if (typeof accountId !== 'number' || !Number.isFinite(accountId)) {
          conditions.push(
            `${not}EXISTS (SELECT 1 FROM email_folders ef_in WHERE ef_in.account_id = e.account_id AND ef_in.x_gm_msgid = e.x_gm_msgid AND LOWER(ef_in.folder) = :${folderParamName})`
          );
          break;
        }

        const labelNameParamName = nextParam();
        params[labelNameParamName] = rawFolder.toLowerCase();
        conditions.push(
          `${not}EXISTS (
            SELECT 1
            FROM email_folders ef_in
            WHERE ef_in.account_id = e.account_id AND ef_in.x_gm_msgid = e.x_gm_msgid
              AND (
                LOWER(ef_in.folder) = :${folderParamName}
                OR LOWER(ef_in.folder) IN (
                  SELECT LOWER(l.gmail_label_id)
                  FROM labels l
                  WHERE l.account_id = :accountId
                    AND LOWER(l.name) = :${labelNameParamName}
                )
              )
          )`
        );
        break;
      }

      case 'label': {
        const labelName = value.trim();
        if (!labelName) {
          break;
        }
        if (typeof accountId !== 'number' || !Number.isFinite(accountId)) {
          if (negated) {
            conditions.push('1 = 1');
          } else {
            conditions.push('1 = 0');
          }
          break;
        }

        const labelParamName = nextParam();
        params[labelParamName] = labelName.toLowerCase();
        conditions.push(
          `${not}EXISTS (
            SELECT 1
            FROM email_folders ef_label
            WHERE ef_label.account_id = e.account_id AND ef_label.x_gm_msgid = e.x_gm_msgid
              AND LOWER(ef_label.folder) IN (
                SELECT LOWER(l.gmail_label_id)
                FROM labels l
                WHERE l.account_id = :accountId
                  AND LOWER(l.name) = :${labelParamName}
              )
          )`
        );
        break;
      }

      case 'is': {
        const lowerVal = value.toLowerCase();
        if (lowerVal === 'unread') {
          conditions.push(negated ? 'e.is_read = 1' : 'e.is_read = 0');
        } else if (lowerVal === 'read') {
          conditions.push(negated ? 'e.is_read = 0' : 'e.is_read = 1');
        } else if (lowerVal === 'starred') {
          conditions.push(negated ? 'e.is_starred = 0' : 'e.is_starred = 1');
        } else if (lowerVal === 'important') {
          conditions.push(negated ? 'e.is_important = 0' : 'e.is_important = 1');
        } else {
          const paramName = nextParam();
          const escaped = escapeLike(`is:${value}`);
          params[paramName] = `%${escaped}%`;
          conditions.push(
            `${not}(e.subject LIKE :${paramName} ESCAPE '\\' OR e.from_address LIKE :${paramName} ESCAPE '\\' OR e.from_name LIKE :${paramName} ESCAPE '\\' OR e.to_addresses LIKE :${paramName} ESCAPE '\\' OR e.text_body LIKE :${paramName} ESCAPE '\\')`
          );
        }
        break;
      }

      case 'has': {
        const lowerVal = value.toLowerCase();
        if (lowerVal === 'attachment') {
          conditions.push(negated ? 'e.has_attachments = 0' : 'e.has_attachments = 1');
        } else {
          const paramName = nextParam();
          const escaped = escapeLike(`has:${value}`);
          params[paramName] = `%${escaped}%`;
          conditions.push(
            `${not}(e.subject LIKE :${paramName} ESCAPE '\\' OR e.text_body LIKE :${paramName} ESCAPE '\\')`
          );
        }
        break;
      }

      case 'after': {
        const isoDate = gmailDateToIso(value);
        if (isoDate) {
          const paramName = nextParam();
          params[paramName] = `${isoDate}T00:00:00.000Z`;
          if (negated) {
            conditions.push(`e.date < :${paramName}`);
          } else {
            conditions.push(`e.date >= :${paramName}`);
          }
        }
        break;
      }

      case 'before': {
        const isoDate = gmailDateToIso(value);
        if (isoDate) {
          const paramName = nextParam();
          params[paramName] = `${isoDate}T00:00:00.000Z`;
          if (negated) {
            conditions.push(`e.date >= :${paramName}`);
          } else {
            conditions.push(`e.date < :${paramName}`);
          }
        }
        break;
      }

      case 'newer_than': {
        const date = parseRelativeTime(value);
        if (date) {
          const paramName = nextParam();
          params[paramName] = date;
          if (negated) {
            conditions.push(`e.date < :${paramName}`);
          } else {
            conditions.push(`e.date >= :${paramName}`);
          }
        }
        break;
      }

      case 'older_than': {
        const date = parseRelativeTime(value);
        if (date) {
          const paramName = nextParam();
          params[paramName] = date;
          if (negated) {
            conditions.push(`e.date >= :${paramName}`);
          } else {
            conditions.push(`e.date < :${paramName}`);
          }
        }
        break;
      }

      default: {
        const paramName = nextParam();
        const escaped = escapeLike(`${operator}:${value}`);
        params[paramName] = `%${escaped}%`;
        conditions.push(
          `${not}(e.subject LIKE :${paramName} ESCAPE '\\' OR e.from_address LIKE :${paramName} ESCAPE '\\' OR e.from_name LIKE :${paramName} ESCAPE '\\' OR e.to_addresses LIKE :${paramName} ESCAPE '\\' OR e.text_body LIKE :${paramName} ESCAPE '\\')`
        );
        break;
      }
    }
  }

  if (conditions.length === 0) {
    return { whereClause: '1=1', params: {} };
  }

  return {
    whereClause: conditions.join(' AND '),
    params,
  };
}
