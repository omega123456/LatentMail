import md5 from 'md5';

const GRAVATAR_BASE = 'https://www.gravatar.com/avatar';
const DEFAULT_SIZE = 80;

/**
 * Returns the Gravatar avatar URL for an email address, or null if the email is empty/invalid.
 * Uses d=404 so that missing Gravatars return 404 and the UI can fall back to initials.
 */
export function getGravatarUrl(
  email: string | null | undefined,
  size: number = DEFAULT_SIZE
): string | null {
  const normalized = (email ?? '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const hash = md5(normalized);
  return `${GRAVATAR_BASE}/${hash}?s=${size}&d=404`;
}
