export interface SearchIntentDateRange {
  after?: string;
  before?: string;
  relative?: string;
}

export interface SearchIntentFlags {
  unread?: boolean;
  starred?: boolean;
  important?: boolean;
  hasAttachment?: boolean;
}

export interface SearchIntent {
  keywords: string[];
  synonyms: string[];
  direction: 'sent' | 'received' | 'any';
  folder: string | null;
  sender: string | null;
  recipient: string | null;
  dateRange: SearchIntentDateRange | null;
  flags: SearchIntentFlags;
  exactPhrases: string[];
  negations: string[];
}

const BLOCKED_OPERATOR_PATTERN = /\b(?:from|to|subject|is|has|after|before|newer_than|older_than|in|label)\s*:/i;
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'about',
  'into',
  'your',
  'you',
  'are',
  'was',
  'were',
  'has',
  'had',
  'not',
  'but',
  'out',
]);

function escapeQuotes(value: string): string {
  return value.replace(/\\/g, '').replace(/"/g, '\\"');
}

function sanitizeTextTerm(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (BLOCKED_OPERATOR_PATTERN.test(trimmed)) {
    return null;
  }
  const stripped = trimmed
    .replace(/[()]/g, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) {
    return null;
  }
  return stripped;
}

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

function quoteIfNeeded(value: string): string {
  if (/\s/.test(value)) {
    return `"${escapeQuotes(value)}"`;
  }
  return escapeQuotes(value);
}

function normalizeDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/-/g, '/');
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeRelative(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!/^\d+[dmy]$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(value.trim());
  }
  return deduped;
}

function joinVariant(tokens: string[]): string {
  return tokens.filter((token) => token.trim().length > 0).join(' ').trim();
}

const MAX_QUERY_VARIANTS = 7;

export class SearchQueryGenerator {
  static generate(intent: SearchIntent): string[] {
    const keywords = dedupeCaseInsensitive(
      intent.keywords
        .map((keyword) => sanitizeTextTerm(keyword))
        .filter((keyword): keyword is string => keyword != null)
    );
    const synonyms = dedupeCaseInsensitive(
      intent.synonyms
        .map((synonym) => sanitizeTextTerm(synonym))
        .filter((synonym): synonym is string => synonym != null)
    ).filter((synonym) => !keywords.some((keyword) => keyword.toLowerCase() === synonym.toLowerCase()));

    const constraints = this.buildConstraintTokens(intent);
    const variants: string[] = [];

    const primaryTokens = [...keywords.map((keyword) => quoteIfNeeded(keyword)), ...constraints];
    const primaryQuery = joinVariant(primaryTokens);
    if (primaryQuery) {
      variants.push(primaryQuery);
    }

    if (keywords.length > 0) {
      const subjectTokens = keywords.slice(0, 4).map((keyword) => `subject:${quoteIfNeeded(keyword)}`);
      const subjectQuery = joinVariant([...subjectTokens, ...constraints]);
      if (subjectQuery) {
        variants.push(subjectQuery);
      }
    }

    if (keywords.length > 0) {
      const bodyTokens = keywords.slice(0, 4).map((keyword) => `body:${quoteIfNeeded(keyword)}`);
      const bodyQuery = joinVariant([...bodyTokens, ...constraints]);
      if (bodyQuery) {
        variants.push(bodyQuery);
      }
    }

    for (const synonym of synonyms.slice(0, 3)) {
      const synonymQuery = joinVariant([quoteIfNeeded(synonym), ...constraints]);
      if (synonymQuery) {
        variants.push(synonymQuery);
      }
    }

    const splitKeywords = dedupeCaseInsensitive(
      [...keywords, ...synonyms.slice(0, 2)]
        .flatMap((term) => term.split(/\s+/))
        .map((word) => word.trim())
        .filter((word) => word.length >= 3)
        .filter((word) => !STOP_WORDS.has(word.toLowerCase()))
    );
    if (splitKeywords.length >= 2) {
      const looseQuery = joinVariant([...splitKeywords.slice(0, 5), ...constraints]);
      if (looseQuery) {
        variants.push(looseQuery);
      }
    }

    // OR-pool variant: any single word from keywords + all synonyms matches.
    // Uses Gmail's {word1 word2 ...} OR syntax for maximum recall.
    // This fires even when the LLM's chosen terms are slightly off from the actual email vocabulary.
    const allPoolWords = dedupeCaseInsensitive(
      [...keywords, ...synonyms]
        .flatMap((term) => term.split(/\s+/))
        .map((word) => word.trim())
        .filter((word) => word.length >= 3)
        .filter((word) => !STOP_WORDS.has(word.toLowerCase()))
    );
    if (allPoolWords.length >= 2) {
      const orPool = `{${allPoolWords.slice(0, 10).join(' ')}}`;
      const orPoolQuery = joinVariant([orPool, ...constraints]);
      if (orPoolQuery) {
        variants.push(orPoolQuery);
      }
    }

    const dedupedQueries = dedupeCaseInsensitive(variants);
    return dedupedQueries.slice(0, MAX_QUERY_VARIANTS);
  }

  private static buildConstraintTokens(intent: SearchIntent): string[] {
    const constraints: string[] = [];

    if (intent.direction === 'sent') {
      // Gmail keyword: matches mail the authenticated user sent
      constraints.push('from:me');
    } else if (intent.direction === 'received') {
      // Gmail keyword: matches mail addressed to the authenticated user (handles BCC/aliases)
      constraints.push('to:me');
    }

    const folder = intent.folder ? sanitizeTextTerm(intent.folder) : null;
    if (folder) {
      constraints.push(`in:${quoteIfNeeded(folder)}`);
    }

    const sender = intent.sender ? sanitizeAddressValue(intent.sender) : null;
    if (sender) {
      constraints.push(`from:${quoteIfNeeded(sender)}`);
    }

    const recipient = intent.recipient ? sanitizeAddressValue(intent.recipient) : null;
    if (recipient) {
      constraints.push(`to:${quoteIfNeeded(recipient)}`);
    }

    if (intent.dateRange) {
      const after = intent.dateRange.after ? normalizeDate(intent.dateRange.after) : null;
      const before = intent.dateRange.before ? normalizeDate(intent.dateRange.before) : null;
      const relative = intent.dateRange.relative ? normalizeRelative(intent.dateRange.relative) : null;
      if (after) {
        constraints.push(`after:${after}`);
      }
      if (before) {
        constraints.push(`before:${before}`);
      }
      if (relative) {
        constraints.push(`newer_than:${relative}`);
      }
    }

    if (intent.flags.unread === true) {
      constraints.push('is:unread');
    } else if (intent.flags.unread === false) {
      constraints.push('is:read');
    }
    if (intent.flags.starred === true) {
      constraints.push('is:starred');
    } else if (intent.flags.starred === false) {
      constraints.push('-is:starred');
    }
    if (intent.flags.important === true) {
      constraints.push('is:important');
    } else if (intent.flags.important === false) {
      constraints.push('-is:important');
    }
    if (intent.flags.hasAttachment === true) {
      constraints.push('has:attachment');
    } else if (intent.flags.hasAttachment === false) {
      constraints.push('-has:attachment');
    }

    const exactPhrases = dedupeCaseInsensitive(
      intent.exactPhrases
        .map((phrase) => sanitizeTextTerm(phrase))
        .filter((phrase): phrase is string => phrase != null)
    );
    for (const phrase of exactPhrases) {
      constraints.push(`"${escapeQuotes(phrase)}"`);
    }

    const negations = dedupeCaseInsensitive(
      intent.negations
        .map((term) => sanitizeTextTerm(term))
        .filter((term): term is string => term != null)
    );
    for (const term of negations) {
      constraints.push(`-${quoteIfNeeded(term)}`);
    }

    return constraints;
  }
}
