import { describe, expect, it } from 'vitest';
import { formatFileSize } from '@/lib/format/file-size';

describe('formatFileSize', () => {
  it('formats bytes below 1 KB with a byte suffix', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('formats kilobytes with one decimal place under 10', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('rounds to whole numbers at 10 units and above', () => {
    expect(formatFileSize(12 * 1024)).toBe('12 KB');
  });

  it('formats megabytes', () => {
    expect(formatFileSize(1.4 * 1024 * 1024)).toBe('1.4 MB');
  });

  it('formats gigabytes and does not overflow past the unit table', () => {
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe('2 GB');
  });

  it('handles zero bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });
});
