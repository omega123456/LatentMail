import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Link as LinkIcon } from 'lucide-react';
import { TextInput } from '@/components/shared/TextInput';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { primaryActionButtonClass, secondaryActionButtonClass } from '@/components/shared/styles';
import { useEscapeCapture } from './useEscapeCapture';

const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const DEFAULT_URL_SCHEME = 'https://';

const applyButtonClass = `${primaryActionButtonClass} disabled:cursor-not-allowed disabled:opacity-40`;

function isParsableUrl(candidate: string): boolean {
  try {
    new URL(candidate);
    return true;
  } catch {
    return false;
  }
}

function toLinkHref(typedUrl: string): string | null {
  const trimmedUrl = typedUrl.trim();
  if (!trimmedUrl) return null;
  const hasScheme = URL_SCHEME_PATTERN.test(trimmedUrl);
  const candidate = hasScheme ? trimmedUrl : `${DEFAULT_URL_SCHEME}${trimmedUrl}`;
  return isParsableUrl(candidate) ? candidate : null;
}

function insertLinkedUrl(editor: Editor, href: string) {
  editor
    .chain()
    .focus()
    .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href: href } }] })
    .unsetMark('link')
    .run();
}

function applyLink(editor: Editor, href: string) {
  if (editor.state.selection.empty) {
    insertLinkedUrl(editor, href);
    return;
  }
  editor.chain().focus().setLink({ href: href }).run();
}

export function LinkDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [typedUrl, setTypedUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const href = toLinkHref(typedUrl);

  const cancel = () => {
    editor.commands.focus();
    onClose();
  };
  useEscapeCapture(true, cancel);
  useEffect(() => inputRef.current?.focus(), []);

  const apply = () => {
    if (!href) return;
    applyLink(editor, href);
    onClose();
  };

  return (
    <form
      aria-label="Insert link"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      className="flex shrink-0 items-center gap-2 border-t border-outline-variant px-stack-gap-md py-2 dark:border-dark-outline-variant"
    >
      <LinkIcon
        aria-hidden="true"
        size={ICON_SIZE.lg}
        className="shrink-0 text-secondary dark:text-dark-secondary"
      />
      <TextInput
        ref={inputRef}
        aria-label="Link URL"
        placeholder="Paste or type a link"
        value={typedUrl}
        onChange={(event) => setTypedUrl(event.target.value)}
        className="min-w-0 flex-1 placeholder:text-outline dark:placeholder:text-dark-outline"
      />
      <button type="button" onClick={cancel} className={secondaryActionButtonClass}>
        Cancel
      </button>
      <button type="submit" disabled={!href} className={applyButtonClass}>
        Apply
      </button>
    </form>
  );
}
