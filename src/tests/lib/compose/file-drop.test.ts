import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { subscribeToFileDrop } from '@/lib/compose/file-drop';
import { ipc } from '@/tests/ipc-mock';

const dropPosition = { x: 0, y: 0 };

describe('native compose file drop', () => {
  it('is a callable no-op when no Tauri runtime exists', () => {
    ipc.useTauriApi();
    const onDrop = vi.fn();

    const dispose = subscribeToFileDrop(onDrop);
    dispose();

    expect(onDrop).not.toHaveBeenCalled();
    expect(ipc.tauriOnDragDropEvent).not.toHaveBeenCalled();
  });

  it('hands dropped paths over, ignores hovering, and stops after disposal', async () => {
    const onDrop = vi.fn();
    const dispose = subscribeToFileDrop(onDrop);
    await waitFor(() => expect(ipc.tauriOnDragDropEvent).toHaveBeenCalled());

    act(() => ipc.emit('tauri://drag-drop', { type: 'over', position: dropPosition }));
    act(() =>
      ipc.emit('tauri://drag-drop', { type: 'drop', paths: ['/a.txt'], position: dropPosition }),
    );
    await waitFor(() => expect(onDrop).toHaveBeenCalledWith(['/a.txt']));
    dispose();
    act(() =>
      ipc.emit('tauri://drag-drop', { type: 'drop', paths: ['/b.txt'], position: dropPosition }),
    );

    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('releases a subscription that resolves after it was already disposed', async () => {
    const onDrop = vi.fn();

    subscribeToFileDrop(onDrop)();
    await waitFor(() => expect(ipc.tauriOnDragDropEvent).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    act(() =>
      ipc.emit('tauri://drag-drop', { type: 'drop', paths: ['/a.txt'], position: dropPosition }),
    );

    expect(onDrop).not.toHaveBeenCalled();
  });
});
