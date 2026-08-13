import { act, renderHook, waitFor } from '@testing-library/react';
import { createRef, type RefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAttachmentPipeline } from '@/components/compose/useAttachmentPipeline';
import type { BodyEditorHandle } from '@/components/compose/BodyEditor';
import { useComposeStore } from '@/stores/compose';
import { ipc } from '@/tests/ipc-mock';

beforeEach(() => {
  act(() =>
    useComposeStore.getState().open({
      id: 'session',
      mode: 'new',
      accountId: 'account',
      from: 'me@example.com',
      recipients: { to: [], cc: [], bcc: [] },
      subject: '',
      html: '',
    }),
  );
});

describe('useAttachmentPipeline', () => {
  it('stages picker files into chips and releases a settled part on removal', async () => {
    const stage = vi.fn(() => ({
      id: 'part',
      filename: 'deck.pdf',
      mimeType: 'application/pdf',
      path: '/stage/deck.pdf',
      contentId: null,
      size: 10,
    }));
    const release = vi.fn();
    ipc.override('plugin:dialog|open', ['/tmp/deck.pdf']);
    ipc.override('stage_attachment_from_path', stage);
    ipc.override('release_staged_attachment', release);
    const { result } = renderHook(() => useAttachmentPipeline(createRef<BodyEditorHandle>()));

    await act(async () => result.current.onAttach());
    await waitFor(() =>
      expect(useComposeStore.getState().session?.attachments[0]).toMatchObject({
        state: 'settled',
        staged: { id: 'part' },
      }),
    );
    const localId = useComposeStore.getState().session!.attachments[0].localId;
    act(() => result.current.onRemoveAttachment(localId));
    await waitFor(() =>
      expect(release).toHaveBeenCalledWith({ accountId: 'account', owner: 'session', id: 'part' }),
    );
  });

  it('inserts staged inline images and removes their part when the editor HTML drops the asset URL', async () => {
    const insertInlineImage = vi.fn();
    const release = vi.fn();
    ipc.override('plugin:dialog|open', '/tmp/chart.png');
    ipc.override('stage_attachment_from_path', {
      id: 'image',
      filename: 'chart.png',
      mimeType: 'image/png',
      path: '/stage/chart.png',
      contentId: 'cid:image',
      size: 11,
    });
    ipc.override('release_staged_attachment', release);
    const bodyRef = {
      current: { html: () => '', focus: () => undefined, insertInlineImage },
    } as RefObject<BodyEditorHandle>;
    const { result } = renderHook(() => useAttachmentPipeline(bodyRef));

    await act(async () => result.current.onInsertImage());
    await waitFor(() => expect(insertInlineImage).toHaveBeenCalled());
    const assetUrl = useComposeStore.getState().session!.attachments[0].staged!.assetUrl;
    act(() => useComposeStore.getState().setHtml(`<img src="${assetUrl}">`));
    act(() => useComposeStore.getState().setHtml(''));
    await waitFor(() =>
      expect(release).toHaveBeenCalledWith({ accountId: 'account', owner: 'session', id: 'image' }),
    );
  });

  it('stages native dropped paths through the same pipeline', async () => {
    ipc.override('stage_attachment_from_path', {
      id: 'drop',
      filename: 'drop.txt',
      mimeType: 'text/plain',
      path: '/stage/drop.txt',
      contentId: null,
      size: 1,
    });
    renderHook(() => useAttachmentPipeline(createRef<BodyEditorHandle>()));
    await act(async () =>
      ipc.emit('tauri://drag-drop', {
        type: 'drop',
        paths: ['/tmp/drop.txt'],
        position: { x: 0, y: 0 },
      }),
    );
    await waitFor(() =>
      expect(useComposeStore.getState().session?.attachments[0]).toMatchObject({
        filename: 'drop.txt',
        state: 'settled',
      }),
    );
  });
});
