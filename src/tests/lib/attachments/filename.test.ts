import { describe, expect, it } from 'vitest';
import { messageExportFilename, sanitizeFilename } from '@/lib/attachments/filename';

describe('sanitizeFilename', () => {
  it('strips path separators, keeping only the final segment', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
  });

  it('collapses traversal sequences within a segment', () => {
    expect(sanitizeFilename('report..pdf')).toBe('report_pdf');
  });

  it('replaces reserved characters', () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
  });

  it('strips ASCII control characters', () => {
    expect(sanitizeFilename('report\x00\x1f.pdf')).toBe('report__.pdf');
  });

  it('trims trailing dots and spaces', () => {
    expect(sanitizeFilename('report.pdf. ')).toBe('report.pdf');
  });

  it('falls back to a default name when nothing survives', () => {
    expect(sanitizeFilename('.')).toBe('attachment');
    expect(sanitizeFilename('   ')).toBe('attachment');
  });

  it('collapses a traversal-only name to a single underscore', () => {
    expect(sanitizeFilename('...')).toBe('_');
  });

  it('prefixes reserved Windows device names', () => {
    expect(sanitizeFilename('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFilename('com1')).toBe('_com1');
  });

  it('leaves an ordinary filename untouched', () => {
    expect(sanitizeFilename('Q3-summary.pdf')).toBe('Q3-summary.pdf');
  });
});

describe('messageExportFilename', () => {
  const sentAt = new Date(2026, 9, 23, 9, 14);

  it('prefixes the subject with the sent date and appends the format', () => {
    expect(messageExportFilename('Your invoice is ready', sentAt, 'a@example.com', 'eml')).toBe(
      '2026-10-23 Your invoice is ready.eml',
    );
  });

  it('keeps every part of a subject that contains path and reserved characters', () => {
    expect(messageExportFilename('Re: Q3 review / action items?', sentAt, '', 'html')).toBe(
      '2026-10-23 Re Q3 review action items.html',
    );
  });

  it('names a subjectless message after its sender', () => {
    expect(messageExportFilename('  ', sentAt, 'billing@northwind.example', 'eml')).toBe(
      '2026-10-23 Message from billing@northwind.example.eml',
    );
  });

  it('caps a very long subject', () => {
    const filename = messageExportFilename('x'.repeat(400), sentAt, '', 'eml');
    expect(filename).toHaveLength(124);
    expect(filename.endsWith('x.eml')).toBe(true);
  });
});
