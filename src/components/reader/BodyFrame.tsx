import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import interUrl from '@/assets/inter-latin.woff2?url';
import { invoke } from '@/lib/ipc/commands';

const maxFrameHeight = 1600;
const allowedUriSchemes =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|remoteimg):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;
const wiredDocuments = new WeakSet<Document>();

function wireFrame(
  frame: HTMLIFrameElement,
  heightConstrained: boolean,
  setHeight: (value: number) => void,
  loaded: boolean,
) {
  const frameDocument = frame.contentDocument;
  if (!frameDocument?.body) return false;
  if (!loaded && frameDocument.documentElement.scrollHeight === 0) return false;
  if (wiredDocuments.has(frameDocument)) return true;
  wiredDocuments.add(frameDocument);
  if (!heightConstrained) {
    const measure = () =>
      setHeight(Math.min(frameDocument.documentElement.scrollHeight, maxFrameHeight));
    measure();
    new ResizeObserver(measure).observe(frameDocument.body);
  }
  frameDocument.addEventListener('contextmenu', (menu) => {
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
  frameDocument.addEventListener('click', (click) => {
    const link = (click.target as Element | null)?.closest('a[href]');
    if (!link) return;
    click.preventDefault();
    void invoke('open_external_url', { url: link.getAttribute('href') ?? '' });
  });
  return true;
}

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
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let watching = true;
    const tick = () => {
      const frame = frameRef.current;
      if (!watching || !frame?.isConnected) return;
      if (!wireFrame(frame, heightConstrained, setHeight, false)) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      watching = false;
    };
  });
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
  const remoteImageSources = ' remoteimg: http://remoteimg.localhost https: http:';
  const frameCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:${allowRemoteImages ? remoteImageSources : ''}; style-src 'unsafe-inline'; font-src 'self'; form-action 'none'">`;
  const frameFont = `@font-face{font-family:Inter;src:url(${interUrl}) format('woff2');font-weight:100 900;font-display:swap}`;
  const srcDoc = `${frameCsp}<style>${frameFont}body{margin:0;color:${dark ? '#c3c6d7' : '#414755'};font-family:Inter,sans-serif;font-size:16px;line-height:1.625;word-break:break-word}ul,ol{padding-left:24px}li{margin-bottom:8px}li::marker{color:${dark ? '#b4c5ff' : '#0058bc'}}</style>${DOMPurify.sanitize(html, { ADD_TAGS: ['style'], FORCE_BODY: true, ALLOWED_URI_REGEXP: allowedUriSchemes })}`;
  return (
    <iframe
      ref={frameRef}
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
        wireFrame(event.currentTarget, heightConstrained, setHeight, true);
      }}
    />
  );
}
