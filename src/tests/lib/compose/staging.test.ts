import { describe, expect, it, vi } from 'vitest';
import {
  generateInlineContentId,
  guessMimeType,
  pickAttachments,
  pickImages,
  stageAttachmentPath,
} from '@/lib/compose/staging';
import { ipc } from '@/tests/ipc-mock';

describe('compose staging', () => {
  it('returns empty picker selections and normalizes single/multiple selections', async () => {
    ipc.override('plugin:dialog|open', null);
    await expect(pickAttachments()).resolves.toEqual([]);
    ipc.override('plugin:dialog|open', '/tmp/a.pdf');
    await expect(pickAttachments()).resolves.toEqual(['/tmp/a.pdf']);
    ipc.override('plugin:dialog|open', ['/tmp/a.png', '/tmp/b.jpg']);
    await expect(pickImages()).resolves.toEqual(['/tmp/a.png', '/tmp/b.jpg']);
  });

  it('guesses supported types with a safe fallback and stages through centralized IPC', async () => {
    expect(guessMimeType('/tmp/PHOTO.JPEG')).toBe('image/jpeg');
    expect(guessMimeType('/tmp/no-extension')).toBe('application/octet-stream');
    const stage = vi.fn(() => ({
      id: 'part-1',
      filename: 'deck.pdf',
      mimeType: 'application/pdf',
      path: '/stage/deck.pdf',
      contentId: null,
      size: 42,
    }));
    ipc.override('stage_attachment_from_path', stage);
    await expect(stageAttachmentPath('account', 'session', '/tmp/deck.pdf')).resolves.toMatchObject(
      {
        id: 'part-1',
        assetUrl: expect.stringContaining(encodeURIComponent('/stage/deck.pdf')),
      },
    );
    expect(stage).toHaveBeenCalledWith({
      accountId: 'account',
      owner: 'session',
      path: '/tmp/deck.pdf',
      mimeType: 'application/pdf',
      contentId: null,
    });
  });

  it('creates bare opaque Content-ID tokens for inline images', () => {
    expect(generateInlineContentId()).toMatch(/^[\w-]+@latentmail$/);
  });
});
