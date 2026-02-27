/**
 * Utility functions for formatting participant display strings in email threads.
 * Centralizes the logic for producing "Name <email>" strings with graceful fallbacks.
 */

/**
 * Formats a single participant as "Name <email>" when a distinct, non-empty name
 * is provided. Returns just the plain email address otherwise (no angle brackets).
 */
export function formatParticipant(address: string, name?: string | null): string {
  if (!address) {
    return '';
  }
  const trimmedName = (name || '').trim();
  if (trimmedName && trimmedName !== address) {
    return `${trimmedName} <${address}>`;
  }
  return address;
}

/**
 * Builds a comma-separated participant string from an array of email objects,
 * deduplicating by email address (first occurrence in array order wins for name).
 * Entries with empty/falsy fromAddress are skipped.
 */
export function formatParticipantList(
  emails: Array<{ fromAddress: string; fromName?: string | null }>
): string {
  const seen = new Set<string>();
  const formatted: string[] = [];

  for (const emailEntry of emails) {
    if (!emailEntry.fromAddress) {
      continue;
    }
    if (seen.has(emailEntry.fromAddress)) {
      continue;
    }
    seen.add(emailEntry.fromAddress);
    formatted.push(formatParticipant(emailEntry.fromAddress, emailEntry.fromName));
  }

  return formatted.join(', ');
}

/**
 * Extracts the raw email address from a formatted participant string.
 * Handles both "Name <email>" format and plain email addresses.
 */
export function extractEmailAddress(participant: string): string {
  const match = participant.match(/<([^>]+)>/);
  if (match) {
    return match[1].trim();
  }
  return participant.trim();
}
