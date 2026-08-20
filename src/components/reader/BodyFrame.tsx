import { useState } from 'react';
import DOMPurify from 'dompurify';
import interUrl from '@/assets/inter-latin.woff2?url';
import { invoke } from '@/lib/ipc/commands';

const maxFrameHeight = 1600;

export function BodyFrame({
  html,
  text,
  allowRemoteImages = false,
  heightConstrained = false,
}: {
  html: string | null;
  text: string | null;
  allowRemoteImages?: boolean;
  heightConstrained?: boolean;
}) {
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
  const frameCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:${allowRemoteImages ? ' https: http:' : ''}; style-src 'unsafe-inline'; font-src 'self'">`;
  const frameFont = `@font-face{font-family:Inter;src:url(${interUrl}) format('woff2');font-weight:100 900;font-display:swap}`;
  const srcDoc = `${frameCsp}<style>${frameFont}body{max-width:42rem;margin:0 auto;color:${dark ? '#c3c6d7' : '#414755'};font-family:Inter,sans-serif;font-size:16px;line-height:1.625}ul,ol{padding-left:24px}li{margin-bottom:8px}li::marker{color:${dark ? '#b4c5ff' : '#0058bc'}}</style>${DOMPurify.sanitize(html)}`;
  return (
    <iframe
      aria-label="Message body"
      title="Message body"
      className={
        heightConstrained
          ? 'h-full w-full overflow-auto border-0'
          : 'max-h-body-frame-max w-full overflow-auto border-0'
      }
      height={heightConstrained ? undefined : height}
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      onLoad={(event) => {
        const document = event.currentTarget.contentDocument;
        if (!document) return;
        if (!heightConstrained)
          setHeight(Math.min(document.documentElement.scrollHeight, maxFrameHeight));
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
