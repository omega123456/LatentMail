import { act, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BodyEditor, type BodyEditorHandle } from '@/components/compose/BodyEditor';

describe('BodyEditor', () => {
  it('mounts and inserts an authorized inline preview, reporting changes and selection', async () => {
    const onChange = vi.fn();
    const onSelectionChange = vi.fn();
    const ref = createRef<BodyEditorHandle>();
    const { unmount } = render(
      <BodyEditor
        ref={ref}
        value="<p>Hello</p>"
        onChange={onChange}
        onSelectionChange={onSelectionChange}
      />,
    );
    await waitFor(() => expect(onSelectionChange).toHaveBeenCalled());
    onSelectionChange.mockClear();
    act(() => ref.current?.insertInlineImage('asset://inline-image'));
    expect(ref.current?.html()).toContain('asset://inline-image');
    expect(onChange).toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalled();
    unmount();
  });

  it('is inert without an onChange/onSelectionChange listener wired up', async () => {
    const ref = createRef<BodyEditorHandle>();
    const { unmount } = render(<BodyEditor ref={ref} value="<p>Hi</p>" onChange={() => {}} />);
    // No `onSelectionChange` prop — exercises the optional-callback branch.
    await waitFor(() => expect(ref.current?.html()).toContain('Hi'));
    act(() => ref.current?.insertInlineImage('asset://second-image'));
    expect(ref.current?.html()).toContain('asset://second-image');
    unmount();
  });

  it('reports the editor as soon as it is created, before any selection change', async () => {
    const onSelectionChange = vi.fn();
    const ref = createRef<BodyEditorHandle>();
    render(
      <BodyEditor
        ref={ref}
        value="<p>Hi</p>"
        onChange={() => {}}
        onSelectionChange={onSelectionChange}
      />,
    );
    await waitFor(() => expect(onSelectionChange).toHaveBeenCalled());
  });

  it('exposes an imperative focus method for focus-on-open behaviour', () => {
    const ref = createRef<BodyEditorHandle>();
    render(<BodyEditor ref={ref} value="<p>Hi</p>" onChange={() => {}} />);
    expect(() => ref.current?.focus()).not.toThrow();
  });
});
