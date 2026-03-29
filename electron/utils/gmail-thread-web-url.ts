/**
 * Build a Gmail web URL that opens a thread in the browser.
 * IMAP X-GM-THRID is decimal; Gmail's hash fragment uses the same id in hex.
 */

export interface BuildGmailThreadWebUrlOptions {
  /** Account email for `authuser` (multi-mailbox). */
  authUserEmail?: string;
}

/**
 * @param xGmThrid - Gmail thread id from IMAP (decimal string)
 * @returns URL or null if thread id is missing or not a valid integer
 */
export function buildGmailThreadWebUrl(
  xGmThrid: string,
  options?: BuildGmailThreadWebUrlOptions,
): string | null {
  const trimmed = xGmThrid?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const hexId = BigInt(trimmed).toString(16);
    if (!hexId) {
      return null;
    }
    const base = 'https://mail.google.com/mail/u/0/';
    const fragment = `#all/${hexId}`;
    if (options?.authUserEmail?.trim()) {
      const auth = encodeURIComponent(options.authUserEmail.trim());
      return `${base}?authuser=${auth}${fragment}`;
    }
    return `${base}${fragment}`;
  } catch {
    return null;
  }
}
