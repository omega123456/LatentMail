import { describe, expect, it } from 'vitest';
import { buildGmailThreadWebUrl } from '@/lib/gmail/thread-url';

describe('buildGmailThreadWebUrl', () => {
  it('builds a web URL scoped to the account and thread', () => {
    expect(buildGmailThreadWebUrl('18c9f2a1b2c3d4e5', 'me@example.com')).toBe(
      'https://mail.google.com/mail/u/0/?authuser=me%40example.com#all/18c9f2a1b2c3d4e5',
    );
  });

  it('returns null when the thread id is missing', () => {
    expect(buildGmailThreadWebUrl(null, 'me@example.com')).toBeNull();
    expect(buildGmailThreadWebUrl('', 'me@example.com')).toBeNull();
    expect(buildGmailThreadWebUrl(undefined, 'me@example.com')).toBeNull();
  });

  it('returns null when the account email is missing', () => {
    expect(buildGmailThreadWebUrl('18c9f2a1b2c3d4e5', null)).toBeNull();
    expect(buildGmailThreadWebUrl('18c9f2a1b2c3d4e5', '')).toBeNull();
    expect(buildGmailThreadWebUrl('18c9f2a1b2c3d4e5', undefined)).toBeNull();
  });
});
