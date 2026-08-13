import { describe, expect, it, vi } from 'vitest';
import { subscribeToFileDrop } from '@/lib/compose/file-drop';

describe('native compose file drop', () => {
  it('is a callable no-op when no Tauri runtime exists', () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const onDrop = vi.fn();
    const dispose = subscribeToFileDrop(onDrop);
    dispose();
    expect(onDrop).not.toHaveBeenCalled();
  });
});
