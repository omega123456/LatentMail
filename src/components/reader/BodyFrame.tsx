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
  const frameCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:${allowRemoteImages ? ' https: http:' : ''}; style-src 'unsafe-inline'; font-src 'self'; form-action 'none'">`;
  const frameFont = `@font-face{font-family:Inter;src:url(${interUrl}) format('woff2');font-weight:100 900;font-display:swap}`;
  const srcDoc = `${frameCsp}<style>${frameFont}body{margin:0;color:${dark ? '#c3c6d7' : '#414755'};font-family:Inter,sans-serif;font-size:16px;line-height:1.625;word-break:break-word}ul,ol{padding-left:24px}li{margin-bottom:8px}li::marker{color:${dark ? '#b4c5ff' : '#0058bc'}}</style>${DOMPurify.sanitize(html, { ADD_TAGS: ['style'], FORCE_BODY: true })}`;
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
      srcDoc={srcDoc}
      onLoad={(event) => {
        const frame = event.currentTarget;
        const document = frame.contentDocument;
        if (!document) return;
        if (!heightConstrained) {
          const measure = () =>
            setHeight(Math.min(document.documentElement.scrollHeight, maxFrameHeight));
          measure();
          new ResizeObserver(measure).observe(document.body);
        }
        document.addEventListener('contextmenu', (menu) => {
          menu.preventDefault();
          const link = (menu.target as Element | null)?.closest('a[href]');
          frame.dataset.contextHref = link?.getAttribute('href') ?? '';
          const bounds = frame.getBoundingClientRect();
          frame.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: bounds.left + menu.clientX,
              clientY: bounds.top + menu.clientY,
            }),
          );
        });
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
