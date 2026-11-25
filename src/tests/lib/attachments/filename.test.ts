import { describe, expect, it } from 'vitest';
import { messageExportFilename, sanitizeFilename } from '@/lib/attachments/filename';
import { parseISO } from 'date-fns';

const OVERLONG_SUBJECT_LENGTH = 400;
const CAPPED_FILENAME_LENGTH = 124;

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
  const sentAt = parseISO('2026-10-23T09:14:00');

  it('prefixes the subject with the sent date and appends the format', () => {
    expect(
      messageExportFilename({
        subject: 'Your invoice is ready',
        sentAt: sentAt,
        sender: 'a@example.com',
        extension: 'eml',
      }),
    ).toBe('2026-10-23 Your invoice is ready.eml');
  });

  it('keeps every part of a subject that contains path and reserved characters', () => {
    expect(
      messageExportFilename({
        subject: 'Re: Q3 review / action items?',
        sentAt: sentAt,
        sender: '',
        extension: 'html',
      }),
    ).toBe('2026-10-23 Re Q3 review action items.html');
  });

  it('names a subjectless message after its sender', () => {
    expect(
      messageExportFilename({
        subject: '  ',
        sentAt: sentAt,
        sender: 'billing@northwind.example',
        extension: 'eml',
      }),
    ).toBe('2026-10-23 Message from billing@northwind.example.eml');
  });

  it('caps a very long subject', () => {
    const filename = messageExportFilename({
      subject: 'x'.repeat(OVERLONG_SUBJECT_LENGTH),
      sentAt: sentAt,
      sender: '',
      extension: 'eml',
    });
    expect(filename).toHaveLength(CAPPED_FILENAME_LENGTH);
    expect(filename.endsWith('x.eml')).toBe(true);
  });
});
