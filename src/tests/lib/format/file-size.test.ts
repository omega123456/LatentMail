import { describe, expect, it } from 'vitest';
import { formatFileSize } from '@/lib/format/file-size';

const KILOBYTE = 1024;
const MEGABYTE = KILOBYTE * KILOBYTE;
const GIGABYTE = MEGABYTE * KILOBYTE;
const SUB_KILOBYTE_BYTES = 512;
const FRACTIONAL_KILOBYTES = 1.5;
const WHOLE_KILOBYTES = 12;
const FRACTIONAL_MEGABYTES = 1.4;
const WHOLE_GIGABYTES = 2;

describe('formatFileSize', () => {
  it('formats bytes below 1 KB with a byte suffix', () => {
    expect(formatFileSize(SUB_KILOBYTE_BYTES)).toBe('512 B');
  });

  it('formats kilobytes with one decimal place under 10', () => {
    expect(formatFileSize(FRACTIONAL_KILOBYTES * KILOBYTE)).toBe('1.5 KB');
  });

  it('rounds to whole numbers at 10 units and above', () => {
    expect(formatFileSize(WHOLE_KILOBYTES * KILOBYTE)).toBe('12 KB');
  });

  it('formats megabytes', () => {
    expect(formatFileSize(FRACTIONAL_MEGABYTES * MEGABYTE)).toBe('1.4 MB');
  });

  it('formats gigabytes and does not overflow past the unit table', () => {
    expect(formatFileSize(WHOLE_GIGABYTES * GIGABYTE)).toBe('2 GB');
  });

  it('handles zero bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });
});
