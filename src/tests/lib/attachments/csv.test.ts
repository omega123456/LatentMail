import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/lib/attachments/csv';

describe('parseCsv', () => {
  it('parses a simple grid', () => {
    expect(parseCsv('Region,Revenue\nNorth,412880\n')).toEqual([
      ['Region', 'Revenue'],
      ['North', '412880'],
    ]);
  });

  it('handles a quoted field containing a comma', () => {
    expect(parseCsv('Name,Note\n"Doe, Jane",ok\n')).toEqual([
      ['Name', 'Note'],
      ['Doe, Jane', 'ok'],
    ]);
  });

  it('handles a quoted field containing an embedded newline', () => {
    expect(parseCsv('Name,Note\n"Line one\nLine two",ok\n')).toEqual([
      ['Name', 'Note'],
      ['Line one\nLine two', 'ok'],
    ]);
  });

  it('handles a doubled-quote escape inside a quoted field', () => {
    expect(parseCsv('Name,Quote\n"Rex","She said ""hi"""\n')).toEqual([
      ['Name', 'Quote'],
      ['Rex', 'She said "hi"'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles a final row with no trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});
