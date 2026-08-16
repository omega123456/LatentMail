import { describe, expect, it } from 'vitest';
import { domainFor, initialFor } from '@/lib/avatars/identity';

describe('initialFor', () => {
  it('uppercases the first character of the label', () => {
    expect(initialFor('elena rodriguez')).toBe('E');
  });

  it('falls back to "?" for no label, an empty string, or all whitespace', () => {
    expect(initialFor(null)).toBe('?');
    expect(initialFor(undefined)).toBe('?');
    expect(initialFor('')).toBe('?');
    expect(initialFor('   ')).toBe('?');
  });
});

describe('domainFor', () => {
  it('extracts the lower-cased domain from a bare address', () => {
    expect(domainFor('Dispatch@Northwind.Example')).toBe('northwind.example');
  });

  it('reuses participants.ts parsing, so a "Name <addr>" string still resolves', () => {
    expect(domainFor('Elena Rodriguez <elena.r@example.com>')).toBe('example.com');
  });

  it('returns null for no address, an empty address, or one with no "@"', () => {
    expect(domainFor(null)).toBeNull();
    expect(domainFor(undefined)).toBeNull();
    expect(domainFor('')).toBeNull();
    expect(domainFor('not-an-address')).toBeNull();
    expect(domainFor('trailing-at@')).toBeNull();
  });
});
