import { describe, expect, it } from 'vitest';
import { formatParticipants, parseParticipant } from '@/lib/format/participants';

describe('formatParticipants', () => {
  it('compacts recipient names after two', () => {
    expect(
      formatParticipants([
        { name: 'Ada', address: 'ada@example.com' },
        { name: 'Ben', address: 'ben@example.com' },
        { name: 'Cia', address: 'cia@example.com' },
      ]),
    ).toBe('Ada and 2 others');
  });
});

describe('parseParticipant', () => {
  it('splits a "Name <address>" header into name and address', () => {
    expect(parseParticipant('Elena Rodriguez <elena.r@example.com>')).toEqual({
      name: 'Elena Rodriguez',
      address: 'elena.r@example.com',
    });
  });

  it('strips surrounding quotes from the display name', () => {
    expect(parseParticipant('"Elena Rodriguez" <elena.r@example.com>')).toEqual({
      name: 'Elena Rodriguez',
      address: 'elena.r@example.com',
    });
  });

  it('falls back to a bare address with no display name', () => {
    expect(parseParticipant('elena.r@example.com')).toEqual({
      name: '',
      address: 'elena.r@example.com',
    });
  });
});
