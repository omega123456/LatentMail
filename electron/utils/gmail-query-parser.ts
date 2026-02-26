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

export interface ParsedQuery {
  whereClause: string;
  params: Record<string, unknown>;
}

export interface ParseGmailQueryOptions {
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
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return null;
  }
  const year = match[1];
  const month = match[2].padStart(2, '0');
  const day = match[3].padStart(2, '0');
  return `${year}-${month}-${day}`;
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
  const now = new Date();

  switch (unit) {
    case 'd': {
      now.setDate(now.getDate() - amount);
      break;
    }
    case 'm': {
      now.setMonth(now.getMonth() - amount);
      break;
    }
    case 'y': {
      now.setFullYear(now.getFullYear() - amount);
      break;
    }
    default: {
      return null;
    }
  }

  return now.toISOString();
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
    params[':accountId'] = accountId;
  }

  function nextParam(): string {
    paramCounter++;
    return `:${paramPrefix}${paramCounter}`;
  }

  for (const token of tokens) {
    const { negated, operator, value } = token;
    const not = negated ? 'NOT ' : '';

    if (operator === null) {
      const param = nextParam();
      const escaped = escapeLike(value);
      params[param] = `%${escaped}%`;
      conditions.push(
        `${not}(e.subject LIKE ${param} ESCAPE '\\' OR e.from_address LIKE ${param} ESCAPE '\\' OR e.from_name LIKE ${param} ESCAPE '\\' OR e.to_addresses LIKE ${param} ESCAPE '\\' OR e.text_body LIKE ${param} ESCAPE '\\')`
      );
      continue;
    }

    switch (operator) {
      case 'from': {
        const param = nextParam();
        const escaped = escapeLike(value);
        params[param] = `%${escaped}%`;
        conditions.push(
          `${not}(e.from_address LIKE ${param} ESCAPE '\\' OR e.from_name LIKE ${param} ESCAPE '\\')`
        );
        break;
      }

      case 'to': {
        const param = nextParam();
        const escaped = escapeLike(value);
        params[param] = `%${escaped}%`;
        conditions.push(`${not}(e.to_addresses LIKE ${param} ESCAPE '\\')`);
        break;
      }

      case 'subject': {
        const param = nextParam();
        const escaped = escapeLike(value);
        params[param] = `%${escaped}%`;
        conditions.push(`${not}(e.subject LIKE ${param} ESCAPE '\\')`);
        break;
      }

      case 'body': {
        const param = nextParam();
        const escaped = escapeLike(value);
        params[param] = `%${escaped}%`;
        conditions.push(`${not}(e.text_body LIKE ${param} ESCAPE '\\' OR e.html_body LIKE ${param} ESCAPE '\\')`);
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
          const folderParam = nextParam();
          params[folderParam] = mappedFolder.toLowerCase();
          conditions.push(
            `${not}EXISTS (SELECT 1 FROM email_folders ef_in WHERE ef_in.email_id = e.id AND LOWER(ef_in.folder) = ${folderParam})`
          );
          break;
        }

        const folderParam = nextParam();
        params[folderParam] = rawFolder.toLowerCase();

        if (typeof accountId !== 'number' || !Number.isFinite(accountId)) {
          conditions.push(
            `${not}EXISTS (SELECT 1 FROM email_folders ef_in WHERE ef_in.email_id = e.id AND LOWER(ef_in.folder) = ${folderParam})`
          );
          break;
        }

        const labelNameParam = nextParam();
        params[labelNameParam] = rawFolder.toLowerCase();
        conditions.push(
          `${not}EXISTS (
            SELECT 1
            FROM email_folders ef_in
            WHERE ef_in.email_id = e.id
              AND (
                LOWER(ef_in.folder) = ${folderParam}
                OR LOWER(ef_in.folder) IN (
                  SELECT LOWER(l.gmail_label_id)
                  FROM labels l
                  WHERE l.account_id = :accountId
                    AND LOWER(l.name) = ${labelNameParam}
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

        const labelParam = nextParam();
        params[labelParam] = labelName.toLowerCase();
        conditions.push(
          `${not}EXISTS (
            SELECT 1
            FROM email_folders ef_label
            WHERE ef_label.email_id = e.id
              AND LOWER(ef_label.folder) IN (
                SELECT LOWER(l.gmail_label_id)
                FROM labels l
                WHERE l.account_id = :accountId
                  AND LOWER(l.name) = ${labelParam}
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
          const param = nextParam();
          const escaped = escapeLike(`is:${value}`);
          params[param] = `%${escaped}%`;
          conditions.push(
            `${not}(e.subject LIKE ${param} ESCAPE '\\' OR e.from_address LIKE ${param} ESCAPE '\\' OR e.from_name LIKE ${param} ESCAPE '\\' OR e.to_addresses LIKE ${param} ESCAPE '\\' OR e.text_body LIKE ${param} ESCAPE '\\')`
          );
        }
        break;
      }

      case 'has': {
        const lowerVal = value.toLowerCase();
        if (lowerVal === 'attachment') {
          conditions.push(negated ? 'e.has_attachments = 0' : 'e.has_attachments = 1');
        } else {
          const param = nextParam();
          const escaped = escapeLike(`has:${value}`);
          params[param] = `%${escaped}%`;
          conditions.push(
            `${not}(e.subject LIKE ${param} ESCAPE '\\' OR e.text_body LIKE ${param} ESCAPE '\\')`
          );
        }
        break;
      }

      case 'after': {
        const isoDate = gmailDateToIso(value);
        if (isoDate) {
          const param = nextParam();
          params[param] = `${isoDate}T00:00:00.000Z`;
          if (negated) {
            conditions.push(`e.date < ${param}`);
          } else {
            conditions.push(`e.date >= ${param}`);
          }
        }
        break;
      }

      case 'before': {
        const isoDate = gmailDateToIso(value);
        if (isoDate) {
          const param = nextParam();
          params[param] = `${isoDate}T00:00:00.000Z`;
          if (negated) {
            conditions.push(`e.date >= ${param}`);
          } else {
            conditions.push(`e.date < ${param}`);
          }
        }
        break;
      }

      case 'newer_than': {
        const date = parseRelativeTime(value);
        if (date) {
          const param = nextParam();
          params[param] = date;
          if (negated) {
            conditions.push(`e.date < ${param}`);
          } else {
            conditions.push(`e.date >= ${param}`);
          }
        }
        break;
      }

      case 'older_than': {
        const date = parseRelativeTime(value);
        if (date) {
          const param = nextParam();
          params[param] = date;
          if (negated) {
            conditions.push(`e.date >= ${param}`);
          } else {
            conditions.push(`e.date < ${param}`);
          }
        }
        break;
      }

      default: {
        const param = nextParam();
        const escaped = escapeLike(`${operator}:${value}`);
        params[param] = `%${escaped}%`;
        conditions.push(
          `${not}(e.subject LIKE ${param} ESCAPE '\\' OR e.from_address LIKE ${param} ESCAPE '\\' OR e.from_name LIKE ${param} ESCAPE '\\' OR e.to_addresses LIKE ${param} ESCAPE '\\' OR e.text_body LIKE ${param} ESCAPE '\\')`
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
