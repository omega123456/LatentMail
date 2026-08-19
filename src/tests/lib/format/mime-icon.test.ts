import { describe, expect, it } from 'vitest';
import { resolveMimeFamily, resolveMimeIcon } from '@/lib/format/mime-icon';

describe('resolveMimeFamily', () => {
  it('classifies PDF by mime type or extension', () => {
    expect(resolveMimeFamily('application/pdf', 'report.pdf')).toBe('pdf');
    expect(resolveMimeFamily('application/octet-stream', 'report.pdf')).toBe('pdf');
  });

  it('classifies document, spreadsheet and presentation families', () => {
    expect(
      resolveMimeFamily(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'agreement.docx',
      ),
    ).toBe('document');
    expect(resolveMimeFamily('text/csv', 'export.csv')).toBe('spreadsheet');
    expect(
      resolveMimeFamily(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'deck.pptx',
      ),
    ).toBe('presentation');
  });

  it('classifies image, archive, video and audio', () => {
    expect(resolveMimeFamily('image/jpeg', 'scan.jpg')).toBe('image');
    expect(resolveMimeFamily('application/zip', 'site.zip')).toBe('archive');
    expect(resolveMimeFamily('video/mp4', 'clip.mp4')).toBe('video');
    expect(resolveMimeFamily('audio/mpeg', 'track.mp3')).toBe('audio');
  });

  it('classifies text and code as a distinct neutral family from document', () => {
    expect(resolveMimeFamily('text/plain', 'notes.txt')).toBe('text-code');
    expect(resolveMimeFamily('text/javascript', 'index.js')).toBe('text-code');
  });

  it('falls back to generic for anything unrecognised', () => {
    expect(resolveMimeFamily('application/octet-stream', 'mystery.bin')).toBe('generic');
  });
});

describe('resolveMimeIcon', () => {
  it('marks the six file-type families coloured with literal class pairs', () => {
    const coloured = ['pdf', 'document', 'spreadsheet', 'presentation', 'image', 'archive'];
    const samples: [string, string][] = [
      ['application/pdf', 'a.pdf'],
      ['application/msword', 'a.doc'],
      ['text/csv', 'a.csv'],
      ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'a.pptx'],
      ['image/png', 'a.png'],
      ['application/zip', 'a.zip'],
    ];
    for (const [mime, filename] of samples) {
      const resolution = resolveMimeIcon(mime, filename);
      expect(coloured).toContain(resolution.family);
      expect(resolution.coloured).toBe(true);
      expect(resolution.inkClassName).toContain('filetype');
      expect(resolution.wellClassName).toContain('filetype');
    }
  });

  it('marks the four remaining families neutral', () => {
    const neutralSamples: [string, string][] = [
      ['video/mp4', 'a.mp4'],
      ['audio/mpeg', 'a.mp3'],
      ['text/plain', 'a.txt'],
      ['application/octet-stream', 'a.bin'],
    ];
    for (const [mime, filename] of neutralSamples) {
      const resolution = resolveMimeIcon(mime, filename);
      expect(resolution.coloured).toBe(false);
      expect(resolution.inkClassName).not.toContain('filetype');
      expect(resolution.wellClassName).not.toContain('filetype');
    }
  });
});
