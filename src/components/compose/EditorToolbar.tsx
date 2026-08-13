import type { Editor } from '@tiptap/react';
import {
  Bold,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Strikethrough,
  Underline,
} from 'lucide-react';
import type { ComponentType } from 'react';

type Props = { editor: Editor | null; onLink: () => void };

type Control = {
  label: string;
  Icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  run: (editor: Editor) => void;
  isActive: string;
};

const formatControls: Control[] = [
  {
    label: 'Bold',
    Icon: Bold,
    run: (editor) => editor.chain().focus().toggleBold().run(),
    isActive: 'bold',
  },
  {
    label: 'Italic',
    Icon: Italic,
    run: (editor) => editor.chain().focus().toggleItalic().run(),
    isActive: 'italic',
  },
  {
    label: 'Underline',
    Icon: Underline,
    run: (editor) => editor.chain().focus().toggleUnderline().run(),
    isActive: 'underline',
  },
  {
    label: 'Strikethrough',
    Icon: Strikethrough,
    run: (editor) => editor.chain().focus().toggleStrike().run(),
    isActive: 'strike',
  },
];

const listControls: Control[] = [
  {
    label: 'Bullet List',
    Icon: List,
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
    isActive: 'bulletList',
  },
  {
    label: 'Numbered List',
    Icon: ListOrdered,
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
    isActive: 'orderedList',
  },
];

const buttonClass =
  'inline-flex items-center justify-center rounded p-1.5 text-secondary hover:bg-surface-container-high hover:text-on-surface aria-pressed:bg-surface-container-high aria-pressed:text-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container-high dark:hover:text-dark-on-surface dark:aria-pressed:bg-dark-surface-container-high dark:aria-pressed:text-dark-primary';

function ToolbarButton({
  control,
  pressed,
  onClick,
}: {
  control: Pick<Control, 'label' | 'Icon'>;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={control.label}
      title={control.label}
      aria-pressed={pressed}
      onClick={onClick}
      className={buttonClass}
    >
      <control.Icon aria-hidden="true" size={18} />
    </button>
  );
}

/** Formatting controls, in the wireframe's exact order: Bold, Italic,
 * Underline, Strikethrough | Bullet List, Numbered List | Link — 18px
 * lucide glyphs, each carrying both an accessible name and a title, with
 * `aria-pressed` (not colour alone) reflecting toggled state. */
export function EditorToolbar({ editor, onLink }: Props) {
  return (
    <div className="flex items-center" role="toolbar" aria-label="Text formatting">
      {formatControls.map((control) => (
        <ToolbarButton
          key={control.label}
          control={control}
          pressed={editor?.isActive(control.isActive) ?? false}
          onClick={() => editor && control.run(editor)}
        />
      ))}
      <span
        aria-hidden="true"
        className="mx-1 h-5 w-px bg-outline-variant dark:bg-dark-outline-variant"
      />
      {listControls.map((control) => (
        <ToolbarButton
          key={control.label}
          control={control}
          pressed={editor?.isActive(control.isActive) ?? false}
          onClick={() => editor && control.run(editor)}
        />
      ))}
      <span
        aria-hidden="true"
        className="mx-1 h-5 w-px bg-outline-variant dark:bg-dark-outline-variant"
      />
      <ToolbarButton
        control={{ label: 'Link', Icon: LinkIcon }}
        pressed={editor?.isActive('link') ?? false}
        onClick={onLink}
      />
    </div>
  );
}
