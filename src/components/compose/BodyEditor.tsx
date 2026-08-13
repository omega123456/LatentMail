import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { forwardRef, useImperativeHandle, useState } from 'react';

export type BodyEditorHandle = {
  insertInlineImage: (previewUrl: string) => void;
  html: () => string;
  /** Imperative focus for the composer's focus-on-open behavior (Reply and
   * Reply All land focus in the body rather than To). */
  focus: () => void;
};
type Props = {
  value: string;
  onChange: (html: string) => void;
  onSelectionChange?: (editor: ReturnType<typeof useEditor>) => void;
};

const placeholderText = 'Write your message here…';

export const BodyEditor = forwardRef<BodyEditorHandle, Props>(
  ({ value, onChange, onSelectionChange }, ref) => {
    const [isEmpty, setIsEmpty] = useState(true);
    const editor = useEditor({
      extensions: [
        StarterKit.configure({ link: false, underline: false }),
        Underline,
        Link.configure({ openOnClick: false, autolink: true }),
        Image,
      ],
      content: value,
      onCreate: ({ editor }) => {
        onSelectionChange?.(editor);
        setIsEmpty(editor.isEmpty);
      },
      onUpdate: ({ editor }) => {
        onChange(editor.getHTML());
        setIsEmpty(editor.isEmpty);
      },
      onSelectionUpdate: ({ editor }) => onSelectionChange?.(editor),
    });
    useImperativeHandle(
      ref,
      () => ({
        insertInlineImage: (previewUrl) => {
          editor?.chain().focus().setImage({ src: previewUrl }).run();
        },
        html: () => editor?.getHTML() ?? '',
        focus: () => {
          editor?.commands.focus();
        },
      }),
      [editor],
    );
    return (
      <div className="relative min-h-40 flex-1">
        {isEmpty && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 p-stack-gap-md text-body-md text-outline dark:text-dark-outline"
          >
            {placeholderText}
          </span>
        )}
        <EditorContent
          editor={editor}
          className="min-h-40 p-stack-gap-md text-body-md text-on-surface dark:text-dark-on-surface"
        />
      </div>
    );
  },
);
BodyEditor.displayName = 'BodyEditor';
