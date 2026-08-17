import { useState } from 'react';
import type { Editor } from '@tiptap/react';

export function LinkDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const apply = () => {
    if (editor.isActive('link')) editor.chain().focus().unsetLink().run();
    else {
      const normalized = /^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`;
      try {
        new URL(normalized);
        editor.chain().focus().setLink({ href: normalized }).run();
      } catch {
        return;
      }
    }
    onClose();
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <label>
        Link URL
        <input value={url} onChange={(event) => setUrl(event.target.value)} />
      </label>
      <button type="submit" className="cursor-pointer">
        Apply
      </button>
    </form>
  );
}
