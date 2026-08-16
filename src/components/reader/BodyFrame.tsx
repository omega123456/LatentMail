import { useState } from 'react';
import DOMPurify from 'dompurify';
import { invoke } from '@/lib/ipc/commands';

const maxFrameHeight = 1600;

export function BodyFrame({ html, text }: { html: string | null; text: string | null }) {
  const [height, setHeight] = useState(1);
  if (!html && !text)
    return (
      <p className="text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
        This message has no content.
      </p>
    );
  if (!html)
    return (
      <pre className="select-text whitespace-pre-wrap font-inter text-body-sm text-on-surface dark:text-dark-on-surface">
        {text}
      </pre>
    );
  const dark = document.documentElement.classList.contains('dark');
  const srcDoc = `<style>body{max-width:42rem;margin:0 auto;color:${dark ? '#c3c6d7' : '#414755'};font-family:Inter,sans-serif;font-size:16px;line-height:1.625}ul,ol{padding-left:24px}li{margin-bottom:8px}li::marker{color:${dark ? '#b4c5ff' : '#0058bc'}}</style>${DOMPurify.sanitize(html)}`;
  return (
    <iframe
      aria-label="Message body"
      title="Message body"
      className="max-h-body-frame-max w-full overflow-auto border-0"
      height={height}
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      onLoad={(event) => {
        const document = event.currentTarget.contentDocument;
        if (!document) return;
        setHeight(Math.min(document.documentElement.scrollHeight, maxFrameHeight));
        // The message body is its own document, so neither the app-wide
        // `select-none` nor `tauri-plugin-prevent-default`'s injected script
        // reaches it — the script only runs in the main frame, and this frame
        // has no `allow-scripts` to run anything of its own. Selection is
        // wanted here, the native right-click menu is not, so the parent
        // cancels it from the outside (same-origin makes that reachable).
        document.addEventListener('contextmenu', (menu) => menu.preventDefault());
        document.addEventListener('click', (click) => {
          const link = (click.target as Element | null)?.closest('a[href]');
          if (!link) return;
          click.preventDefault();
          void invoke('open_external_url', { url: link.getAttribute('href') ?? '' });
        });
      }}
    />
  );
}
