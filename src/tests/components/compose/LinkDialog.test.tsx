import type { Editor } from '@tiptap/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState, type RefObject } from 'react';
import { expect, it, vi } from 'vitest';
import { BodyEditor } from '@/components/compose/BodyEditor';
import { LinkDialog } from '@/components/compose/LinkDialog';

const STYLED_LINK_CLASS = 'text-primary underline dark:text-dark-primary';
const HELLO_SELECTION = { from: 1, to: 6 };

function LinkHarness({
  value,
  onChange,
  onClose,
  editorRef,
}: {
  value: string;
  onChange: (html: string) => void;
  onClose: () => void;
  editorRef: RefObject<Editor | null>;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const trackEditor = (next: Editor | null) => {
    editorRef.current = next;
    setEditor(next);
  };
  return (
    <>
      <BodyEditor value={value} onChange={onChange} onSelectionChange={trackEditor} />
      {editor && <LinkDialog editor={editor} onClose={onClose} />}
    </>
  );
}

async function renderLinkHarness(value: string) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  const editorRef = createRef<Editor | null>();
  render(
    <LinkHarness value={value} onChange={onChange} onClose={onClose} editorRef={editorRef} />,
  );
  const urlInput = await screen.findByLabelText('Link URL');
  return { onChange: onChange, onClose: onClose, editorRef: editorRef, urlInput: urlInput };
}

it('focuses the URL field on open and keeps Apply disabled until the URL is usable', async () => {
  const user = userEvent.setup();
  const { urlInput } = await renderLinkHarness('<p>Hello world</p>');

  await waitFor(() => expect(urlInput).toHaveFocus());
  const applyButton = screen.getByRole('button', { name: 'Apply' });
  expect(applyButton).toBeDisabled();

  await user.type(urlInput, 'not a url');
  expect(applyButton).toBeDisabled();

  await user.clear(urlInput);
  await user.type(urlInput, 'example.com');
  expect(applyButton).toBeEnabled();
});

it('links the selected text and renders it as a visibly styled link', async () => {
  const user = userEvent.setup();
  const { onChange, onClose, editorRef, urlInput } = await renderLinkHarness(
    '<p>Hello world</p>',
  );
  act(() => editorRef.current?.commands.setTextSelection(HELLO_SELECTION));

  await user.type(urlInput, 'example.com');
  await user.click(screen.getByRole('button', { name: 'Apply' }));

  const link = screen.getByRole('link', { name: 'Hello' });
  expect(link).toHaveAttribute('href', 'https://example.com');
  expect(link).toHaveClass(STYLED_LINK_CLASS);
  expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('href="https://example.com"'));
  expect(onClose).toHaveBeenCalledOnce();
});

it('keeps a typed scheme instead of prefixing https', async () => {
  const user = userEvent.setup();
  const { editorRef, urlInput } = await renderLinkHarness('<p>Hello world</p>');
  act(() => editorRef.current?.commands.setTextSelection(HELLO_SELECTION));

  await user.type(urlInput, 'mailto:elena@example.com');
  await user.click(screen.getByRole('button', { name: 'Apply' }));

  expect(screen.getByRole('link', { name: 'Hello' })).toHaveAttribute(
    'href',
    'mailto:elena@example.com',
  );
});

it('inserts the URL itself as linked text when nothing is selected, without extending the link', async () => {
  const user = userEvent.setup();
  const { editorRef, urlInput } = await renderLinkHarness('<p>See </p>');
  act(() => editorRef.current?.commands.setTextSelection(editorRef.current.state.doc.content.size));

  await user.type(urlInput, 'https://example.com/docs');
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  act(() => editorRef.current?.commands.insertContent(' thanks'));

  expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toHaveAttribute(
    'href',
    'https://example.com/docs',
  );
});

it('cancels without touching the message and hands focus back to the editor', async () => {
  const user = userEvent.setup();
  const { onChange, onClose, urlInput } = await renderLinkHarness('<p>Hello world</p>');

  await user.type(urlInput, 'example.com');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(onClose).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

it('closes on Escape without letting the key reach the surrounding compose dialog', async () => {
  const user = userEvent.setup();
  const onDocumentKeyDown = vi.fn();
  const { onClose, urlInput } = await renderLinkHarness('<p>Hello world</p>');
  document.addEventListener('keydown', onDocumentKeyDown, { capture: true });

  await user.type(urlInput, '{Escape}');

  document.removeEventListener('keydown', onDocumentKeyDown, { capture: true });
  expect(onClose).toHaveBeenCalledOnce();
  expect(onDocumentKeyDown).not.toHaveBeenCalled();
});
