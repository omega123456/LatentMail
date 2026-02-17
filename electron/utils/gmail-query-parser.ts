/**
 * Gmail Query Parser
 *
 * Parses a Gmail-style search query string into SQL WHERE conditions
 * with named placeholders for use by DatabaseService.searchEmails().
 *
 * Supported operators:
 *   from:, to:, subject:, is:unread, is:read, is:starred,
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

/** Escape SQL LIKE wildcard characters in user-provided values. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Convert Gmail date (YYYY/MM/DD) to ISO date string (YYYY-MM-DD). */
function gmailDateToIso(dateStr: string): string | null {
  // Accept YYYY/MM/DD or YYYY-MM-DD
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
    case 'd':
      now.setDate(now.getDate() - amount);
      break;
    case 'm':
      now.setMonth(now.getMonth() - amount);
      break;
    case 'y':
      now.setFullYear(now.getFullYear() - amount);
      break;
    default:
      return null;
  }

  return now.toISOString();
}

interface Token {
  negated: boolean;
  operator: string | null; // null for plain keyword
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
    // Skip whitespace
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

    // Check for quoted phrase
    if (query[i] === '"') {
      const closeQuote = query.indexOf('"', i + 1);
      if (closeQuote !== -1) {
        const phrase = query.substring(i + 1, closeQuote);
        tokens.push({ negated, operator: null, value: phrase });
        i = closeQuote + 1;
        continue;
      }
      // No closing quote — treat rest as value
      const rest = query.substring(i + 1).trim();
      if (rest) {
        tokens.push({ negated, operator: null, value: rest });
      }
      break;
    }

    // Read until whitespace
    let word = '';
    while (i < len && !/\s/.test(query[i])) {
      word += query[i];
      i++;
    }

    if (!word) {
      continue;
    }

    // Check for operator:value pattern
    const colonIdx = word.indexOf(':');
    if (colonIdx > 0 && colonIdx < word.length - 1) {
      const op = word.substring(0, colonIdx).toLowerCase();
      let val = word.substring(colonIdx + 1);

      // Handle quoted value after operator (e.g. subject:"project deadline")
      if (val.startsWith('"')) {
        val = val.substring(1);
        if (val.endsWith('"')) {
          val = val.substring(0, val.length - 1);
        } else {
          // Value continues past whitespace until closing quote
          const closeQuote = query.indexOf('"', i);
          if (closeQuote !== -1) {
            val += query.substring(i, closeQuote);
            i = closeQuote + 1;
          }
        }
      }

      tokens.push({ negated, operator: op, value: val });
    } else if (colonIdx > 0 && colonIdx === word.length - 1) {
      // Malformed: operator with no value (e.g. "from:") — treat as plain keyword
      tokens.push({ negated, operator: null, value: word });
    } else {
      // Plain keyword
      tokens.push({ negated, operator: null, value: word });
    }
  }

  return tokens;
}

/**
 * Parse a Gmail-style query string into SQL WHERE clause and named params.
 *
 * @param query - The Gmail search query string
 * @param accountParamName - The named parameter for account ID (default ':accountId')
 * @returns ParsedQuery with whereClause and params
 */
export function parseGmailQuery(query: string): ParsedQuery {
  const tokens = tokenize(query.trim());
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  let paramCounter = 0;

  function nextParam(): string {
    paramCounter++;
    return `:sqp${paramCounter}`;
  }

  for (const token of tokens) {
    const { negated, operator, value } = token;
    const not = negated ? 'NOT ' : '';

    if (operator === null) {
      // Plain keyword — search across multiple fields
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
        conditions.push(
          `${not}(e.to_addresses LIKE ${param} ESCAPE '\\')`
        );
        break;
      }

      case 'subject': {
        const param = nextParam();
        const escaped = escapeLike(value);
        params[param] = `%${escaped}%`;
        conditions.push(
          `${not}(e.subject LIKE ${param} ESCAPE '\\')`
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
          // Unknown is: value — treat as plain keyword
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
          // Unknown has: value — treat as plain keyword
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
        // Unknown operator — treat entire token as plain keyword
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
