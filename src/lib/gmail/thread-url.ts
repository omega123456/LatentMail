export function buildGmailThreadWebUrl(
  threadId: string | null | undefined,
  accountEmail: string | null | undefined,
): string | null {
  if (!threadId || !accountEmail) return null;
  return `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(accountEmail)}#all/${threadId}`;
}
