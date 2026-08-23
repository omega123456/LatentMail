import type { Editor } from '@tiptap/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState, type RefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BodyEditor, type BodyEditorHandle } from '@/components/compose/BodyEditor';
import { EditorToolbar } from '@/components/compose/EditorToolbar';

function ComposerHarness({
  bodyRef,
  value = '<p>Hello</p>',
  editorRef,
}: {
  bodyRef: RefObject<BodyEditorHandle | null>;
  value?: string;
  editorRef?: RefObject<Editor | null>;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  return (
    <>
      <BodyEditor
        ref={bodyRef}
        value={value}
        onChange={() => {}}
        onSelectionChange={(next) => {
          setEditor(next ?? null);
          if (editorRef) {
            editorRef.current = next ?? null;
          }
        }}
      />
      <EditorToolbar editor={editor} onLink={() => {}} />
    </>
  );
}

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

  it.each([
    ['Bullet List', '<ul class="list-disc ps-6">'],
    ['Numbered List', '<ol class="list-decimal ps-6">'],
    ['Code Block', '<pre class="my-2.5 overflow-x-auto whitespace-pre rounded-md'],
  ])(
    'renders %s markers on the list node, which preflight would otherwise strip',
    async (label, expectedTag) => {
      const user = userEvent.setup();
      const ref = createRef<BodyEditorHandle>();
      render(<ComposerHarness bodyRef={ref} />);
      await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: label }));
      expect(ref.current?.html()).toContain(expectedTag);
    },
  );

  it('wraps a multi-paragraph selection in one code block, not one per paragraph', async () => {
    const user = userEvent.setup();
    const ref = createRef<BodyEditorHandle>();
    const editorRef = createRef<Editor>();
    render(
      <ComposerHarness bodyRef={ref} editorRef={editorRef} value="<p>first</p><p>second</p>" />,
    );
    await waitFor(() => expect(editorRef.current).not.toBeNull());
    act(() => {
      editorRef.current?.commands.selectAll();
    });
    await user.click(screen.getByRole('button', { name: 'Code Block' }));

    const html = ref.current?.html() ?? '';
    expect(html.match(/<pre/g)).toHaveLength(1);
    expect(html).toContain('first\nsecond');
  });

  it('exposes an imperative focus method for focus-on-open behaviour', () => {
    const ref = createRef<BodyEditorHandle>();
    render(<BodyEditor ref={ref} value="<p>Hi</p>" onChange={() => {}} />);
    expect(() => ref.current?.focus()).not.toThrow();
  });
});
