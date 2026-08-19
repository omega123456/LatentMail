import { describe, expect, it } from 'vitest';
import { resolvePreviewKind } from '@/lib/attachments/kind';

describe('resolvePreviewKind', () => {
  it('classifies images', () => {
    expect(resolvePreviewKind('image/png', 'scan.png')).toBe('image');
  });

  it('classifies PDF by mime type or extension', () => {
    expect(resolvePreviewKind('application/pdf', 'a.pdf')).toBe('pdf');
    expect(resolvePreviewKind('application/octet-stream', 'a.pdf')).toBe('pdf');
  });

  it('classifies CSV before the generic text family, by mime type or extension', () => {
    expect(resolvePreviewKind('text/csv', 'export.csv')).toBe('csv');
    expect(resolvePreviewKind('text/plain', 'export.csv')).toBe('csv');
  });

  it('classifies DOCX only by its exact mime type or extension', () => {
    expect(
      resolvePreviewKind(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'agreement.docx',
      ),
    ).toBe('docx');
    expect(resolvePreviewKind('application/msword', 'legacy.doc')).toBe('unsupported');
  });

  it('classifies JSON and JavaScript distinctly from plain text', () => {
    expect(resolvePreviewKind('application/json', 'data.json')).toBe('json');
    expect(resolvePreviewKind('text/javascript', 'index.js')).toBe('javascript');
    expect(resolvePreviewKind('text/plain', 'notes.txt')).toBe('text');
  });

  it('falls back to unsupported for anything else', () => {
    expect(resolvePreviewKind('video/mp4', 'clip.mp4')).toBe('unsupported');
    expect(resolvePreviewKind('application/zip', 'site.zip')).toBe('unsupported');
  });
});
