import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { forwardRef, useImperativeHandle, useState } from 'react';

export type BodyEditorHandle = {
  insertInlineImage: (previewUrl: string) => void;
  html: () => string;
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
        StarterKit.configure({
          link: false,
          underline: false,
          bulletList: { HTMLAttributes: { class: 'list-disc ps-6' } },
          orderedList: { HTMLAttributes: { class: 'list-decimal ps-6' } },
        }),
        Underline,
        Link.configure({ openOnClick: false, autolink: true }),
        Image,
      ],
      content: value,
      editorProps: { attributes: { class: 'flex-1 py-3.5 outline-none' } },
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
      <div className="relative flex min-h-40 flex-1 flex-col">
        {isEmpty && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 py-3.5 text-body-md text-outline dark:text-dark-outline"
          >
            {placeholderText}
          </span>
        )}
        <EditorContent
          editor={editor}
          className="flex min-h-40 flex-1 flex-col text-body-md text-on-surface dark:text-dark-on-surface"
        />
      </div>
    );
  },
);
BodyEditor.displayName = 'BodyEditor';
